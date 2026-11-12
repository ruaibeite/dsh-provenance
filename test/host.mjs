/**
 * Host-half tests for @ruaibeite/dsh-provenance.
 *
 * Plain Node (`node test/host.mjs`), zero dependencies, no Harness process and
 * no browser. Fixtures are inline JSON; every filesystem test uses a fresh
 * `mkdtemp` directory and points `$DSH_HOME` there, so the real user home is
 * never read. The route tests drive `apply(fakeContext)` and call the captured
 * handler directly.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import {
  CACHE_RELATIVE_PATH,
  DECISIONS_RELATIVE_PATH,
  INDEX_VERSION,
  ROUTE,
  aggregate,
  apply,
  buildDecision,
  buildExport,
  buildIndex,
  buildReport,
  collectFromSessionQuery,
  countLines,
  createApiHandler,
  createProvenanceService,
  decodeZstdFrames,
  escapeMarkdownCell,
  extractRecords,
  hash16,
  makeSnippet,
  normalizeSessionList,
  normalizeSessionRead,
  parseIndex,
  parseToolArguments,
  readDecisionsFile,
  renderExportMarkdown,
  resolveDshHome,
  scanZstdFrames,
  toEpochMs,
} from '../index.js'

// Tiny harness (same style as the sibling plugin tests).
let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL -', name)
    console.log(error && error.stack ? error.stack : String(error))
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL -', name)
    console.log(error && error.stack ? error.stack : String(error))
  }
}

const flush = async (rounds = 20) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const tempHomes = []
async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-provenance-'))
  tempHomes.push(home)
  return home
}

// ------------------------------------------------------------ zstd helpers
const frameOf = (chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8'))

// ----------------------------------------------------------- event fixtures
const HEADER = { type: 'session', id: 'session-a', version: 4, createdAt: 1700000000000, cwd: '/work/proj' }

function event(type, seq, time, data) {
  return { type, seq, time, data }
}

function assistant(seq, provider, model) {
  return event('assistant/message', seq, HEADER.createdAt + seq * 1000, {
    message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [] },
  })
}

function writeCall(seq, filePath, content, extra = {}) {
  return event('tool/call', seq, HEADER.createdAt + seq * 1000, {
    name: 'write',
    arguments: JSON.stringify({ path: filePath, content }),
    turn: 1,
    step: seq,
    ...extra,
  })
}

function editCall(seq, filePath, oldString, newString, extra = {}) {
  return event('tool/call', seq, HEADER.createdAt + seq * 1000, {
    name: 'edit',
    arguments: JSON.stringify({ path: filePath, old_string: oldString, new_string: newString }),
    turn: 1,
    step: seq,
    ...extra,
  })
}

// =============================================================== extraction
test('hash16 is the first 16 hex chars of sha256', () => {
  assert.match(hash16('hello'), /^[0-9a-f]{16}$/)
  assert.equal(hash16('hello'), hash16('hello'))
  assert.notEqual(hash16('hello'), hash16('hellp'))
  assert.equal(hash16(''), 'e3b0c44298fc1c14', 'sha256 of the empty string')
  assert.equal(hash16(42), '')
})

test('countLines / makeSnippet handle trailing newlines and long text', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('one'), 1)
  assert.equal(countLines('one\ntwo'), 2)
  assert.equal(countLines('one\ntwo\n'), 2)
  assert.equal(countLines('a\r\nb'), 2)
  assert.equal(makeSnippet('  a\n\nb\tc  '), 'a b c')
  assert.equal(makeSnippet('x'.repeat(400)).length, 300)
})

test('parseToolArguments accepts JSON strings and objects, rejects junk', () => {
  assert.deepEqual(parseToolArguments('{"path":"a"}'), { path: 'a' })
  assert.deepEqual(parseToolArguments({ path: 'b' }), { path: 'b' })
  assert.equal(parseToolArguments('not json'), null)
  assert.equal(parseToolArguments('[]'), null)
  assert.equal(parseToolArguments(''), null)
  assert.equal(parseToolArguments(null), null)
})

test('toEpochMs accepts numbers and date strings', () => {
  assert.equal(toEpochMs(1700000000000), 1700000000000)
  assert.equal(toEpochMs('2026-01-02T03:04:05.000Z'), 1767323045000)
  assert.equal(toEpochMs('nonsense'), 0)
  assert.equal(toEpochMs(undefined), 0)
})

test('extractRecords: write relative + edit old/new + model tracking + seq/time', () => {
  const events = [
    HEADER,
    assistant(1, 'deepseek', 'v4-flash'),
    writeCall(2, 'src/app.js', 'line1\nline2\nline3'),
    editCall(3, 'src/app.js', 'old-a\nold-b', 'new-a\nnew-b\nnew-c'),
    assistant(4, 'qwen', 'qwen-max'),
    editCall(5, '/work/proj/src/b.js', 'x', 'y'),
  ]
  const result = extractRecords(events, HEADER)
  assert.equal(result.noCwd, false)
  assert.equal(result.records.length, 3)
  const [write, edit, absoluteEdit] = result.records
  assert.equal(write.tool, 'write')
  assert.equal(write.path, path.resolve('/work/proj/src/app.js'))
  assert.equal(write.relPath, 'src/app.js')
  assert.equal(write.seq, 2)
  assert.equal(write.time, HEADER.createdAt + 2000)
  assert.equal(write.provider, 'deepseek')
  assert.equal(write.model, 'v4-flash')
  assert.equal(write.linesAdded, 3)
  assert.equal(write.linesRemoved, 0)
  assert.equal(write.beforeHash, null)
  assert.equal(write.afterHash, hash16('line1\nline2\nline3'))
  assert.equal(write.snippet, 'line1 line2 line3')
  assert.equal(write.eventType, 'tool/call')

  assert.equal(edit.tool, 'edit')
  assert.equal(edit.relPath, 'src/app.js')
  assert.equal(edit.linesAdded, 1)
  assert.equal(edit.linesRemoved, 0)
  assert.equal(edit.beforeHash, hash16('old-a\nold-b'))
  assert.equal(edit.afterHash, hash16('new-a\nnew-b\nnew-c'))
  assert.equal(edit.model, 'v4-flash')

  assert.equal(absoluteEdit.relPath, 'src/b.js')
  assert.equal(absoluteEdit.provider, 'qwen')
  assert.equal(absoluteEdit.model, 'qwen-max')
  assert.equal(absoluteEdit.linesRemoved, 0)
})

test('extractRecords: edit with oldText/newText compatibility keys', () => {
  const events = [
    HEADER,
    event('tool/call', 1, HEADER.createdAt + 1000, {
      name: 'edit',
      arguments: JSON.stringify({ path: 'src/compat.js', oldText: 'a\nb\nc\nd', newText: 'a' }),
    }),
  ]
  const result = extractRecords(events, HEADER)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].linesRemoved, 3)
  assert.equal(result.records[0].linesAdded, 0)
  assert.equal(result.records[0].beforeHash, hash16('a\nb\nc\nd'))
  assert.equal(result.records[0].afterHash, hash16('a'))
})

test('extractRecords: absolute paths outside cwd are kept with relPath null', () => {
  const result = extractRecords([HEADER, writeCall(1, '/elsewhere/other.js', 'x')], HEADER)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].path, path.resolve('/elsewhere/other.js'))
  assert.equal(result.records[0].relPath, null)
})

test('extractRecords: ignores untracked tools and skips bad arguments/content', () => {
  const events = [
    HEADER,
    event('tool/call', 1, HEADER.createdAt + 1000, { name: 'read', arguments: '{"path":"a"}' }),
    event('tool/call', 2, HEADER.createdAt + 2000, { name: 'write', arguments: 'not-json' }),
    event('tool/call', 3, HEADER.createdAt + 3000, { name: 'write', arguments: JSON.stringify({ path: 'a.js', content: [1, 2] }) }),
    event('tool/call', 4, HEADER.createdAt + 4000, { name: 'edit', arguments: JSON.stringify({ path: 'a.js' }) }),
    event('tool/call', 5, HEADER.createdAt + 5000, { name: 'write', arguments: JSON.stringify({ content: 'no path' }) }),
    event('tool/call', 6, HEADER.createdAt + 6000, { name: 'write', arguments: JSON.stringify({ path: 'ok.js', content: 'ok' }) }),
  ]
  const result = extractRecords(events, HEADER)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].relPath, 'ok.js')
  assert.equal(result.skipped, 4)
})

test('extractRecords: drops calls whose tool/result reports ok:false', () => {
  const events = [
    HEADER,
    writeCall(1, 'src/fail.js', 'x', { callId: 'call-fail' }),
    writeCall(2, 'src/ok.js', 'y', { callId: 'call-ok' }),
    event('tool/result', 3, HEADER.createdAt + 3000, { ok: false, callId: 'call-fail' }),
    event('tool/result', 4, HEADER.createdAt + 4000, { ok: true, callId: 'call-ok' }),
  ]
  const result = extractRecords(events, HEADER)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].relPath, 'src/ok.js')
})

test('extractRecords: sessions without cwd are reported noCwd and yield nothing', () => {
  const result = extractRecords([writeCall(1, 'a.js', 'x')], { type: 'session', id: 's' })
  assert.equal(result.noCwd, true)
  assert.equal(result.records.length, 0)
})

test('extractRecords: truncates at MAX events and reports it', () => {
  const events = [HEADER, writeCall(1, 'old.js', 'x')]
  for (let index = 0; index < 50010; index += 1) events.push({ type: 'noise', seq: index + 2 })
  events.push(writeCall(60000, 'late.js', 'z'))
  const result = extractRecords(events, HEADER)
  assert.equal(result.truncated, 1)
  assert.equal(result.records.length, 1, 'the oldest write falls outside the kept window')
  assert.equal(result.records[0].relPath, 'late.js')
})

// ======================================================== session discovery
test('normalizeSessionList reads the shipped { header } shape', () => {
  const sessions = normalizeSessionList([
    { header: { id: 'session-1', createdAt: 123, cwd: '/w/a', delegationDepth: 0 }, live: true, persisted: false },
    { header: { id: 'session-2', createdAt: 456, delegationDepth: 2 }, live: false, persisted: true },
    { nope: true },
  ])
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions[0], {
    id: 'session-1',
    createdAt: 123,
    cwd: '/w/a',
    live: true,
    persisted: false,
    delegationDepth: 0,
  })
  assert.equal(sessions[1].id, 'session-2')
  assert.equal(sessions[1].delegationDepth, 2)
  assert.deepEqual(normalizeSessionList(null), [])
})

test('normalizeSessionRead reads the shipped { session, events } shape', () => {
  const read = normalizeSessionRead({
    session: { id: 'session-1', cwd: '/w/a', createdAt: 9 },
    inheritedEventCount: 1,
    events: [HEADER, writeCall(1, 'a.js', 'x')],
  })
  assert.equal(read.header.cwd, '/w/a')
  assert.equal(read.events.length, 2)
  const fromArray = normalizeSessionRead([HEADER, writeCall(1, 'a.js', 'x')])
  assert.equal(fromArray.header.id, 'session-a')
  assert.equal(fromArray.events.length, 2)
  assert.deepEqual(normalizeSessionRead(undefined), { events: [], header: {} })
})

await testAsync('collectFromSessionQuery skips subagents and broken sessions', async () => {
  const calls = []
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'main', createdAt: 200, cwd: '/w/proj', delegationDepth: 0 }, live: false, persisted: true },
        { header: { id: 'sub', createdAt: 300, cwd: '/w/proj', delegationDepth: 1 }, live: false, persisted: true },
        { header: { id: 'broken', createdAt: 100, cwd: '/w/proj', delegationDepth: 0 }, live: false, persisted: true },
      ]
    },
    async readSession(id) {
      calls.push(id)
      if (id === 'broken') throw new Error('boom')
      return {
        session: { id, createdAt: 1000, cwd: '/w/proj' },
        events: [assistant(1, 'deepseek', 'v4-flash'), writeCall(2, 'src/main.js', 'code')],
      }
    },
  }
  const collected = await collectFromSessionQuery(sessionQuery)
  assert.deepEqual(calls.sort(), ['broken', 'main'])
  assert.equal(collected.sessions, 1)
  assert.equal(collected.skipped, 2)
  assert.equal(collected.records.length, 1)
  assert.equal(collected.records[0].sessionId, 'main')
  assert.equal(collected.records[0].model, 'v4-flash')
})

// ============================================================= aggregation
function fixtureRecord(overrides = {}) {
  return {
    sessionId: 's1',
    seq: 1,
    time: 1000,
    provider: 'deepseek',
    model: 'v4-flash',
    tool: 'write',
    cwd: '/w/proj',
    path: '/w/proj/a.js',
    relPath: 'a.js',
    beforeHash: null,
    afterHash: 'abcd',
    linesAdded: 1,
    linesRemoved: 0,
    snippet: 'x',
    eventType: 'tool/call',
    ...overrides,
  }
}

test('aggregate groups by cwd/file, dedupes models, keeps newest and caps', () => {
  const records = [
    fixtureRecord({ seq: 1, time: 1000, model: 'm1' }),
    fixtureRecord({ seq: 2, time: 2000, model: 'm2' }),
    fixtureRecord({ seq: 3, time: 3000, model: 'm1' }),
    fixtureRecord({ seq: 4, time: 4000, cwd: '/w/other', path: '/w/other/b.js', relPath: 'b.js', model: 'm3' }),
  ]
  const result = aggregate(records)
  assert.deepEqual(Object.keys(result.workspaces).sort(), ['/w/other', '/w/proj'])
  assert.equal(result.workspaces['/w/proj'].total, 3)
  assert.equal(result.workspaces['/w/proj'].files['a.js'].count, 3)
  assert.equal(result.workspaces['/w/proj'].files['a.js'].lastAt, 3000)
  assert.deepEqual(result.workspaces['/w/proj'].files['a.js'].models.sort(), ['m1', 'm2'])
  assert.equal(result.stats.records, 4)
  assert.equal(result.stats.files, 2)
  assert.equal(result.stats.workspaces, 2)

  const capped = aggregate(records, { maxPerFile: 2, maxGlobal: 3 })
  assert.equal(capped.workspaces['/w/proj'].files['a.js'].count, 2)
  assert.equal(capped.workspaces['/w/proj'].files['a.js'].records[0].seq, 3)
  assert.ok(capped.stats.truncated >= 1)
})

// ================================================================ index build
await testAsync('buildIndex with a fake sessionQuery writes the index and reuses it', async () => {
  const home = await makeHome()
  let readCalls = 0
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'main', createdAt: 2000, cwd: '/w/proj' }, live: false, persisted: true },
        { header: { id: 'sub', createdAt: 3000, cwd: '/w/proj', delegationDepth: 2 }, live: false, persisted: true },
      ]
    },
    async readSession(id) {
      readCalls += 1
      assert.equal(id, 'main')
      return {
        session: { id, createdAt: 1000, cwd: '/w/proj' },
        events: [assistant(1, 'deepseek', 'v4-flash'), writeCall(2, 'src/app.js', 'a\nb')],
      }
    },
  }

  const first = await buildIndex({ dshHome: home, sessionQuery })
  assert.equal(first.reused, false)
  assert.equal(first.wroteCache, true)
  assert.equal(first.index.version, INDEX_VERSION)
  assert.equal(first.index.stats.sessions, 1)
  assert.equal(first.index.stats.records, 1)
  assert.equal(first.index.stats.skipped, 1, 'the subagent session is skipped')
  assert.equal(first.index.workspaces['/w/proj'].files['src/app.js'].records[0].model, 'v4-flash')
  assert.equal(readCalls, 1)

  const cacheText = await readFile(path.join(home, CACHE_RELATIVE_PATH), 'utf8')
  const cached = JSON.parse(cacheText)
  assert.equal(cached.version, INDEX_VERSION)
  assert.ok(cached.builtAt > 0)
  assert.ok(parseIndex(cached) !== null)

  const second = await buildIndex({ dshHome: home, sessionQuery })
  assert.equal(second.reused, true)
  assert.equal(second.wroteCache, false)
  assert.equal(readCalls, 1, 'a fresh cache must not re-read sessions')

  const forced = await buildIndex({ dshHome: home, sessionQuery, force: true })
  assert.equal(forced.reused, false)
  assert.equal(readCalls, 2)
})

await testAsync('buildIndex falls back to multi-frame zstd session logs without sessionQuery', async () => {
  const home = await makeHome()
  const sessionDir = path.join(home, 'sessions', 'session-fallback')
  await mkdir(sessionDir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id: 'fallback', version: 4, createdAt: 1700, cwd: '/w/logs' }),
    JSON.stringify(event('assistant/message', 1, 1800, { message: { source: { kind: 'model', provider: 'p', model: 'log-model' } } })),
    JSON.stringify(writeCall(2, 'src/log.js', 'from log')),
  ]
  // Two independent frames in one container: only multi-frame decoding sees both.
  const buffer = Buffer.concat([frameOf(lines[0] + '\n' + lines[1] + '\n'), frameOf(lines[2] + '\n')])
  await writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), buffer)

  const result = await buildIndex({ dshHome: home, force: true })
  assert.equal(result.index.stats.sessions, 1)
  assert.equal(result.index.stats.records, 1)
  const file = result.index.workspaces['/w/logs'].files['src/log.js']
  assert.equal(file.records[0].model, 'log-model')
  assert.equal(file.records[0].snippet, 'from log')
  assert.ok(result.wroteCache)
})

await testAsync('buildIndex without sessions or sources yields an empty index', async () => {
  const home = await makeHome()
  const result = await buildIndex({ dshHome: home })
  assert.equal(result.index.stats.records, 0)
  assert.equal(result.index.stats.sessions, 0)
  assert.deepEqual(result.index.workspaces, {})
})

test('zstd helpers decode every frame of a multi-frame container', () => {
  const one = frameOf('{"a":1}\n')
  const two = frameOf('{"b":2}\n')
  const buffer = Buffer.concat([one, two])
  const { frames } = scanZstdFrames(buffer)
  assert.equal(frames.length, 2)
  assert.equal(decodeZstdFrames(buffer), '{"a":1}\n{"b":2}\n')
  assert.throws(() => scanZstdFrames(Buffer.from('not zstd')), /invalid frame magic/)
})

// ============================================================== decisions
test('buildDecision validates input and derives a title', () => {
  const built = buildDecision({ cwd: '/w/proj', relPath: 'a.js', sessionId: 's', seq: 3, note: 'why' }, 1234)
  assert.equal(built.error, undefined)
  assert.match(built.decision.id, /^dec-[0-9a-f]{8}$/)
  assert.equal(built.decision.title, 'a.js · #3')
  assert.equal(built.decision.createdAt, 1234)
  assert.equal(buildDecision({ cwd: '/w' }).error, 'invalid-decision')
  assert.equal(buildDecision(null).error, 'invalid-decision')
})

await testAsync('readDecisionsFile tolerates a missing or corrupt ledger', async () => {
  const home = await makeHome()
  assert.deepEqual(await readDecisionsFile(path.join(home, 'missing.json')), [])
  const corrupt = path.join(home, 'corrupt.json')
  await writeFile(corrupt, '{not json')
  assert.deepEqual(await readDecisionsFile(corrupt), [])
})

await testAsync('service decision ledger add / remove round-trips through disk', async () => {
  const home = await makeHome()
  const service = createProvenanceService({
    dshHome: home,
    sessionQuery: null,
    now: () => 5000,
  })
  const added = await service.addDecision({ cwd: '/w/proj', relPath: 'a.js', sessionId: 's', seq: 2, note: 'note' })
  assert.ok(added.decision && added.decision.id)
  const stored = await readDecisionsFile(path.join(home, DECISIONS_RELATIVE_PATH))
  assert.equal(stored.length, 1)
  assert.equal(stored[0].note, 'note')

  const report = await service.getReport()
  assert.equal(report.decisions.length, 1)

  const removed = await service.removeDecision(added.decision.id)
  assert.equal(removed.removed, true)
  assert.equal((await service.getReport()).decisions.length, 0)
  const missing = await service.removeDecision('dec-nope')
  assert.equal(missing.removed, false)
})

// ======================================================== report / export
function fixtureIndex() {
  const recordA = {
    sessionId: 'session-a',
    seq: 18,
    time: 1700000018000,
    provider: 'deepseek',
    model: 'v4-flash',
    tool: 'edit',
    cwd: '/w/proj',
    path: '/w/proj/src/app.js',
    relPath: 'src/app.js',
    beforeHash: hash16('old'),
    afterHash: hash16('new'),
    linesAdded: 1,
    linesRemoved: 0,
    snippet: 'has | pipe `tick` and newline',
    eventType: 'tool/call',
  }
  return {
    version: INDEX_VERSION,
    builtAt: 1700000100000,
    stats: { sessions: 2, records: 1, files: 1, workspaces: 1, skipped: 0, truncated: 0 },
    workspaces: {
      '/w/proj': {
        files: { 'src/app.js': { records: [recordA], count: 1, lastAt: recordA.time, models: ['v4-flash'] } },
        total: 1,
      },
    },
  }
}

test('renderExportMarkdown escapes table pipes and lists records + decisions', () => {
  const markdown = renderExportMarkdown(fixtureIndex(), {
    now: 1700000200000,
    decisions: [
      {
        id: 'dec-00000001',
        title: 'A | title',
        cwd: '/w/proj',
        relPath: 'src/app.js',
        sessionId: 'session-a',
        seq: 18,
        note: 'why | because',
        createdAt: 1700000150000,
      },
    ],
  })
  assert.match(markdown, /^# Provenance report/m)
  assert.match(markdown, /## Summary/)
  assert.match(markdown, /## Workspace · \/w\/proj|## Workspace · \\\/w/)
  assert.match(markdown, /src\/app\.js/)
  assert.match(markdown, /## Decisions/)
  assert.match(markdown, /A \\\| title/, 'decision title pipes are escaped')
  assert.match(markdown, /why \\\| because/, 'note pipes are escaped')
  assert.doesNotMatch(markdown, /A \| title/)
  assert.ok(escapeMarkdownCell('a|b\nc').includes('\\|'))
})

test('renderExportMarkdown without data still renders a valid skeleton', () => {
  const markdown = renderExportMarkdown(null, { now: 1700000200000 })
  assert.match(markdown, /No provenance records yet/)
  assert.match(markdown, /No pinned decisions yet/)
})

test('buildExport produces .md and parseable .json', () => {
  const decisions = [{ id: 'dec-1', cwd: '/w/proj', relPath: 'src/app.js', sessionId: 's', seq: 18, note: 'n', title: 't', createdAt: 1 }]
  const md = buildExport(fixtureIndex(), { format: 'md', decisions, now: 1700000200000 })
  assert.match(md.filename, /^provenance-.*\.md$/)
  assert.match(md.content, /src\/app\.js/)

  const json = buildExport(fixtureIndex(), { format: 'json', decisions, cwd: '/w/proj', relPath: 'src/app.js', now: 1700000200000 })
  assert.match(json.filename, /^provenance-app\.js-.*\.json$/)
  const parsed = JSON.parse(json.content)
  assert.equal(parsed.decisions.length, 1)
  assert.deepEqual(Object.keys(parsed.workspaces), ['/w/proj'])
  assert.deepEqual(Object.keys(parsed.workspaces['/w/proj'].files), ['src/app.js'])
  assert.equal(buildReport(fixtureIndex()).workspaces[0].files.length, 1)
})

test('parseIndex rejects unknown versions and normalizes entries', () => {
  assert.equal(parseIndex(null), null)
  assert.equal(parseIndex({ version: 99, workspaces: {} }), null)
  const normalized = parseIndex(fixtureIndex())
  assert.equal(normalized.version, INDEX_VERSION)
  assert.equal(normalized.stats.records, 1)
  assert.equal(normalized.workspaces['/w/proj'].files['src/app.js'].count, 1)
})

// ================================================================ route tests
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeRequest(method, url, body) {
  return { method, url, body: body === undefined ? undefined : JSON.stringify(body) }
}

async function call(handler, method, url, body) {
  const response = fakeResponse()
  await handler(fakeRequest(method, url, body), response)
  const parsed = typeof response.body === 'string' ? JSON.parse(response.body) : null
  return { response, parsed }
}

function fakeContext(options = {}) {
  const registrations = []
  const injections = []
  const ctx = {
    __registrations: registrations,
    __injections: injections,
    __warnings: [],
    logger: { warn: (message) => ctx.__warnings.push(message) },
    effect(fn) {
      return fn()
    },
    inject(services, callback) {
      injections.push(services)
      const hostCtx = {
        effect: ctx.effect,
        webServer: options.webServer === false
          ? null
          : {
              register(registration) {
                registrations.push(registration)
                return () => {}
              },
            },
        sessionQuery: options.sessionQuery,
      }
      callback(hostCtx)
    },
  }
  return ctx
}

await testAsync('apply registers the exact route and report works with a session service', async () => {
  const home = await makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sessionQuery = {
      async listSessions() {
        return [{ header: { id: 'main', createdAt: 1000, cwd: '/w/proj' }, live: false, persisted: true }]
      },
      async readSession() {
        return {
          session: { id: 'main', createdAt: 1000, cwd: '/w/proj' },
          events: [assistant(1, 'deepseek', 'v4-flash'), writeCall(2, 'src/app.js', 'hello')],
        }
      },
    }
    const ctx = fakeContext({ sessionQuery })
    apply(ctx)
    assert.deepEqual(ctx.__injections, [['webServer']])
    assert.equal(ctx.__registrations.length, 1)
    assert.equal(ctx.__registrations[0].kind, 'exact')
    assert.equal(ctx.__registrations[0].path, ROUTE)
    const handler = ctx.__registrations[0].handler

    const report = await call(handler, 'GET', `${ROUTE}?action=report`)
    assert.equal(report.response.status, 200)
    assert.equal(report.response.headers['cache-control'], 'no-store')
    assert.equal(report.parsed.ok, true)
    assert.equal(report.parsed.workspaces.length, 1)
    assert.equal(report.parsed.workspaces[0].cwd, '/w/proj')
    assert.equal(report.parsed.workspaces[0].files[0].relPath, 'src/app.js')

    const file = await call(handler, 'GET', `${ROUTE}?action=file&cwd=${encodeURIComponent('/w/proj')}&relPath=src%2Fapp.js`)
    assert.equal(file.response.status, 200)
    assert.equal(file.parsed.file.records.length, 1)
    assert.equal(file.parsed.file.records[0].snippet, 'hello')

    const head = await call(handler, 'HEAD', `${ROUTE}?action=report`)
    assert.equal(head.response.status, 200)
    assert.equal(head.response.body, undefined)

    const md = await call(handler, 'GET', `${ROUTE}?action=export&format=md`)
    assert.equal(md.response.status, 200)
    assert.match(md.parsed.content, /# Provenance report/)
    const json = await call(handler, 'GET', `${ROUTE}?action=export&format=json&cwd=${encodeURIComponent('/w/proj')}&relPath=src%2Fapp.js`)
    assert.equal(json.response.status, 200)
    assert.ok(JSON.parse(json.parsed.content).workspaces['/w/proj'])

    const added = await call(handler, 'POST', ROUTE, {
      action: 'decision-add',
      cwd: '/w/proj',
      relPath: 'src/app.js',
      sessionId: 'main',
      seq: 2,
      note: 'why',
    })
    assert.equal(added.response.status, 200)
    assert.ok(added.parsed.decision.id)
    const reportAfter = await call(handler, 'GET', `${ROUTE}?action=report`)
    assert.equal(reportAfter.parsed.decisions.length, 1)

    const removed = await call(handler, 'POST', ROUTE, { action: 'decision-remove', id: added.parsed.decision.id })
    assert.equal(removed.parsed.removed, true)

    const badJson = fakeResponse()
    await handler({ method: 'POST', url: ROUTE, body: '{oops' }, badJson)
    assert.equal(badJson.status, 400)

    const malformed = await call(handler, 'POST', ROUTE, { action: 'nope' })
    assert.equal(malformed.response.status, 400)
    assert.equal(malformed.parsed.error, 'unknown-action')

    const missingArgs = await call(handler, 'GET', `${ROUTE}?action=file`)
    assert.equal(missingArgs.response.status, 400)
    const notFound = await call(handler, 'GET', `${ROUTE}?action=file&cwd=${encodeURIComponent('/w/proj')}&relPath=nope.js`)
    assert.equal(notFound.response.status, 404)
    const unknownAction = await call(handler, 'GET', `${ROUTE}?action=nope`)
    assert.equal(unknownAction.response.status, 400)
    const wrongMethod = await call(handler, 'PUT', ROUTE)
    assert.equal(wrongMethod.response.status, 405)

    const refreshResponse = await call(handler, 'POST', ROUTE, { action: 'refresh' })
    assert.equal(refreshResponse.response.status, 200)
    assert.equal(refreshResponse.parsed.building, true)
    await flush()
    const afterRefresh = await call(handler, 'GET', `${ROUTE}?action=report`)
    assert.equal(afterRefresh.parsed.building, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

await testAsync('report answers 200 with a note when sessionQuery is unavailable', async () => {
  const home = await makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeContext({ sessionQuery: undefined })
    apply(ctx)
    const handler = ctx.__registrations[0].handler
    const report = await call(handler, 'GET', `${ROUTE}?action=report`)
    assert.equal(report.response.status, 200)
    assert.equal(report.parsed.ok, true)
    assert.deepEqual(report.parsed.workspaces, [])
    assert.equal(report.parsed.stats.records, 0)
    assert.match(report.parsed.note, /session-query-unavailable/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

await testAsync('apply never throws when the web server service is missing', async () => {
  const ctx = fakeContext({ webServer: false })
  apply(ctx)
  assert.equal(ctx.__registrations.length, 0)
  assert.ok(ctx.__warnings.length >= 1)
  await assert.doesNotReject(async () => apply(null))
  await assert.doesNotReject(async () => apply({}))
})

await testAsync('handler isolates internal failures as JSON 500', async () => {
  const service = {
    async getReport() {
      throw new Error('boom')
    },
    async getFile() {
      return null
    },
    async getExport() {
      return { filename: 'x.md', content: '' }
    },
    async refresh() {
      return null
    },
    async addDecision() {
      return { error: 'invalid-decision' }
    },
    async removeDecision() {
      return { removed: false }
    },
  }
  const handler = createApiHandler({ service })
  const response = fakeResponse()
  await handler({ method: 'GET', url: `${ROUTE}?action=report` }, response)
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(response.body).ok, false)
  await assert.doesNotReject(() => handler({ method: 'GET', url: ROUTE }, null))
})

test('resolveDshHome prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/x' }, '/home/u'), path.resolve('/tmp/x'))
  assert.equal(resolveDshHome({}, '/home/u'), path.join('/home/u', '.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }, '/home/u'), path.join('/home/u', '.dsh'))
})

// ---------------------------------------------------------------------------
// Summary + cleanup
// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} failed`)
  for (const failure of failures) {
    console.log(`\nFAILED: ${failure.name}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
} else {
  console.log(`${passed} passed, 0 failed`)
}
for (const home of tempHomes) {
  try {
    await rm(home, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}
if (failures.length > 0) process.exitCode = 1
