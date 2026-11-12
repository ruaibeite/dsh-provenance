/**
 * @ruaibeite/dsh-provenance — host half.
 *
 * Line-level provenance for agent edits. This module ONLY reads the session
 * history exposed by `ctx.sessionQuery` (preferred) or, when that service is
 * unavailable, the local `$DSH_HOME/sessions/**\/session.v4.jsonl.zstd` logs
 * (multi-frame Zstandard, read-only). It folds every `write` / `edit` tool call
 * into a per-workspace / per-file provenance index cached at
 * `$DSH_HOME/cache/provenance/index.json`, keeps a small user-curated decision
 * ledger in `decisions.json` next to it, and serves one JSON route:
 *
 *   GET  /dsh-provenance/api?action=report[&cwd=]
 *   GET  /dsh-provenance/api?action=file&cwd=&relPath=
 *   GET  /dsh-provenance/api?action=export&format=md|json[&cwd=&relPath=]
 *   POST /dsh-provenance/api  {action:'refresh'|'decision-add'|'decision-remove'}
 *
 * Nothing here writes a session, calls a model, runs a subprocess or touches
 * the network. The only writes are the plugin's own cache directory (atomic
 * tmp file + rename). Every route failure is a JSON body; activation never
 * throws.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Route served to the browser half. */
export const ROUTE = '/dsh-provenance/api'

/** Index / decisions schema versions. */
export const INDEX_VERSION = 1
export const DECISIONS_VERSION = 1

/** Cache paths relative to `$DSH_HOME`. */
export const CACHE_RELATIVE_PATH = path.join('cache', 'provenance', 'index.json')
export const DECISIONS_RELATIVE_PATH = path.join('cache', 'provenance', 'decisions.json')

/** Rebuild the index in the background once it is older than this. */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** Provenance is bounded on purpose: newest sessions / calls win. */
export const MAX_SESSIONS = 200
export const MAX_EVENTS_PER_SESSION = 50000
export const MAX_RECORDS_PER_FILE = 200
export const MAX_RECORDS_GLOBAL = 20000
export const MAX_FILES_PER_WORKSPACE = 300
export const MAX_SNIPPET_CHARS = 300

/** Only these tool names are turned into provenance records in v0.1.0. */
export const TRACKED_TOOLS = ['write', 'edit']

/** Zstandard frame magic, little endian (`0xFD2FB528`). */
export const ZSTD_MAGIC = 4247762216

/** Session log file names, compressed first (same convention as the JSONL backend). */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/** Accepted HTTP methods on the plugin route. */
const ROUTE_METHODS = ['GET', 'HEAD', 'POST']

/** Max POST body (decisions are tiny; this is a safety valve). */
const MAX_BODY_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** Coerce an event timestamp (epoch ms, or an ISO/date string) to a number. */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

/**
 * Resolve `$DSH_HOME` (`process.env.DSH_HOME`, else `~/.dsh`).
 *
 * Read lazily at request/build time so tests can point the plugin at a
 * temporary home by setting the environment variable.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const explicit = env !== null && env !== undefined ? env.DSH_HOME : undefined
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  return path.join(home, '.dsh')
}

/** First 16 hex chars of the sha256 of a string (`''` / non-strings → `''`). */
export function hash16(value) {
  if (typeof value !== 'string') return ''
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/** Line count of a text blob; a trailing newline does not count as a line. */
export function countLines(value) {
  if (typeof value !== 'string' || value === '') return 0
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** Single-line snippet of the changed content, capped at {@link MAX_SNIPPET_CHARS}. */
export function makeSnippet(value) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SNIPPET_CHARS ? flat.slice(0, MAX_SNIPPET_CHARS) : flat
}

/** Parse a `tool/call.data.arguments` payload (JSON string or already an object). */
export function parseToolArguments(raw) {
  if (isObject(raw)) return raw
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Pick the first non-empty string among the given keys of an object. */
function pickString(source, keys) {
  if (!isObject(source)) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * Stringify JSON and write it through a unique temporary file + rename, so a
 * reader never observes a half-written cache.
 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/** Read + JSON.parse a file, returning `null` for any failure. */
async function readJsonFile(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Zstandard multi-frame decoding
// ---------------------------------------------------------------------------

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Copied from `@deepseek-ai/dsh-session-persistence-jsonl` via
 * `dsh-usage-stats/index.js` (MIT): Node's `zlib.zstdDecompressSync` decodes
 * only the FIRST frame, while the JSONL backend appends every flush batch as an
 * independent frame to one container file. Invalid structure throws (callers
 * skip the file); EOF inside the final frame returns its `tornStart`.
 *
 * @param buffer - complete file bytes.
 * @param maxFrames - optional complete-frame limit.
 * @returns `{ frames: [{start,end}], tornStart? }`.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('provenance: scanZstdFrames expects a Buffer')
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decompress every complete frame and join the plaintext.
 *
 * @param buffer - complete `.jsonl.zstd` bytes.
 * @returns concatenated UTF-8 JSONL text.
 */
export function decodeZstdFrames(buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = new Array(frames.length)
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    parts[index] = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
  }
  return Buffer.concat(parts).toString('utf8')
}

// ---------------------------------------------------------------------------
// Event → provenance record extraction
// ---------------------------------------------------------------------------

/** Resolve an event's model route: `assistant/message.data.message.source`. */
function modelOfAssistantMessage(event) {
  const data = isObject(event.data) ? event.data : null
  const message = data !== null && isObject(data.message) ? data.message : null
  const source = message !== null && isObject(message.source) ? message.source : null
  if (source === null) return null
  if (source.kind !== undefined && source.kind !== 'model') return null
  const provider = typeof source.provider === 'string' ? source.provider : null
  const model = typeof source.model === 'string' ? source.model : null
  if (provider === null && model === null) return null
  return { provider, model }
}

/** Resolve an event's model route: `model/selection` / route-ish events. */
function modelOfSelection(event) {
  const data = isObject(event.data) ? event.data : null
  if (data === null) return null
  const provider = typeof data.provider === 'string' ? data.provider : null
  const model = typeof data.model === 'string' ? data.model : null
  if (provider === null && model === null) return null
  return { provider, model }
}

/** Relative path under `cwd`, or `null` when the file escapes it. */
function relativeUnder(cwd, absolute) {
  if (typeof cwd !== 'string' || cwd === '' || typeof absolute !== 'string' || absolute === '') return null
  const relative = path.relative(cwd, absolute)
  if (relative === '') return path.basename(absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative
}

/**
 * Extract `write` / `edit` provenance records from one session.
 *
 * Pure and defensive: malformed events, malformed `arguments`, unsupported
 * contents and failed tool results are skipped / filtered instead of throwing.
 * The session header is a plain object (merged metadata + `session` event);
 * `header.cwd` is required, sessions without one are skipped by the caller.
 *
 * @param events - complete event array for one session.
 * @param header - session header / metadata.
 * @param options - `{ sessionId }` override (else `header.id`).
 * @returns `{ records, skipped, truncated, noCwd }`.
 */
export function extractRecords(events, header, options = {}) {
  const list = Array.isArray(events) ? events : []
  const headerObject = isObject(header) ? header : {}
  const rawCwd = pickString(headerObject, ['cwd', 'workingDirectory'])
  const cwd = rawCwd === null ? null : path.resolve(rawCwd)
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== ''
    ? options.sessionId
    : (pickString(headerObject, ['id', 'sessionId']) ?? '')
  if (cwd === null) return { records: [], skipped: 0, truncated: 0, noCwd: true }

  const truncated = list.length > MAX_EVENTS_PER_SESSION
  const window = truncated ? list.slice(list.length - MAX_EVENTS_PER_SESSION) : list
  const skipped = { count: 0 }
  const pending = []
  const failedCallIds = new Set()
  let model = null
  let lastTime = toEpochMs(headerObject.createdAt)
  let lastSeq = 0

  const skip = () => {
    skipped.count += 1
  }

  for (const rawEvent of window) {
    if (!isObject(rawEvent)) {
      skip()
      continue
    }
    const type = typeof rawEvent.type === 'string' ? rawEvent.type : ''
    const time = toEpochMs(rawEvent.time) || lastTime
    const explicitTime = toEpochMs(rawEvent.time)
    if (explicitTime > 0) lastTime = explicitTime
    if (Number.isInteger(rawEvent.seq) && rawEvent.seq >= 0) lastSeq = rawEvent.seq

    if (type === 'assistant/message') {
      const route = modelOfAssistantMessage(rawEvent)
      if (route !== null) model = route
      continue
    }
    if (type === 'model/selection') {
      const route = modelOfSelection(rawEvent)
      if (route !== null) model = route
      continue
    }
    if (type === 'tool/result') {
      const data = isObject(rawEvent.data) ? rawEvent.data : {}
      if (data.ok === false) {
        const callId = pickString(data, ['callId', 'id'])
        if (callId !== null) failedCallIds.add(callId)
      }
      continue
    }
    if (type !== 'tool/call') continue

    const data = isObject(rawEvent.data) ? rawEvent.data : null
    if (data === null) {
      skip()
      continue
    }
    const tool = typeof data.name === 'string' ? data.name : ''
    if (!TRACKED_TOOLS.includes(tool)) continue
    const args = parseToolArguments(data.arguments)
    if (args === null) {
      skip()
      continue
    }
    const rawPath = pickString(args, ['path'])
    if (rawPath === null) {
      skip()
      continue
    }
    const absolute = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(cwd, rawPath)

    let beforeHash = null
    let afterHash = null
    let linesAdded = 0
    let linesRemoved = 0
    let snippetSource = null

    if (tool === 'write') {
      const content = args.content
      if (typeof content !== 'string') {
        // Non-string content (array / object / missing) is not a file body.
        skip()
        continue
      }
      afterHash = hash16(content)
      linesAdded = countLines(content)
      snippetSource = content
    } else {
      const oldText = pickString(args, ['old_string', 'oldText'])
      const newText = pickString(args, ['new_string', 'newText'])
      if (oldText === null && newText === null) {
        skip()
        continue
      }
      const oldLines = countLines(oldText ?? '')
      const newLines = countLines(newText ?? '')
      beforeHash = oldText === null ? null : hash16(oldText)
      afterHash = newText === null ? null : hash16(newText)
      // Signed line delta split into the two non-negative counter fields.
      if (newLines > oldLines) linesAdded = newLines - oldLines
      else if (oldLines > newLines) linesRemoved = oldLines - newLines
      snippetSource = newText ?? oldText
    }

    const seq = Number.isInteger(rawEvent.seq) && rawEvent.seq >= 0 ? rawEvent.seq : lastSeq
    pending.push({
      callId: pickString(data, ['callId', 'id']),
      record: {
        sessionId,
        seq,
        time,
        provider: model === null ? null : model.provider,
        model: model === null ? null : model.model,
        tool,
        cwd,
        path: absolute,
        relPath: relativeUnder(cwd, absolute),
        beforeHash: beforeHash === null ? null : beforeHash,
        afterHash: afterHash === null ? null : afterHash,
        linesAdded,
        linesRemoved,
        snippet: makeSnippet(snippetSource),
        eventType: 'tool/call',
      },
    })
  }

  const records = []
  for (const entry of pending) {
    // A `tool/result` carrying ok:false marks the call as failed; v0.1.0 drops
    // those so the index describes changes that actually landed.
    if (entry.callId !== null && failedCallIds.has(entry.callId)) continue
    records.push(entry.record)
  }
  return { records, skipped: skipped.count, truncated: truncated ? 1 : 0, noCwd: false }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Zeroed index stats. */
export function emptyStats() {
  return { sessions: 0, records: 0, files: 0, workspaces: 0, skipped: 0, truncated: 0 }
}

/** Zeroed index. */
export function emptyIndex(builtAt = 0) {
  return { version: INDEX_VERSION, builtAt: num(builtAt), stats: emptyStats(), workspaces: {} }
}

/**
 * Aggregate a flat record list into `{ workspaces, stats }`.
 *
 * Records are the extraction output; failures / unsupported tools never reach
 * this function. Per-file growth is capped at {@link MAX_RECORDS_PER_FILE}
 * (newest kept) and the whole index at {@link MAX_RECORDS_GLOBAL}.
 *
 * @param records - flat record array.
 * @param options - `{ maxPerFile, maxGlobal }` (tests).
 * @returns `{ workspaces, stats }` with `stats.records/files/workspaces/truncated`.
 */
export function aggregate(records, options = {}) {
  const list = Array.isArray(records) ? records : []
  const maxPerFile = Number.isInteger(options.maxPerFile) ? options.maxPerFile : MAX_RECORDS_PER_FILE
  const maxGlobal = Number.isInteger(options.maxGlobal) ? options.maxGlobal : MAX_RECORDS_GLOBAL

  let kept = list
  let truncated = 0
  if (list.length > maxGlobal) {
    kept = list.slice(list.length - maxGlobal)
    truncated += 1
  }

  const byWorkspace = new Map()
  for (const record of kept) {
    if (!isObject(record)) continue
    const cwd = typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null
    if (cwd === null) continue
    const fileKey = typeof record.relPath === 'string' && record.relPath !== '' ? record.relPath : record.path
    if (typeof fileKey !== 'string' || fileKey === '') continue
    let workspace = byWorkspace.get(cwd)
    if (workspace === undefined) {
      workspace = new Map()
      byWorkspace.set(cwd, workspace)
    }
    let fileRecords = workspace.get(fileKey)
    if (fileRecords === undefined) {
      fileRecords = []
      workspace.set(fileKey, fileRecords)
    }
    fileRecords.push(record)
  }

  const workspaces = {}
  let totalRecords = 0
  let totalFiles = 0
  for (const cwd of [...byWorkspace.keys()].sort()) {
    const files = {}
    let workspaceTotal = 0
    for (const fileKey of [...byWorkspace.get(cwd).keys()].sort()) {
      const fileRecords = byWorkspace.get(cwd).get(fileKey)
      const sorted = fileRecords.slice().sort((left, right) => {
        const delta = num(right.time) - num(left.time)
        return delta !== 0 ? delta : num(right.seq) - num(left.seq)
      })
      const capped = sorted.length > maxPerFile ? sorted.slice(0, maxPerFile) : sorted
      if (sorted.length > maxPerFile) truncated += 1
      const models = []
      const seenModels = new Set()
      let lastAt = 0
      for (const record of capped) {
        lastAt = Math.max(lastAt, num(record.time))
        const label = typeof record.model === 'string' && record.model !== ''
          ? record.model
          : typeof record.provider === 'string' && record.provider !== ''
            ? record.provider
            : 'unknown'
        if (!seenModels.has(label)) {
          seenModels.add(label)
          models.push(label)
        }
      }
      files[fileKey] = { records: capped, count: capped.length, lastAt, models }
      workspaceTotal += capped.length
    }
    workspaces[cwd] = { files, total: workspaceTotal }
    totalRecords += workspaceTotal
    totalFiles += Object.keys(files).length
  }

  return {
    workspaces,
    stats: {
      sessions: 0,
      records: totalRecords,
      files: totalFiles,
      workspaces: Object.keys(workspaces).length,
      skipped: 0,
      truncated,
    },
  }
}

// ---------------------------------------------------------------------------
// Session sources
// ---------------------------------------------------------------------------

/** Normalize `sessionQuery.listSessions()` output to plain session descriptors. */
export function normalizeSessionList(raw) {
  const source = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.sessions)
      ? raw.sessions
      : isObject(raw) && Array.isArray(raw.items)
        ? raw.items
        : []
  const sessions = []
  for (const entry of source) {
    if (!isObject(entry)) continue
    // The shipped shape is `[{ header: { id, createdAt, cwd, delegationDepth }, live, persisted }]`.
    const header = isObject(entry.header) ? entry.header : isObject(entry.session) ? entry.session : {}
    const id = pickString(entry, ['id', 'sessionId']) ?? pickString(header, ['id', 'sessionId'])
    if (id === null) continue
    sessions.push({
      id,
      createdAt: num(entry.createdAt) || num(header.createdAt),
      cwd: pickString(entry, ['cwd', 'workingDirectory']) ?? pickString(header, ['cwd', 'workingDirectory']),
      live: entry.live === true,
      persisted: entry.persisted === true,
      delegationDepth: num(entry.delegationDepth) || num(header.delegationDepth),
    })
  }
  return sessions
}

/** Normalize one `sessionQuery.readSession(id)` result to `{ header, events }`. */
export function normalizeSessionRead(raw) {
  if (Array.isArray(raw)) {
    const events = raw
    const first = events.length > 0 && isObject(events[0]) && events[0].type === 'session' ? events[0] : null
    return { events, header: first === null ? {} : { ...first } }
  }
  if (!isObject(raw)) return { events: [], header: {} }
  const events = Array.isArray(raw.events) ? raw.events : Array.isArray(raw.items) ? raw.items : []
  let header = {}
  if (isObject(raw.header)) header = { ...raw.header }
  else if (isObject(raw.session)) header = { ...raw.session }
  const first = events.length > 0 && isObject(events[0]) && events[0].type === 'session' ? events[0] : null
  // An explicit `session` header is authoritative over a replayed header event.
  if (first !== null) header = { ...first, ...header }
  return { events, header }
}

/** Extract records from a normalized `{ header, events }` session read. */
function extractSessionRead(read, sessionId) {
  const header = isObject(read.header) ? read.header : {}
  const cwdCandidate = pickString(header, ['cwd', 'workingDirectory'])
  if (cwdCandidate === null) return { records: [], skipped: 0, truncated: 0, noCwd: true, scanned: false }
  const depth = num(header.delegationDepth)
  if (depth > 0) return { records: [], skipped: 0, truncated: 0, noCwd: false, subagent: true, scanned: false }
  const result = extractRecords(read.events, header, { sessionId })
  return { ...result, scanned: true }
}

/**
 * Collect records from `ctx.sessionQuery` (preferred source).
 *
 * Newest {@link MAX_SESSIONS} sessions only; sessions with
 * `header.delegationDepth > 0` (subagents) are skipped to keep the ledger
 * readable. One broken session never aborts the scan.
 */
export async function collectFromSessionQuery(sessionQuery, options = {}) {
  const sessions = normalizeSessionList(await sessionQuery.listSessions())
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_SESSIONS)
  const records = []
  const stats = { sessions: 0, skipped: 0, truncated: 0 }
  for (const session of sessions) {
    if (session.delegationDepth > 0) {
      stats.skipped += 1
      continue
    }
    let read
    try {
      read = normalizeSessionRead(await sessionQuery.readSession(session.id))
    } catch {
      stats.skipped += 1
      continue
    }
    // Session metadata fills in what the header event does not carry.
    const header = { ...session, ...read.header }
    const result = extractSessionRead({ header, events: read.events }, session.id)
    if (result.scanned) stats.sessions += 1
    else stats.skipped += 1
    stats.skipped += result.skipped
    stats.truncated += result.truncated
    for (const record of result.records) records.push(record)
  }
  return { records, ...stats }
}

/**
 * Discover session logs under a sessions root, recursively.
 *
 * Mirrors the session-persistence JSONL layout: one directory per session,
 * `session.v4.jsonl.zstd` (or the plaintext fallback) inside. Unreadable
 * directories are skipped; discovery never throws.
 */
export async function discoverSessionLogs(sessionsRoot) {
  const byId = new Map()
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (entry === null || entry === undefined || typeof entry.name !== 'string') continue
      const full = path.join(directory, entry.name)
      if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        await walk(full)
        continue
      }
      const isFile = typeof entry.isFile === 'function' ? entry.isFile() : false
      if (!isFile) continue
      const rank = LOG_NAMES.indexOf(entry.name)
      if (rank === -1) continue
      const id = path.basename(directory)
      const previous = byId.get(id)
      if (previous === undefined || rank < previous.rank) byId.set(id, { id, file: full, rank })
    }
  }
  await walk(sessionsRoot)
  return [...byId.values()]
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .map(({ id, file }) => ({ id, file }))
}

/** Parse a decoded JSONL session log into `{ header, events }`. */
export function parseSessionLog(text) {
  const lines = typeof text === 'string' ? text.split('\n') : []
  const events = []
  let header = {}
  let malformed = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      malformed += 1
      continue
    }
    if (!isObject(event)) {
      malformed += 1
      continue
    }
    if (events.length === 0 && event.type === 'session') header = { ...event }
    events.push(event)
  }
  return { header, events, malformed }
}

/**
 * Collect records by scanning `$DSH_HOME/sessions/**` directly.
 *
 * Fallback used when `ctx.sessionQuery` is unavailable. Logs are ordered by
 * modification time (newest first, {@link MAX_SESSIONS}) because the whole
 * header (cwd, delegationDepth) has to be decoded anyway.
 */
export async function collectFromSessionLogs(options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : resolveDshHome()
  const sessionsRoot = typeof options.sessionsRoot === 'string' && options.sessionsRoot !== ''
    ? options.sessionsRoot
    : path.join(dshHome, 'sessions')
  const logs = await discoverSessionLogs(sessionsRoot)
  const stamped = []
  for (const log of logs) {
    try {
      const info = await stat(log.file)
      stamped.push({ ...log, mtimeMs: num(info.mtimeMs), size: num(info.size) })
    } catch {
      /* unreadable / vanished: skip */
    }
  }
  stamped.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const stats = { sessions: 0, skipped: 0, truncated: 0 }
  const records = []
  for (const log of stamped.slice(0, MAX_SESSIONS)) {
    let text
    try {
      if (log.file.endsWith('.jsonl')) {
        text = await readFile(log.file, 'utf8')
      } else {
        text = decodeZstdFrames(await readFile(log.file))
      }
    } catch {
      stats.skipped += 1
      continue
    }
    const parsed = parseSessionLog(text)
    if (parsed.malformed > 0) stats.skipped += parsed.malformed
    const header = { ...parsed.header }
    if (header.id === undefined) header.id = log.id
    const result = extractSessionRead({ header, events: parsed.events }, log.id)
    if (result.scanned) stats.sessions += 1
    else stats.skipped += 1
    stats.skipped += result.skipped
    stats.truncated += result.truncated
    for (const record of result.records) records.push(record)
  }
  return { records, ...stats }
}

// ---------------------------------------------------------------------------
// Index build / cache
// ---------------------------------------------------------------------------

/** Validate + normalize a parsed index file. Returns `null` for unknown shapes. */
export function parseIndex(value) {
  if (!isObject(value) || value.version !== INDEX_VERSION || !isObject(value.workspaces)) return null
  const workspaces = {}
  for (const cwd of Object.keys(value.workspaces)) {
    const source = value.workspaces[cwd]
    if (!isObject(source) || !isObject(source.files)) continue
    const files = {}
    for (const relPath of Object.keys(source.files)) {
      const file = source.files[relPath]
      if (!isObject(file) || !Array.isArray(file.records)) continue
      const records = file.records.filter((record) => isObject(record))
      files[relPath] = {
        records,
        count: records.length,
        lastAt: num(file.lastAt),
        models: Array.isArray(file.models) ? file.models.filter((model) => typeof model === 'string') : [],
      }
    }
    workspaces[cwd] = { files, total: num(source.total) }
  }
  const rawStats = isObject(value.stats) ? value.stats : {}
  return {
    version: INDEX_VERSION,
    builtAt: num(value.builtAt),
    stats: {
      sessions: num(rawStats.sessions),
      records: num(rawStats.records),
      files: num(rawStats.files),
      workspaces: num(rawStats.workspaces),
      skipped: num(rawStats.skipped),
      truncated: num(rawStats.truncated),
    },
    workspaces,
  }
}

/** Read and validate the index cache; `null` when absent / corrupt / old. */
export async function readIndexFile(cacheFile) {
  return parseIndex(await readJsonFile(cacheFile))
}

/**
 * Build the provenance index.
 *
 * Reads the session history via `sessionQuery` when supplied, else scans the
 * local session logs. When the on-disk cache is fresher than `ttlMs` and
 * `force` is not set, the cache is returned untouched — a rebuild only ever
 * happens on demand or when stale.
 *
 * @param options - `{ dshHome, cacheFile, sessionQuery, force, ttlMs, now }`.
 * @returns `{ index, stats, builtAt, cacheFile, reused, wroteCache, writeError }`.
 */
export async function buildIndex(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : CACHE_TTL_MS
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== ''
    ? options.dshHome
    : resolveDshHome()
  const cacheFile = typeof options.cacheFile === 'string' && options.cacheFile !== ''
    ? options.cacheFile
    : path.join(dshHome, CACHE_RELATIVE_PATH)

  const previous = await readIndexFile(cacheFile)
  const fresh = previous !== null && previous.builtAt > 0 && clock() - previous.builtAt < ttlMs
  if (!options.force && fresh) {
    return {
      index: previous,
      stats: previous.stats,
      builtAt: previous.builtAt,
      cacheFile,
      reused: true,
      wroteCache: false,
      writeError: null,
    }
  }

  const sessionQuery = options.sessionQuery !== null && typeof options.sessionQuery === 'object'
    && typeof options.sessionQuery.listSessions === 'function'
    && typeof options.sessionQuery.readSession === 'function'
    ? options.sessionQuery
    : null
  const collected = sessionQuery !== null
    ? await collectFromSessionQuery(sessionQuery, options)
    : await collectFromSessionLogs({ ...options, dshHome })

  const builtAt = clock()
  const aggregated = aggregate(collected.records)
  const index = {
    version: INDEX_VERSION,
    builtAt,
    stats: {
      sessions: collected.sessions,
      records: aggregated.stats.records,
      files: aggregated.stats.files,
      workspaces: aggregated.stats.workspaces,
      skipped: collected.skipped + aggregated.stats.skipped,
      truncated: collected.truncated + aggregated.stats.truncated,
    },
    workspaces: aggregated.workspaces,
  }

  let wroteCache = false
  let writeError = null
  try {
    await writeJsonAtomic(cacheFile, index)
    wroteCache = true
  } catch (error) {
    writeError = errorMessage(error)
  }
  return { index, stats: index.stats, builtAt, cacheFile, reused: false, wroteCache, writeError }
}

// ---------------------------------------------------------------------------
// Decision ledger
// ---------------------------------------------------------------------------

/** Read the decision ledger; any failure yields an empty list. */
export async function readDecisionsFile(file) {
  const raw = await readJsonFile(file)
  if (!isObject(raw) || !Array.isArray(raw.decisions)) return []
  return raw.decisions.filter((decision) => isObject(decision) && typeof decision.id === 'string')
}

/** Persist the decision ledger atomically. */
export async function writeDecisionsFile(file, decisions) {
  await writeJsonAtomic(file, { version: DECISIONS_VERSION, decisions })
}

/** Generate a stable-looking decision id. */
export function newDecisionId() {
  return `dec-${randomBytes(4).toString('hex')}`
}

/** Validate + normalize a `decision-add` payload. Returns `{ decision }` or `{ error }`. */
export function buildDecision(input, now = Date.now()) {
  if (!isObject(input)) return { error: 'invalid-decision' }
  const cwd = pickString(input, ['cwd'])
  const relPath = pickString(input, ['relPath'])
  if (cwd === null || relPath === null) return { error: 'invalid-decision' }
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const seq = Number.isInteger(input.seq) && input.seq >= 0 ? input.seq : 0
  const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : ''
  const explicitTitle = typeof input.title === 'string' ? input.title.trim() : ''
  const title = explicitTitle !== ''
    ? explicitTitle.slice(0, 200)
    : `${path.basename(relPath)} · #${seq}`
  return {
    decision: {
      id: newDecisionId(),
      cwd: path.resolve(cwd),
      relPath,
      sessionId,
      seq,
      note,
      title,
      createdAt: num(now),
    },
  }
}

// ---------------------------------------------------------------------------
// Report / file / export projections
// ---------------------------------------------------------------------------

/** Sort workspace cwds by their newest record, newest first. */
function workspaceLastAt(workspace) {
  let lastAt = 0
  for (const file of Object.values(workspace.files)) lastAt = Math.max(lastAt, num(file.lastAt))
  return lastAt
}

/**
 * Project the index into the report payload consumed by the page.
 *
 * @param index - normalized index.
 * @param options - `{ cwd, decisions, now, building, lastError }`.
 */
export function buildReport(index, options = {}) {
  const source = index !== null && isObject(index) ? index : emptyIndex()
  const cwdFilter = typeof options.cwd === 'string' && options.cwd !== '' ? path.resolve(options.cwd) : null
  const workspaces = []
  for (const cwd of Object.keys(source.workspaces)) {
    if (cwdFilter !== null && cwd !== cwdFilter) continue
    const workspace = source.workspaces[cwd]
    const files = Object.keys(workspace.files)
      .map((relPath) => ({
        relPath,
        count: num(workspace.files[relPath].count),
        lastAt: num(workspace.files[relPath].lastAt),
        models: Array.isArray(workspace.files[relPath].models) ? workspace.files[relPath].models.slice(0, 8) : [],
      }))
      .sort((left, right) => right.lastAt - left.lastAt)
      .slice(0, MAX_FILES_PER_WORKSPACE)
    workspaces.push({ cwd, total: num(workspace.total), fileCount: Object.keys(workspace.files).length, files })
  }
  workspaces.sort((left, right) => workspaceLastAt(source.workspaces[left.cwd] ?? { files: {} }) - workspaceLastAt(source.workspaces[right.cwd] ?? { files: {} }))
  const stats = isObject(source.stats) ? source.stats : emptyStats()
  return {
    ok: true,
    generatedAt: typeof options.now === 'number' ? options.now : Date.now(),
    builtAt: num(source.builtAt),
    stats,
    workspaces,
    decisions: Array.isArray(options.decisions) ? options.decisions : [],
    building: options.building === true,
    ...(typeof options.note === 'string' && options.note !== '' ? { note: options.note } : {}),
    ...(typeof options.lastError === 'string' && options.lastError !== '' ? { lastError: options.lastError } : {}),
  }
}

/** Look up one file's full record list (newest first). */
export function buildFile(index, cwd, relPath) {
  if (!isObject(index) || typeof cwd !== 'string' || cwd === '' || typeof relPath !== 'string' || relPath === '') return null
  const resolved = path.resolve(cwd)
  const workspace = index.workspaces[resolved]
  if (!isObject(workspace) || !isObject(workspace.files)) return null
  const file = workspace.files[relPath]
  if (!isObject(file)) return null
  return {
    ok: true,
    file: {
      cwd: resolved,
      relPath,
      count: num(file.count),
      lastAt: num(file.lastAt),
      models: Array.isArray(file.models) ? file.models.slice() : [],
      records: Array.isArray(file.records) ? file.records : [],
    },
  }
}

// ---------------------------------------------------------------------------
// Export rendering
// ---------------------------------------------------------------------------

/** Escape one Markdown table cell (`|`, backslashes and newlines). */
export function escapeMarkdownCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** Escape inline-code text (backticks) and collapse whitespace. */
export function escapeInlineCode(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/`/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** `yyyy-mm-dd hh:mm` in local time; `—` for unusable timestamps. */
export function formatTimeAt(ms) {
  const time = num(ms)
  if (time <= 0) return '—'
  try {
    const date = new Date(time)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  } catch {
    return '—'
  }
}

/** File name stamp (`YYYYMMDD-HHMM`). */
function filenameStamp(now) {
  try {
    const date = new Date(num(now) || Date.now())
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  } catch {
    return 'report'
  }
}

/**
 * Render a Markdown provenance / decision report.
 *
 * @param index - normalized index.
 * @param options - `{ cwd, relPath, decisions, now }`; `relPath` selects one
 *   file's records, otherwise every workspace/file is listed with a summary.
 */
export function renderExportMarkdown(index, options = {}) {
  const source = index !== null && isObject(index) ? index : emptyIndex()
  const decisions = Array.isArray(options.decisions) ? options.decisions : []
  const now = num(options.now) || Date.now()
  const cwdFilter = typeof options.cwd === 'string' && options.cwd !== '' ? path.resolve(options.cwd) : null
  const relFilter = typeof options.relPath === 'string' && options.relPath !== '' ? options.relPath : null
  const lines = []

  lines.push('# Provenance report')
  lines.push('')
  lines.push(`Generated: ${formatTimeAt(now)} · Index built: ${formatTimeAt(source.builtAt)}`)
  lines.push('')
  const stats = isObject(source.stats) ? source.stats : emptyStats()
  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Sessions | ${escapeMarkdownCell(stats.sessions)} |`)
  lines.push(`| Records | ${escapeMarkdownCell(stats.records)} |`)
  lines.push(`| Files | ${escapeMarkdownCell(stats.files)} |`)
  lines.push(`| Workspaces | ${escapeMarkdownCell(stats.workspaces)} |`)
  lines.push(`| Skipped | ${escapeMarkdownCell(stats.skipped)} |`)
  lines.push(`| Truncated | ${escapeMarkdownCell(stats.truncated)} |`)
  lines.push('')

  const workspaceKeys = Object.keys(source.workspaces).filter((cwd) => cwdFilter === null || cwd === cwdFilter)
  if (relFilter !== null) {
    const target = cwdFilter !== null ? buildFile(source, cwdFilter, relFilter) : null
    lines.push(`## File · ${escapeInlineCode(relFilter)}`)
    lines.push('')
    if (target === null) {
      lines.push('_No records for this file._')
      lines.push('')
    } else {
      lines.push(`Workspace: \`${escapeInlineCode(target.file.cwd)}\` · ${target.file.count} records · last ${formatTimeAt(target.file.lastAt)}`)
      lines.push('')
      for (const record of target.file.records) {
        lines.push(recordMarkdown(record))
      }
      lines.push('')
    }
  } else if (workspaceKeys.length === 0) {
    lines.push('_No provenance records yet._')
    lines.push('')
  } else {
    for (const cwd of workspaceKeys.sort()) {
      const workspace = source.workspaces[cwd]
      lines.push(`## Workspace · ${escapeInlineCode(cwd)}`)
      lines.push('')
      const fileKeys = Object.keys(workspace.files).sort()
      if (fileKeys.length === 0) {
        lines.push('_No files._')
        lines.push('')
        continue
      }
      lines.push('| File | Records | Models | Last |')
      lines.push('| --- | --- | --- | --- |')
      for (const relPath of fileKeys) {
        const file = workspace.files[relPath]
        lines.push(
          `| ${escapeMarkdownCell(relPath)} | ${escapeMarkdownCell(file.count)} | ${escapeMarkdownCell((file.models ?? []).join(', '))} | ${escapeMarkdownCell(formatTimeAt(file.lastAt))} |`,
        )
      }
      lines.push('')
    }
  }

  lines.push('## Decisions')
  lines.push('')
  if (decisions.length === 0) {
    lines.push('_No pinned decisions yet._')
  } else {
    lines.push('| Title | File | Session | Seq | Created | Note |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const decision of decisions) {
      lines.push(
        `| ${escapeMarkdownCell(decision.title)} | ${escapeMarkdownCell(decision.relPath)} | ${escapeMarkdownCell(decision.sessionId)} | ${escapeMarkdownCell(decision.seq)} | ${escapeMarkdownCell(formatTimeAt(decision.createdAt))} | ${escapeMarkdownCell(decision.note)} |`,
      )
    }
  }
  lines.push('')
  lines.push('---')
  lines.push('Generated locally by @ruaibeite/dsh-provenance. Read-only; nothing was uploaded.')
  lines.push('')
  return lines.join('\n')
}

/** Render one record as a Markdown list item. */
function recordMarkdown(record) {
  const model = typeof record.model === 'string' && record.model !== ''
    ? record.model
    : typeof record.provider === 'string' && record.provider !== ''
      ? record.provider
      : 'unknown'
  const delta = num(record.linesAdded) > 0
    ? `+${num(record.linesAdded)}`
    : num(record.linesRemoved) > 0
      ? `-${num(record.linesRemoved)}`
      : '±0'
  const snippet = escapeInlineCode(record.snippet === undefined ? '' : record.snippet)
  return `- \`#${num(record.seq)}\` · ${formatTimeAt(record.time)} · ${escapeInlineCode(model)} · ${escapeInlineCode(record.tool)} · ${delta} · \`${snippet}\``
}

/**
 * Build the export payload for a `format=md|json` request.
 *
 * @returns `{ filename, content }`.
 */
export function buildExport(index, options = {}) {
  const format = options.format === 'json' ? 'json' : 'md'
  const now = num(options.now) || Date.now()
  const decisions = Array.isArray(options.decisions) ? options.decisions : []
  const source = index !== null && isObject(index) ? index : emptyIndex()
  const relPath = typeof options.relPath === 'string' && options.relPath !== '' ? options.relPath : null
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? path.resolve(options.cwd) : null
  const base = relPath === null
    ? `provenance-${filenameStamp(now)}`
    : `provenance-${path.basename(relPath).replace(/[^a-zA-Z0-9._-]+/g, '-')}-${filenameStamp(now)}`
  if (format === 'json') {
    const payload = {
      version: source.version,
      builtAt: source.builtAt,
      generatedAt: now,
      stats: source.stats,
      workspaces: {},
      decisions,
    }
    for (const workspaceCwd of Object.keys(source.workspaces)) {
      if (cwd !== null && workspaceCwd !== cwd) continue
      const workspace = source.workspaces[workspaceCwd]
      const files = {}
      for (const key of Object.keys(workspace.files)) {
        if (relPath !== null && key !== relPath) continue
        files[key] = workspace.files[key]
      }
      payload.workspaces[workspaceCwd] = { total: workspace.total, files }
    }
    return { filename: `${base}.json`, content: JSON.stringify(payload, null, 2) }
  }
  return {
    filename: `${base}.md`,
    content: renderExportMarkdown(source, { cwd, relPath, decisions, now }),
  }
}

// ---------------------------------------------------------------------------
// Service (index lifecycle + decisions)
// ---------------------------------------------------------------------------

/**
 * Create the stateful service behind the route: lazy index load, 5-minute
 * staleness with a background rebuild, single-flight builds, decision ledger.
 *
 * Injectable for tests (`sessionQuery`, `dshHome`, `cacheFile`, `decisionsFile`,
 * `now`, `ttlMs`).
 */
export function createProvenanceService(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : CACHE_TTL_MS
  const fixedHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : null
  let sessionQuery = options.sessionQuery !== null && typeof options.sessionQuery === 'object' ? options.sessionQuery : null
  const state = {
    index: null,
    builtAt: 0,
    building: false,
    buildPromise: null,
    lastError: null,
    decisions: null,
    decisionsLoading: null,
  }

  const home = () => fixedHome ?? resolveDshHome()
  const cacheFile = () => (typeof options.cacheFile === 'string' && options.cacheFile !== ''
    ? options.cacheFile
    : path.join(home(), CACHE_RELATIVE_PATH))
  const decisionsFile = () => (typeof options.decisionsFile === 'string' && options.decisionsFile !== ''
    ? options.decisionsFile
    : path.join(home(), DECISIONS_RELATIVE_PATH))

  /** Adopt the cached index from disk when it exists and is well-formed. */
  async function hydrate() {
    if (state.index !== null) return state.index
    const disk = await readIndexFile(cacheFile())
    if (disk !== null) {
      state.index = disk
      state.builtAt = disk.builtAt
    }
    return state.index
  }

  /** Start (or join) one rebuild; never throws. */
  function rebuild() {
    if (state.buildPromise !== null) return state.buildPromise
    state.building = true
    state.buildPromise = (async () => {
      try {
        const result = await buildIndex({
          dshHome: home(),
          cacheFile: cacheFile(),
          sessionQuery,
          force: true,
          ttlMs,
          now: clock,
        })
        state.index = result.index
        state.builtAt = result.index.builtAt
        state.lastError = result.writeError === null || result.writeError === undefined ? null : String(result.writeError)
        return result.index
      } catch (error) {
        state.lastError = errorMessage(error)
        return state.index
      } finally {
        state.building = false
        state.buildPromise = null
      }
    })()
    return state.buildPromise
  }

  /**
   * Return the current index, rebuilding on first use (blocking) and on staleness
   * (background — the stale index keeps being served while the rebuild runs).
   */
  async function ensureIndex() {
    if (state.index === null) await hydrate()
    const stale = state.builtAt <= 0 || clock() - state.builtAt > ttlMs
    if (state.index === null) return rebuild()
    if (stale && !state.building) void rebuild()
    return state.index
  }

  /** Load the decision ledger once. */
  async function ensureDecisions() {
    if (state.decisions !== null) return state.decisions
    if (state.decisionsLoading !== null) return state.decisionsLoading
    state.decisionsLoading = (async () => {
      try {
        state.decisions = await readDecisionsFile(decisionsFile())
      } catch {
        state.decisions = []
      }
      return state.decisions
    })().finally(() => {
      state.decisionsLoading = null
    })
    return state.decisionsLoading
  }

  return {
    /** Resolve the DSH home this service reads. */
    dshHome: home,
    /** Attach / refresh the session service handle. */
    setSessionQuery(value) {
      if (value !== null && typeof value === 'object') sessionQuery = value
    },
    /** Test hook: wait for an in-flight rebuild (or resolve immediately). */
    async whenIdle() {
      if (state.buildPromise !== null) await state.buildPromise
      return state.index
    },
    /** Test hook: is a build in flight? */
    isBuilding() {
      return state.building
    },
    /** Normalized current index (may trigger the first build). */
    async getIndex() {
      return ensureIndex()
    },
    /** Full report payload for GET ?action=report. */
    async getReport(cwd) {
      const index = await ensureIndex()
      const decisions = await ensureDecisions()
      const fallbackNote = sessionQuery === null
        ? `session-query-unavailable; scanned session logs at ${path.join(home(), 'sessions')}`
        : undefined
      return buildReport(index, {
        cwd,
        decisions,
        now: clock(),
        building: state.building,
        note: fallbackNote,
        lastError: state.lastError,
      })
    },
    /** One file's records for GET ?action=file. */
    async getFile(cwd, relPath) {
      const index = await ensureIndex()
      return buildFile(index, cwd, relPath)
    },
    /** Export payload for GET ?action=export. */
    async getExport(format, cwd, relPath) {
      const index = await ensureIndex()
      const decisions = await ensureDecisions()
      return buildExport(index, { format, cwd, relPath, decisions, now: clock() })
    },
    /** Force a rebuild (POST refresh); resolves once this build finishes. */
    refresh() {
      return rebuild()
    },
    /** Append one decision; returns the stored entry or an `{ error }` object. */
    async addDecision(input) {
      const built = buildDecision(input, clock())
      if (built.error !== undefined) return { error: built.error }
      const decisions = await ensureDecisions()
      const next = decisions.concat([built.decision])
      decisions.push(built.decision)
      state.decisions = next
      try {
        await writeDecisionsFile(decisionsFile(), next)
      } catch (error) {
        state.decisions = next.filter((decision) => decision.id !== built.decision.id)
        return { error: `write-failed: ${errorMessage(error)}` }
      }
      return { decision: built.decision }
    },
    /** Remove one decision by id; returns whether it existed. */
    async removeDecision(id) {
      if (typeof id !== 'string' || id === '') return { removed: false }
      const decisions = await ensureDecisions()
      const next = decisions.filter((decision) => decision.id !== id)
      const removed = next.length !== decisions.length
      if (!removed) return { removed: false }
      state.decisions = next
      try {
        await writeDecisionsFile(decisionsFile(), next)
      } catch (error) {
        state.decisions = decisions
        return { removed: false, error: `write-failed: ${errorMessage(error)}` }
      }
      return { removed: true }
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

/** Read a JSON POST body (Node IncomingMessage-like async iterable). */
async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  if (request === null || request === undefined) return {}
  if (typeof request.body === 'string' && request.body !== '') {
    if (Buffer.byteLength(request.body, 'utf8') > limit) throw new Error('body-too-large')
    return JSON.parse(request.body)
  }
  if (typeof request[Symbol.asyncIterator] !== 'function') return {}
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Send one JSON response; HEAD gets headers only. Never throws. */
function sendJson(response, status, payload, method) {
  try {
    if (response === null || response === undefined || typeof response.writeHead !== 'function') return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
  } catch {
    /* responding is best-effort; never throw into the web server */
  }
}

/**
 * Create the plugin route handler (GET/HEAD/POST `/dsh-provenance/api`).
 *
 * The handler is total: wrong method → 405, bad JSON → 400, unknown action →
 * 400, unknown file → 404, every internal failure → 500 JSON. It never rejects.
 *
 * @param options - `{ service }` (injectable for tests).
 */
export function createApiHandler(options = {}) {
  const service = options.service !== null && typeof options.service === 'object' && typeof options.service.getReport === 'function'
    ? options.service
    : createProvenanceService(options)

  return async function handleRequest(request, response) {
    let method = 'GET'
    try {
      method = request !== null && request !== undefined && typeof request.method === 'string'
        ? request.method.toUpperCase()
        : 'GET'
      if (!ROUTE_METHODS.includes(method)) {
        try {
          if (response !== null && response !== undefined && typeof response.writeHead === 'function') {
            response.writeHead(405, { allow: ROUTE_METHODS.join(', ') })
            response.end()
          }
        } catch {
          /* ignore */
        }
        return
      }

      if (method === 'POST') {
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          const message = errorMessage(error)
          sendJson(response, message === 'body-too-large' ? 413 : 400, { ok: false, error: 'invalid-json' }, method)
          return
        }
        const action = isObject(body) && typeof body.action === 'string' ? body.action : ''
        if (action === 'refresh') {
          void service.refresh()
          sendJson(response, 200, { ok: true, building: true }, method)
          return
        }
        if (action === 'decision-add') {
          const result = await service.addDecision(body)
          if (result.error !== undefined) {
            sendJson(response, 400, { ok: false, error: result.error }, method)
            return
          }
          sendJson(response, 200, { ok: true, decision: result.decision }, method)
          return
        }
        if (action === 'decision-remove') {
          const result = await service.removeDecision(body.id)
          sendJson(response, 200, { ok: true, removed: result.removed === true }, method)
          return
        }
        sendJson(response, 400, { ok: false, error: 'unknown-action' }, method)
        return
      }

      let url = null
      try {
        const rawUrl = request !== null && request !== undefined && typeof request.url === 'string' ? request.url : ROUTE
        url = new URL(rawUrl, 'http://localhost')
      } catch {
        url = new URL(ROUTE, 'http://localhost')
      }
      const action = url.searchParams.get('action') ?? 'report'
      const cwd = url.searchParams.get('cwd')
      const relPath = url.searchParams.get('relPath')

      if (action === 'report') {
        const report = await service.getReport(cwd)
        sendJson(response, 200, report, method)
        return
      }
      if (action === 'file') {
        if (cwd === null || cwd === '' || relPath === null || relPath === '') {
          sendJson(response, 400, { ok: false, error: 'missing-args' }, method)
          return
        }
        const file = await service.getFile(cwd, relPath)
        if (file === null) {
          sendJson(response, 404, { ok: false, error: 'not-found' }, method)
          return
        }
        sendJson(response, 200, file, method)
        return
      }
      if (action === 'export') {
        const format = url.searchParams.get('format') === 'json' ? 'json' : 'md'
        const exported = await service.getExport(format, cwd, relPath)
        sendJson(response, 200, { ok: true, ...exported }, method)
        return
      }
      sendJson(response, 400, { ok: false, error: 'unknown-action' }, method)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: errorMessage(error) }, method)
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Log a warning through the plugin context without ever letting logging throw. */
function warnContext(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    /* logging must never break activation */
  }
}

/**
 * Register the API route. The web server is the only required service; the
 * session service is picked up lazily at request time (it may mount after us),
 * so a profile without it still answers report/export from the log fallback.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.inject !== 'function') {
      warnContext(ctx, 'provenance: context has no inject service; api route not registered')
      return
    }
    ctx.inject(['webServer'], (hostCtx) => {
      try {
        if (hostCtx === null || hostCtx === undefined || typeof hostCtx.effect !== 'function') {
          warnContext(ctx, 'provenance: host context lacks effect(); api route not registered')
          return
        }
        // The service resolves sessionQuery lazily: a later-mounted service is
        // picked up on the next build, and a missing one falls back to logs.
        // Do not touch undeclared services on the injected context: reading
        // `hostCtx.sessionQuery` throws when the service is not mounted yet and
        // would abort the whole injection callback. Resolve it lazily below.
        const service = createProvenanceService({ sessionQuery: null })
        const resolveSessionQuery = () => {
          try {
            if (isObject(hostCtx.sessionQuery)) {
              service.setSessionQuery(hostCtx.sessionQuery)
              return hostCtx.sessionQuery
            }
            const lazy = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
            if (isObject(lazy)) {
              service.setSessionQuery(lazy)
              return lazy
            }
          } catch {
            /* ignore */
          }
          return null
        }
        const handler = createApiHandler({
          service: {
            ...service,
            getReport(cwd) {
              resolveSessionQuery()
              return service.getReport(cwd)
            },
            getFile(cwd, relPath) {
              resolveSessionQuery()
              return service.getFile(cwd, relPath)
            },
            getExport(format, cwd, relPath) {
              resolveSessionQuery()
              return service.getExport(format, cwd, relPath)
            },
            refresh() {
              resolveSessionQuery()
              return service.refresh()
            },
          },
        })
        hostCtx.effect(() => {
          try {
            if (hostCtx.webServer === null || hostCtx.webServer === undefined) {
              warnContext(ctx, 'provenance: webServer service unavailable; api route not registered')
              return () => {}
            }
            return hostCtx.webServer.register({
              kind: 'exact',
              path: ROUTE,
              handler,
            })
          } catch (error) {
            warnContext(ctx, `provenance: api route registration failed: ${errorMessage(error)}`)
            return () => {}
          }
        }, 'provenance: api route')
      } catch (error) {
        warnContext(ctx, `provenance: api route setup failed: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    warnContext(ctx, `provenance: webServer injection failed: ${errorMessage(error)}`)
  }
}
