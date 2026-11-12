/**
 * Browser-half tests without a browser — dsh-provenance.
 *
 * A tiny React stand-in runs the real `client.js` in a `node:vm` sandbox:
 * hooks keep state between render passes, effects run with dependencies and
 * cleanups, and the page's data functions are injected as props so no network
 * is touched. The tests cover the four states, the workspace → file → record
 * master-detail flow, pinning / removing decisions, export downloads, the
 * building poll, locale parity and the exported pure model surface.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const LOCALE_DIR = path.join(ROOT, 'locale')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

// ---------------------------------------------------------------- harness

function createRuntime() {
  const runtime = { slots: new Map(), currentKey: null, hookCursor: 0, dirty: false, pendingEffects: [], renders: 0 }
  const slotFor = (key) => {
    let slot = runtime.slots.get(key)
    if (slot === undefined) {
      slot = { hooks: [], effects: [] }
      runtime.slots.set(key, slot)
    }
    return slot
  }
  const currentSlot = () => slotFor(runtime.currentKey)

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.hooks[index]) : next
        if (!Object.is(value, slot.hooks[index])) {
          slot.hooks[index] = value
          runtime.dirty = true
        }
      }
      return [slot.hooks[index], setState]
    },
    useEffect(fn, deps) {
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      runtime.pendingEffects.push({ key: runtime.currentKey, index, fn, deps: deps === undefined ? undefined : [...deps] })
    },
    useRef(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = { current: initial }
      return slot.hooks[index]
    },
    useMemo(fn, deps) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      const record = slot.hooks[index]
      const wanted = deps === undefined ? undefined : [...deps]
      if (record !== undefined && sameDeps(record.deps, wanted)) return record.value
      const value = fn()
      slot.hooks[index] = { deps: wanted, value }
      return value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    memo: (component) => component,
    Fragment: 'fragment',
  }

  runtime.React = React
  return runtime
}

function sameDeps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false
  return true
}

function expand(node, runtime, treePath, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, runtime, `${treePath}.${index}`, depth))
  if (depth > 120) throw new Error('render tree too deep')
  const { type, props, children } = node
  if (typeof type === 'function') {
    const key = `${treePath}#${type.name || 'Anonymous'}`
    const previousKey = runtime.currentKey
    const previousCursor = runtime.hookCursor
    runtime.currentKey = key
    runtime.hookCursor = 0
    let output
    try {
      const merged = { ...props }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      output = type(merged)
    } finally {
      runtime.currentKey = previousKey
      runtime.hookCursor = previousCursor
    }
    return expand(output, runtime, treePath, depth + 1)
  }
  const renderedChildren = children.flatMap((child, index) => expand(child, runtime, `${treePath}.${index}`, depth + 1))
  return [{ tag: type, props, children: renderedChildren }]
}

async function commitEffects(runtime) {
  const pending = runtime.pendingEffects
  runtime.pendingEffects = []
  for (const effect of pending) {
    const slot = runtime.slots.get(effect.key)
    const record = slot.effects[effect.index]
    if (record !== undefined && sameDeps(record.deps, effect.deps)) continue
    if (record !== undefined && typeof record.cleanup === 'function') {
      try {
        record.cleanup()
      } catch {
        /* ignore */
      }
    }
    const cleanup = effect.fn()
    slot.effects[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(load, component, props) {
  const { runtime, React } = load
  let tree = null
  const renderPass = () => {
    runtime.dirty = false
    runtime.pendingEffects = []
    runtime.renders += 1
    tree = expand(React.createElement(component, props), runtime, 'r')
  }
  const settle = async () => {
    for (let pass = 0; pass < 40; pass += 1) {
      renderPass()
      await commitEffects(runtime)
      await tick()
      if (!runtime.dirty) return
    }
    throw new Error('component did not settle after 40 passes')
  }
  await settle()
  const unmount = () => {
    for (const slot of runtime.slots.values()) {
      for (const record of slot.effects) {
        if (record !== undefined && typeof record.cleanup === 'function') {
          try {
            record.cleanup()
          } catch {
            /* ignore */
          }
          record.cleanup = undefined
        }
      }
    }
  }
  const view = () => {
    const collected = collect(tree)
    collected.rerender = async () => {
      await settle()
      return view()
    }
    collected.unmount = unmount
    return collected
  }
  return view()
}

function collect(tree) {
  const out = {
    nodes: [],
    text: [],
    joined: '',
    tags: [],
    classes: [],
    data: [],
    labels: [],
    pressed: [],
    buttons: [],
  }
  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        out.text.push(node)
        continue
      }
      const { tag, props, children } = node
      out.nodes.push(node)
      out.tags.push(tag)
      if (typeof props.className === 'string') {
        out.classes.push(props.className)
        for (const cls of props.className.split(/\s+/)) if (cls !== "") out.classes.push(cls)
      }
      for (const key of Object.keys(props)) {
        if (key.startsWith('data-')) out.data.push([key, String(props[key])])
      }
      if (props['aria-label'] !== undefined) out.labels.push(String(props['aria-label']))
      if (props['aria-pressed'] !== undefined) out.pressed.push(String(props['aria-pressed']))
      if (tag === 'style') continue
      walk(children)
    }
  }
  walk(tree)
  out.joined = out.text.join(' ')
  out.dataValue = (key) => {
    const name = key.startsWith('data-') ? key : `data-${key}`
    const hit = out.data.find(([property]) => property === name)
    return hit === undefined ? undefined : hit[1]
  }
  out.dataValues = (key) => {
    const name = key.startsWith('data-') ? key : `data-${key}`
    return out.data.filter(([property]) => property === name).map(([, value]) => value)
  }
  out.textOf = (node) => {
    const parts = []
    const visit = (current) => {
      if (typeof current === 'string') parts.push(current)
      else if (Array.isArray(current)) for (const child of current) visit(child)
      else if (current !== null && typeof current === 'object') visit(current.children)
    }
    visit(node)
    return parts.join('')
  }
  out.byClass = (cls) => out.nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(cls))
  out.byTag = (tag) => out.nodes.filter((node) => node.tag === tag)
  out.byAction = (action) => out.nodes.filter((node) => node.props['data-action'] === action)
  out.byRole = (role) => out.nodes.filter((node) => node.props['data-role'] === role)
  out.contains = (needle) => out.joined.includes(needle)
  out.buttons = out.nodes.filter((node) => node.tag === 'button')
  return out
}

// ---------------------------------------------------------- client loader

function unref(fn) {
  return (...args) => {
    const timer = fn(...args)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  }
}

function loadClient(options = {}) {
  let factory = null
  let moduleId = null
  const fetchCalls = []
  const intervalCalls = []
  const clearedIntervals = []
  const lang = options.lang || 'zh-CN'
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          moduleId = spec.id
          factory = spec.factory
        },
      },
    },
    document: {
      documentElement: { lang },
      baseURI: 'http://127.0.0.1:49269/',
      visibilityState: 'visible',
      createElement() {
        return { click() {}, remove() {}, set href(value) { this._href = value }, set download(value) { this._download = value } }
      },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { language: lang, clipboard: { writeText: async () => {} } },
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init })
      return Promise.reject(new Error('unexpected fetch in render test'))
    },
    setInterval: (fn, ms) => {
      const id = intervalCalls.length + 1
      intervalCalls.push({ id, ms, fn })
      return id
    },
    clearInterval: (id) => clearedIntervals.push(id),
    setTimeout: unref(setTimeout),
    clearTimeout,
    Blob: class Blob {
      constructor(parts, options_) {
        this.parts = parts
        this.type = options_ && options_.type
      }
    },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  if (factory === null) throw new Error('client.js did not register a __ModuleLoader__ factory')
  const runtime = createRuntime()
  const moduleExports = factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`unexpected require: ${name}`)
  })
  return { moduleId, moduleExports, model: moduleExports.__model, runtime, React: runtime.React, fetchCalls, intervalCalls, clearedIntervals, sandbox }
}

/** Load the client and run its apply() against a fake slot/locale context. */
function loadWithContext(options = {}) {
  const load = loadClient(options)
  const slots = []
  const locales = []
  const effects = []
  const localeService = {
    getLocale: () => ({ active: options.activeLocale || 'zh' }),
    getSnapshot: () => ({ active: options.activeLocale || 'zh' }),
    register(namespace, dictionaries) {
      locales.push({ namespace, dictionaries })
      return () => {}
    },
  }
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    locale: localeService,
    slots: {
      inject(name, callback) {
        return callback()
      },
      register(slotOptions, component) {
        slots.push({ slotOptions, component })
        return () => {}
      },
    },
  }
  load.moduleExports.apply(ctx)
  return { load, slots, locales, effects }
}

// -------------------------------------------------------------- fixtures

const CWD = '/work/proj'

function reportFixture(overrides = {}) {
  return {
    ok: true,
    generatedAt: 1700000200000,
    builtAt: 1700000100000,
    stats: { sessions: 2, records: 3, files: 2, workspaces: 1, skipped: 0, truncated: 0 },
    workspaces: [
      {
        cwd: CWD,
        total: 3,
        fileCount: 2,
        files: [
          { relPath: 'src/app.js', count: 2, lastAt: 1700000018000, models: ['deepseek-v4-flash'] },
          { relPath: 'src/other.js', count: 1, lastAt: 1700000010000, models: ['qwen-max'] },
        ],
      },
    ],
    decisions: [],
    building: false,
    ...overrides,
  }
}

function fileFixture() {
  return {
    cwd: CWD,
    relPath: 'src/app.js',
    count: 2,
    lastAt: 1700000018000,
    models: ['deepseek-v4-flash'],
    records: [
        {
          sessionId: 'session-a',
          seq: 18,
          time: 1700000018000,
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          tool: 'edit',
          cwd: CWD,
          path: `${CWD}/src/app.js`,
          relPath: 'src/app.js',
          beforeHash: 'aaaaaaaaaaaaaaaa',
          afterHash: 'bbbbbbbbbbbbbbbb',
          linesAdded: 2,
          linesRemoved: 1,
          snippet: 'const answer = 42;',
        },
        {
          sessionId: 'session-b',
          seq: 4,
          time: 1700000010000,
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          tool: 'write',
          cwd: CWD,
          path: `${CWD}/src/app.js`,
          relPath: 'src/app.js',
          beforeHash: null,
          afterHash: 'cccccccccccccccc',
          linesAdded: 3,
          linesRemoved: 0,
          snippet: 'export function main() {}',
        },
    ],
  }
}

function decisionFixture(overrides = {}) {
  return {
    id: 'dec-12345678',
    cwd: CWD,
    relPath: 'src/app.js',
    sessionId: 'session-a',
    seq: 18,
    note: 'keep this',
    title: 'app.js · #18',
    createdAt: 1700000150000,
    ...overrides,
  }
}

// ---------------------------------------------------------------- tests

let passed = 0
const failures = []
async function test(name, fn) {
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

const baseProps = () => ({
  getLanguage: () => 'zh',
  fetchReport: () => Promise.resolve(reportFixture()),
  fetchFile: () => Promise.resolve(fileFixture()),
  postAction: () => Promise.resolve({ ok: true }),
  fetchExport: () => Promise.resolve({ filename: 'provenance-x.md', content: '# report' }),
  downloadFile: () => true,
})

const findButton = (view, action) => {
  const button = view.byAction(action)[0]
  if (button === undefined) throw new Error(`button ${action} not found`)
  return button
}

// ================================================================= module
await test('module registers the expected id and locale dictionaries', async () => {
  const loaded = loadWithContext()
  assert.equal(loaded.load.moduleId, '@ruaibeite/dsh-provenance')
  const model = loaded.load.model
  assert.deepEqual(model.NS, '@ruaibeite/dsh-provenance')
  assert.deepEqual(Object.keys(model.TEXT.zh).sort(), Object.keys(model.TEXT.en).sort(), 'zh/en dictionaries have identical keys')
  for (const dictionary of [model.TEXT.zh, model.TEXT.en]) {
    assert.equal(typeof dictionary['meta.title'], 'string')
    assert.equal(typeof dictionary['meta.description'], 'string')
  }
  assert.equal(loaded.locales.length, 1)
  assert.equal(loaded.locales[0].namespace, model.NS)
  assert.deepEqual(Object.keys(loaded.locales[0].dictionaries.zh).sort(), Object.keys(model.TEXT.zh).sort())
})

await test('locale JSON files are valid and agree with the client dictionaries', async () => {
  const zh = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'zh.json'), 'utf8'))
  const en = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'en.json'), 'utf8'))
  const flatten = (value, prefix = '') => {
    const keys = []
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) {
        keys.push(...flatten(value[key], prefix === '' ? key : `${prefix}.${key}`))
      }
    } else {
      keys.push(prefix)
    }
    return keys
  }
  assert.deepEqual(flatten(zh), flatten(en), 'locale files have identical key sets')
  assert.equal(typeof zh['meta.title'], 'string')
  assert.equal(typeof en['meta.description'], 'string')
})

await test('client source imports nothing from @deepseek-ai and uses only theme tokens', async () => {
  assert.doesNotMatch(SOURCE, /@deepseek-ai\//)
  assert.doesNotMatch(SOURCE, /^\s*import\s/m, 'client half is loaded by the module loader, not ESM imports')
  const style = /const CSS = `([\s\S]*?)`/.exec(SOURCE)
  assert.ok(style !== null)
  assert.match(style[1], /--dsw-alias-/)
  assert.match(style[1], /\.pv-root/)
  for (const match of style[1].matchAll(/#[0-9a-fA-F]{3,8}/g)) {
    const before = style[1].slice(Math.max(0, match.index - 30), match.index)
    assert.match(before, /var\([^)]*$|,/, `hex color ${match[0]} must be a var() fallback`)
  }
})

await test('apply registers settings.section id provenance, order 5, with locale + icon', async () => {
  const loaded = loadWithContext()
  const section = loaded.slots.find((entry) => entry.slotOptions.name === 'settings.section')
  const icon = loaded.slots.find((entry) => entry.slotOptions.name === 'settings.section.icon')
  assert.ok(section !== undefined, 'settings.section registered')
  assert.equal(section.slotOptions.id, 'provenance')
  assert.equal(section.slotOptions.order, 5)
  assert.equal(section.slotOptions.locale, '@ruaibeite/dsh-provenance')
  assert.equal(typeof section.slotOptions.label, 'function')
  assert.match(section.slotOptions.label(), /溯源/)
  const injected = section.slotOptions.inject()
  for (const key of ['fetchReport', 'fetchFile', 'postAction', 'fetchExport', 'downloadFile', 'getLanguage']) {
    assert.equal(typeof injected[key], 'function', `${key} injected`)
  }
  assert.ok(icon !== undefined, 'settings.section.icon registered')
  assert.equal(icon.slotOptions.id, 'provenance')
})

// ================================================================ states
await test('loading state renders while the report is pending', async () => {
  const loaded = loadClient()
  const props = { ...baseProps(), fetchReport: () => new Promise(() => {}) }
  const view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.equal(view.dataValue('state'), 'loading')
  assert.match(view.joined, /正在读取溯源索引/)
  assert.equal(view.byClass('pv-spinner').length > 0, true)
})

await test('error state renders the failure and retry refetches', async () => {
  const loaded = loadClient()
  let calls = 0
  const props = {
    ...baseProps(),
    fetchReport: () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('network down')) : Promise.resolve(reportFixture())
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.equal(view.dataValue('state'), 'error')
  assert.match(view.joined, /读取溯源信息失败/)
  assert.match(view.joined, /network down/)
  findButton(view, 'retry').props.onClick()
  view = await view.rerender()
  assert.equal(calls, 2)
  assert.equal(view.dataValue('state'), 'populated')
})

await test('empty state renders when there are no records or decisions', async () => {
  const loaded = loadClient()
  const props = {
    ...baseProps(),
    fetchReport: () => Promise.resolve(reportFixture({ stats: { sessions: 0, records: 0, files: 0, workspaces: 0, skipped: 0, truncated: 0 }, workspaces: [] })),
  }
  const view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.equal(view.dataValue('state'), 'empty')
  assert.match(view.joined, /还没有可溯源的改动/)
})

// ============================================================ master-detail
await test('workspace → file → record selection drives the timeline', async () => {
  const loaded = loadClient()
  let fileCalls = 0
  const props = {
    ...baseProps(),
    fetchFile: (cwd, relPath) => {
      fileCalls += 1
      assert.equal(cwd, CWD)
      assert.equal(relPath, 'src/app.js')
      return Promise.resolve(fileFixture())
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.equal(view.dataValue('state'), 'populated')
  assert.equal(view.dataValue('cwd'), CWD)
  assert.equal(view.dataValue('relpath'), '')
  const files = view.byRole('files')[0]
  const fileButton = view.nodes.find((node) => node.props['data-relpath'] === 'src/app.js')
  assert.ok(fileButton !== undefined)
  fileButton.props.onClick()
  view = await view.rerender()
  assert.equal(view.dataValue('relpath'), 'src/app.js')
  assert.equal(fileCalls, 1)
  assert.match(view.joined, /app\.js/)
  const seqs = view.dataValues('seq')
  assert.equal(seqs.length, 2)
  assert.match(view.joined, /const answer = 42;/)
  assert.match(view.joined, /#18/)
  assert.match(view.joined, /deepseek-v4-flash/)
  assert.match(view.joined, /\+2 \/ -1/)
  assert.ok(files !== undefined)
})

// ============================================================== decisions
await test('pinning a record posts decision-add and shows it in the ledger', async () => {
  const loaded = loadClient()
  const actions = []
  const props = {
    ...baseProps(),
    postAction: (body) => {
      actions.push(body)
      if (body.action === 'decision-add') return Promise.resolve({ ok: true, decision: decisionFixture({ note: body.note }) })
      return Promise.resolve({ ok: true })
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  view.nodes.find((node) => node.props['data-relpath'] === 'src/app.js').props.onClick()
  view = await view.rerender()
  findButton(view, 'pin').props.onClick()
  view = await view.rerender()
  const note = view.nodes.find((node) => node.props['data-role'] === 'decision-note')
  assert.ok(note !== undefined, 'note form appears')
  note.props.onChange({ target: { value: 'chosen for clarity' } })
  view = await view.rerender()
  findButton(view, 'decision-confirm').props.onClick()
  view = await view.rerender()
  const added = actions.find((entry) => entry.action === 'decision-add')
  assert.ok(added !== undefined)
  assert.equal(added.cwd, CWD)
  assert.equal(added.relPath, 'src/app.js')
  assert.equal(added.seq, 18)
  assert.equal(added.note, 'chosen for clarity')
  assert.ok(view.dataValues('decision-id').includes('dec-12345678'))
  assert.match(view.joined, /chosen for clarity/)
  assert.match(view.joined, /decision-add-failed|app\.js/)
})

await test('decision-remove posts the id and clears the ledger entry', async () => {
  const loaded = loadClient()
  const actions = []
  const props = {
    ...baseProps(),
    fetchReport: () => Promise.resolve(reportFixture({ decisions: [decisionFixture()] })),
    postAction: (body) => {
      actions.push(body)
      return Promise.resolve({ ok: true, removed: true })
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.match(view.joined, /keep this/)
  findButton(view, 'remove-decision').props.onClick()
  view = await view.rerender()
  assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { action: 'decision-remove', id: 'dec-12345678' })
  assert.doesNotMatch(view.joined, /keep this/)
  assert.match(view.joined, /还没有固定任何决策/)
})

// ================================================================= export
await test('export buttons fetch the rendered file and hand it to the downloader', async () => {
  const loaded = loadClient()
  const exports = []
  const downloads = []
  const props = {
    ...baseProps(),
    fetchExport: (format, cwd, relPath) => {
      exports.push({ format, cwd, relPath })
      return Promise.resolve({ filename: `provenance.${format}`, content: format === 'json' ? '{"ok":true}' : '# report' })
    },
    downloadFile: (filename, content, mime) => {
      downloads.push({ filename, content, mime })
      return true
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  findButton(view, 'export-md').props.onClick()
  view = await view.rerender()
  assert.deepEqual(JSON.parse(JSON.stringify(exports[0])), { format: 'md', cwd: CWD, relPath: '' })
  assert.equal(downloads[0].filename, 'provenance.md')
  assert.equal(downloads[0].content, '# report')
  assert.match(downloads[0].mime, /markdown/)
  assert.match(view.joined, /已下载 provenance\.md/)
  findButton(view, 'export-json').props.onClick()
  view = await view.rerender()
  assert.equal(exports[1].format, 'json')
  assert.match(downloads[1].mime, /json/)
})

// ============================================================ poll / refresh
await test('building report polls every 3s and stops when the rebuild finished', async () => {
  const loaded = loadClient()
  let reports = 0
  const props = {
    ...baseProps(),
    fetchReport: () => {
      reports += 1
      return Promise.resolve(reportFixture({ building: reports === 1 }))
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  assert.equal(view.dataValue('building'), '1')
  assert.equal(loaded.intervalCalls.length, 1)
  assert.equal(loaded.intervalCalls[0].ms, 3000)
  loaded.intervalCalls[0].fn()
  view = await view.rerender()
  assert.equal(reports, 2)
  assert.equal(view.dataValue('building'), '0')
  assert.equal(loaded.clearedIntervals.length, 1)
})

await test('refresh posts action=refresh and marks the page building', async () => {
  const loaded = loadClient()
  const actions = []
  let reports = 0
  const props = {
    ...baseProps(),
    fetchReport: () => {
      reports += 1
      return Promise.resolve(reportFixture({ building: reports > 1 }))
    },
    postAction: (body) => {
      actions.push(body)
      return Promise.resolve({ ok: true, building: true })
    },
  }
  let view = await mount(loaded, loaded.model.ProvenanceSection, props)
  findButton(view, 'refresh').props.onClick()
  view = await view.rerender()
  assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { action: 'refresh' })
  assert.equal(view.dataValue('building'), '1')
  assert.equal(loaded.intervalCalls.length, 1)
})

// ======================================================== pure model surface
await test('pure parsers reject junk and normalize host payloads', async () => {
  const model = loadClient().model
  assert.equal(model.parseReport(null), null)
  assert.equal(model.parseReport({ ok: false }), null)
  const report = model.parseReport(reportFixture())
  assert.equal(report.workspaces[0].cwd, CWD)
  assert.equal(report.workspaces[0].files[0].relPath, 'src/app.js')
  assert.equal(report.stats.records, 3)
  const file = model.parseFile({ ok: true, file: fileFixture() })
  assert.equal(file.records.length, 2)
  assert.equal(file.records[0].tool, 'edit')
  assert.equal(model.parseFile({ ok: true }), null)
  assert.equal(model.shortCwd('/a/b/c'), '…/b/c')
  assert.equal(model.shortCwd('/a'), 'a')
  assert.equal(model.basenameOf('src/deep/app.js'), 'app.js')
  assert.equal(model.modelLabel({ model: 'm' }), 'm')
  assert.equal(model.modelLabel({ provider: 'p' }), 'p')
  assert.equal(model.modelLabel({}), '')
  assert.equal(model.format('{a} {b}', { a: 1 }), '1 {b}')
})

// ---------------------------------------------------------------------------
console.log('')
if (failures.length > 0) {
  console.log(`${passed} passed, ${failures.length} failed`)
  for (const failure of failures) {
    console.log(`\nFAILED: ${failure.name}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exitCode = 1
} else {
  console.log(`${passed} passed, 0 failed`)
}
