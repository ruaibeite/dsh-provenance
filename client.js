/**
 * @ruaibeite/dsh-provenance — browser half.
 *
 * One Settings page: 「溯源 / Provenance」 (id `provenance`, order 5). It is a
 * master-detail browser over the host's local index: workspace → file → the
 * timeline of `write` / `edit` records (which session, model, tool and time
 * touched the file), plus a small user-curated decision ledger and Markdown /
 * JSON export (downloaded by the browser; the host never writes export files).
 *
 * Everything shown is derived from the plugin's own host route
 * (`GET /dsh-provenance/api`), which reads local session history read-only.
 * This half adds no prompt, no tool, no model call and no network request
 * beyond that same-origin route.
 */
window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-provenance',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@ruaibeite/dsh-provenance'

    // ---- tuning ---------------------------------------------------------
    /** Host route serving the report / file / export / decision actions. */
    const ROUTE = '/dsh-provenance/api'
    /** Poll cadence while the host index is rebuilding. */
    const POLL_MS = 3000
    /** Give up auto-polling after this long and ask for a manual refresh. */
    const BUILDING_TIMEOUT_MS = 5 * 60 * 1000
    /** Records requested for one file (host cap is 200). */
    const FILE_RECORD_CAP = 200

    // ---- copy (bundled fallback; the locale service supplies the real one) --
    const TEXT = {
      zh: {
        'meta.title': '溯源',
        'meta.description': 'Agent 代码改动的行级溯源与决策账本：哪次会话、哪个模型、哪个工具写了什么；可按工作区/文件浏览并导出 Markdown/JSON。',
        'nav': '溯源',
        'title': '代码溯源',
        'subtitle': '本机 Agent 对文件的每一次 write / edit，按工作区、文件与时间归档。全程只读，不会修改你的代码。',
        'chip.sessions': '{n} 个会话',
        'chip.records': '{n} 条记录',
        'chip.files': '{n} 个文件',
        'chip.workspaces': '{n} 个工作区',
        'refresh': '刷新',
        'refreshing': '刷新中…',
        'building': '正在重建索引…',
        'buildingTimeout': '重建超时，请手动刷新',
        'builtAt': '索引构建于 {time}',
        'staleError': '上次刷新失败，显示旧索引',
        'fallbackNote': 'sessionQuery 不可用，已回退扫描本机会话日志。',
        'workspace.title': '工作区',
        'workspace.files': '{n} 个文件',
        'workspace.empty': '还没有工作区',
        'file.title': '文件',
        'file.count': '{n} 条',
        'file.empty': '这个工作区还没有记录',
        'file.select': '选择一个文件查看记录',
        'timeline.title': '记录时间线',
        'timeline.empty': '这个文件还没有 write / edit 记录',
        'timeline.hint': '在左侧选择一个文件',
        'timeline.loading': '正在读取记录…',
        'timeline.pin': '固定为决策',
        'timeline.copy': '复制',
        'timeline.copied': '已复制',
        'record.meta': '#{seq} · {time} · {model} · {tool}',
        'record.lines': '+{added} / -{removed}',
        'record.noLines': '±0',
        'record.before': '改前 {hash}',
        'record.after': '改后 {hash}',
        'decision.title': '决策账本',
        'decision.desc': '把关键改动固定为决策条目，导出时一并带上。',
        'decision.empty': '还没有固定任何决策',
        'decision.note': '备注（可选）',
        'decision.notePlaceholder': '为什么要做这个改动？',
        'decision.add': '保存决策',
        'decision.cancel': '取消',
        'decision.remove': '删除',
        'decision.file': '{file} · #{seq}',
        'decision.created': '{time}',
        'decision.error': '决策保存失败：{error}',
        'export.md': '导出 Markdown',
        'export.json': '导出 JSON',
        'export.done': '已下载 {filename}',
        'export.error': '导出失败：{error}',
        'state.loading': '正在读取溯源索引…',
        'state.loadingHint': '首次打开会扫描本机会话历史，之后只读缓存。',
        'state.error': '读取溯源信息失败',
        'state.retry': '重试',
        'state.empty': '还没有可溯源的改动',
        'state.emptyHint': '当 Agent 在本机通过 write / edit 修改文件后，记录会出现在这里。',
        'state.partial': '部分数据不可用',
        'unknown': '未知模型',
        'unknownSession': '未知会话',
      },
      en: {
        'meta.title': 'Provenance',
        'meta.description': 'Line-level provenance and a decision ledger for agent edits: which session, model and tool wrote each change, browsable by workspace and file, with Markdown/JSON export.',
        'nav': 'Provenance',
        'title': 'Provenance',
        'subtitle': 'Every write / edit the agent made on this machine, archived by workspace, file and time. Read-only — your code is never modified.',
        'chip.sessions': '{n} sessions',
        'chip.records': '{n} records',
        'chip.files': '{n} files',
        'chip.workspaces': '{n} workspaces',
        'refresh': 'Refresh',
        'refreshing': 'Refreshing…',
        'building': 'Rebuilding index…',
        'buildingTimeout': 'Rebuild timed out — refresh manually',
        'builtAt': 'Index built {time}',
        'staleError': 'Last refresh failed, showing the previous index',
        'fallbackNote': 'sessionQuery is unavailable; fell back to scanning local session logs.',
        'workspace.title': 'Workspaces',
        'workspace.files': '{n} files',
        'workspace.empty': 'No workspaces yet',
        'file.title': 'Files',
        'file.count': '{n}',
        'file.empty': 'No records in this workspace yet',
        'file.select': 'Pick a file to see its records',
        'timeline.title': 'Record timeline',
        'timeline.empty': 'No write / edit records for this file yet',
        'timeline.hint': 'Pick a file on the left',
        'timeline.loading': 'Loading records…',
        'timeline.pin': 'Pin as decision',
        'timeline.copy': 'Copy',
        'timeline.copied': 'Copied',
        'record.meta': '#{seq} · {time} · {model} · {tool}',
        'record.lines': '+{added} / -{removed}',
        'record.noLines': '±0',
        'record.before': 'before {hash}',
        'record.after': 'after {hash}',
        'decision.title': 'Decision ledger',
        'decision.desc': 'Pin key changes as decisions; exports carry them along.',
        'decision.empty': 'No pinned decisions yet',
        'decision.note': 'Note (optional)',
        'decision.notePlaceholder': 'Why was this change made?',
        'decision.add': 'Save decision',
        'decision.cancel': 'Cancel',
        'decision.remove': 'Remove',
        'decision.file': '{file} · #{seq}',
        'decision.created': '{time}',
        'decision.error': 'Could not save decision: {error}',
        'export.md': 'Export Markdown',
        'export.json': 'Export JSON',
        'export.done': 'Downloaded {filename}',
        'export.error': 'Export failed: {error}',
        'state.loading': 'Reading the provenance index…',
        'state.loadingHint': 'The first open scans local session history; later visits only read the cache.',
        'state.error': 'Could not read provenance data',
        'state.retry': 'Retry',
        'state.empty': 'No provenance records yet',
        'state.emptyHint': 'Records show up here once the agent changes files locally with write / edit.',
        'state.partial': 'Some data is unavailable',
        'unknown': 'unknown model',
        'unknownSession': 'unknown session',
      },
    }

    // ---- small helpers ---------------------------------------------------
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const nonNegative = (value) => Math.max(0, Math.floor(num(value)))

    /** Locale lookup with a bundled fallback table. */
    function textOf(t, zh) {
      const table = zh ? TEXT.zh : TEXT.en
      return (key, params) => {
        let value
        if (typeof t === 'function') {
          try {
            const translated = t(key)
            if (typeof translated === 'string' && translated !== '' && translated !== key) value = translated
          } catch {
            /* locale service unavailable: use bundled copy */
          }
        }
        if (value === undefined) value = table[key]
        if (value === undefined) value = TEXT.en[key]
        if (typeof value !== 'string') return key
        return params === undefined ? value : format(value, params)
      }
    }

    /** Replace `{name}` placeholders in a template. */
    function format(template, params) {
      if (params === null || typeof params !== 'object') return template
      return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
      )
    }

    function isChinese() {
      try {
        const lang = (document.documentElement && document.documentElement.lang) || ''
        const nav = typeof navigator === 'object' && navigator !== null ? navigator.language || '' : ''
        return /^zh/i.test(lang) || /^zh/i.test(nav)
      } catch {
        return false
      }
    }

    /** The active locale id, read from the locale service when available. */
    function activeLanguage(ctx) {
      try {
        const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
        if (locale !== null && locale !== undefined) {
          const snapshot = typeof locale.getLocale === 'function'
            ? locale.getLocale()
            : typeof locale.getSnapshot === 'function'
              ? locale.getSnapshot()
              : null
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string' && snapshot.active !== '') {
            return snapshot.active
          }
        }
      } catch {
        /* fall through */
      }
      return isChinese() ? 'zh' : 'en'
    }

    function pageIsChinese(props) {
      try {
        if (props !== null && props !== undefined && typeof props.getLanguage === 'function') {
          const lang = props.getLanguage()
          if (typeof lang === 'string' && lang !== '') return /^zh/i.test(lang)
        }
      } catch {
        /* fall through */
      }
      return isChinese()
    }

    /** `HH:MM` local clock; `—` for unusable timestamps. */
    function fmtClock(ms) {
      const time = num(ms)
      if (time <= 0) return '—'
      try {
        const date = new Date(time)
        const pad = (value) => String(value).padStart(2, '0')
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`
      } catch {
        return '—'
      }
    }

    /** `MM-DD HH:MM`, or `HH:MM` for today. */
    function fmtTime(ms, now = Date.now()) {
      const time = num(ms)
      if (time <= 0) return '—'
      try {
        const date = new Date(time)
        const today = new Date(now)
        const pad = (value) => String(value).padStart(2, '0')
        const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
        if (
          date.getFullYear() === today.getFullYear()
          && date.getMonth() === today.getMonth()
          && date.getDate() === today.getDate()
        ) return clock
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
      } catch {
        return '—'
      }
    }

    /** Last two path segments of a workspace cwd. */
    function shortCwd(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return ''
      const parts = cwd.split(/[\\/]+/).filter((part) => part !== '')
      if (parts.length <= 2) return parts.join('/')
      return `…/${parts.slice(-2).join('/')}`
    }

    /** Basename of a relative path. */
    function basenameOf(relPath) {
      if (typeof relPath !== 'string' || relPath === '') return ''
      const parts = relPath.split(/[\\/]+/).filter((part) => part !== '')
      return parts.length === 0 ? relPath : parts[parts.length - 1]
    }

    /** Display label for a record's model. */
    function modelLabel(record) {
      if (record === null || typeof record !== 'object') return ''
      if (typeof record.model === 'string' && record.model !== '') return record.model
      if (typeof record.provider === 'string' && record.provider !== '') return record.provider
      return ''
    }

    // ---- data loading ----------------------------------------------------
    function fetchJson(url, init) {
      return fetch(url, init).then((response) => {
        if (response === null || response === undefined || response.ok !== true) {
          throw new Error('HTTP ' + (response === null || response === undefined ? '?' : response.status))
        }
        return response.json()
      })
    }

    /** Fetch the aggregated report (optionally for one workspace). */
    function fetchReport(cwd) {
      const query = typeof cwd === 'string' && cwd !== ''
        ? `?action=report&cwd=${encodeURIComponent(cwd)}`
        : '?action=report'
      return fetchJson(ROUTE + query, { headers: { accept: 'application/json' } }).then((raw) => {
        const report = parseReport(raw)
        if (report === null) throw new Error('invalid provenance report')
        return report
      })
    }

    /** Fetch one file's record timeline. */
    function fetchFile(cwd, relPath) {
      const query = `?action=file&cwd=${encodeURIComponent(cwd)}&relPath=${encodeURIComponent(relPath)}`
      return fetchJson(ROUTE + query, { headers: { accept: 'application/json' } }).then((raw) => {
        const file = parseFile(raw)
        if (file === null) throw new Error('invalid provenance file')
        return file
      })
    }

    /** POST one action (refresh / decision-add / decision-remove). */
    function postAction(body) {
      return fetchJson(ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body === null || typeof body !== 'object' ? {} : body),
      })
    }

    /** Fetch a rendered export and hand back `{ filename, content }`. */
    function fetchExport(format, cwd, relPath) {
      let query = `?action=export&format=${format === 'json' ? 'json' : 'md'}`
      if (typeof cwd === 'string' && cwd !== '') query += `&cwd=${encodeURIComponent(cwd)}`
      if (typeof relPath === 'string' && relPath !== '') query += `&relPath=${encodeURIComponent(relPath)}`
      return fetchJson(ROUTE + query, { headers: { accept: 'application/json' } }).then((raw) => {
        if (raw === null || typeof raw !== 'object' || raw.ok !== true || typeof raw.content !== 'string') {
          throw new Error('invalid export payload')
        }
        return {
          filename: typeof raw.filename === 'string' && raw.filename !== '' ? raw.filename : 'provenance.md',
          content: raw.content,
        }
      })
    }

    /** Trigger a browser download for the exported text. Best-effort. */
    function downloadFile(filename, content, mime) {
      try {
        const blob = new Blob([content], { type: mime })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(anchor)
        anchor.click()
        if (typeof anchor.remove === 'function') anchor.remove()
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url)
          } catch {
            /* ignore */
          }
        }, 2000)
        return true
      } catch {
        return false
      }
    }

    // ---- defensive parsing ----------------------------------------------
    function normDecision(raw) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') return null
      return {
        id: raw.id,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        relPath: typeof raw.relPath === 'string' ? raw.relPath : '',
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        seq: nonNegative(raw.seq),
        note: typeof raw.note === 'string' ? raw.note : '',
        title: typeof raw.title === 'string' ? raw.title : raw.id,
        createdAt: num(raw.createdAt),
      }
    }

    function normFile(raw) {
      if (raw === null || typeof raw !== 'object' || typeof raw.relPath !== 'string') return null
      const models = Array.isArray(raw.models) ? raw.models.filter((model) => typeof model === 'string') : []
      return {
        relPath: raw.relPath,
        count: nonNegative(raw.count),
        lastAt: num(raw.lastAt),
        models,
      }
    }

    function normWorkspace(raw) {
      if (raw === null || typeof raw !== 'object' || typeof raw.cwd !== 'string') return null
      const files = Array.isArray(raw.files) ? raw.files.map(normFile).filter(Boolean) : []
      return { cwd: raw.cwd, total: nonNegative(raw.total), fileCount: nonNegative(raw.fileCount), files }
    }

    function normRecord(raw) {
      if (raw === null || typeof raw !== 'object') return null
      return {
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        seq: nonNegative(raw.seq),
        time: num(raw.time),
        provider: typeof raw.provider === 'string' ? raw.provider : null,
        model: typeof raw.model === 'string' ? raw.model : null,
        tool: raw.tool === 'edit' ? 'edit' : 'write',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        path: typeof raw.path === 'string' ? raw.path : '',
        relPath: typeof raw.relPath === 'string' ? raw.relPath : null,
        beforeHash: typeof raw.beforeHash === 'string' ? raw.beforeHash : null,
        afterHash: typeof raw.afterHash === 'string' ? raw.afterHash : null,
        linesAdded: nonNegative(raw.linesAdded),
        linesRemoved: nonNegative(raw.linesRemoved),
        snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
      }
    }

    function parseReport(raw) {
      if (raw === null || typeof raw !== 'object' || raw.ok !== true) return null
      const stats = raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : {}
      const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map(normWorkspace).filter(Boolean) : []
      const decisions = Array.isArray(raw.decisions) ? raw.decisions.map(normDecision).filter(Boolean) : []
      return {
        generatedAt: num(raw.generatedAt),
        builtAt: num(raw.builtAt),
        stats: {
          sessions: nonNegative(stats.sessions),
          records: nonNegative(stats.records),
          files: nonNegative(stats.files),
          workspaces: nonNegative(stats.workspaces),
          skipped: nonNegative(stats.skipped),
          truncated: nonNegative(stats.truncated),
        },
        workspaces,
        decisions,
        building: raw.building === true,
        lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
        note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : null,
      }
    }

    function parseFile(raw) {
      if (raw === null || typeof raw !== 'object' || raw.ok !== true) return null
      const file = raw.file !== null && typeof raw.file === 'object' ? raw.file : null
      if (file === null || typeof file.relPath !== 'string') return null
      const records = Array.isArray(file.records) ? file.records.map(normRecord).filter(Boolean) : []
      return {
        cwd: typeof file.cwd === 'string' ? file.cwd : '',
        relPath: file.relPath,
        count: nonNegative(file.count),
        lastAt: num(file.lastAt),
        models: Array.isArray(file.models) ? file.models.filter((model) => typeof model === 'string') : [],
        records: records.slice(0, FILE_RECORD_CAP),
      }
    }

    // ---- styles ----------------------------------------------------------
    const CSS = `
.pv-root{display:flex;flex-direction:column;gap:14px;padding:2px 0 20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.pv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pv-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.pv-sub{margin-top:5px;max-width:720px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55}
.pv-chips{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.pv-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pv-btn{appearance:none;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.pv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#00000008)}
.pv-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.pv-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.pv-btn-primary{border-color:var(--dsw-alias-brand-primary,#4176e6);color:var(--dsw-alias-brand-primary,#4176e6)}
.pv-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-link,#4176e6);padding:2px 4px;font-size:11px}
.pv-btn-ghost:hover{text-decoration:underline;background:transparent}
.pv-notice{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.pv-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,#4176e6);border-radius:50%;animation:pv-spin .9s linear infinite}
.pv-stale{color:var(--dsw-alias-state-warn-label,#b45309)}
.pv-grid{display:grid;grid-template-columns:minmax(150px,.85fr) minmax(190px,1.05fr) minmax(280px,1.7fr);gap:12px;align-items:stretch}
.pv-col{display:flex;flex-direction:column;min-width:0;max-height:520px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff));overflow:hidden}
.pv-col-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pv-col-title{margin:0;font-size:12.5px;font-weight:600}
.pv-col-count{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pv-list{display:flex;flex-direction:column;min-height:120px;overflow-y:auto;padding:5px}
.pv-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.pv-item:hover{background:var(--dsw-alias-interactive-bg-hover,#00000008)}
.pv-item-on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform,#fff);box-shadow:var(--dsw-elevation-soft,0 1px 2px #0000000d)}
.pv-item-name{overflow:hidden;width:100%;white-space:nowrap;text-overflow:ellipsis}
.pv-item-meta{display:flex;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pv-badge{display:inline-block;max-width:150px;overflow:hidden;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#00000005);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;vertical-align:middle}
.pv-timeline{display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:9px}
.pv-record{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#00000003)}
.pv-record-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.pv-record-meta{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.pv-record-lines{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-variant-numeric:tabular-nums}
.pv-record-actions{display:flex;align-items:center;gap:6px}
.pv-code{display:block;overflow:hidden;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#00000005);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;word-break:break-word}
.pv-hash{color:var(--dsw-alias-label-tertiary);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pv-note-form{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px}
.pv-note-label{color:var(--dsw-alias-label-secondary);font-size:11px}
.pv-input{width:100%;box-sizing:border-box;resize:vertical;min-height:44px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.pv-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.pv-ledger{display:flex;flex-direction:column;gap:9px;padding:12px 14px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff))}
.pv-ledger-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pv-ledger-title{margin:0;font-size:14px;font-weight:600}
.pv-ledger-desc{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.pv-ledger-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pv-decisions{display:flex;flex-direction:column;gap:6px}
.pv-decision{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.pv-decision:first-child{border-top:none}
.pv-decision-main{flex:1;min-width:0}
.pv-decision-title{font-size:12.5px;font-weight:500;word-break:break-word}
.pv-decision-note{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;word-break:break-word}
.pv-decision-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pv-empty{display:flex;flex-direction:column;align-items:center;gap:5px;padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.pv-empty-hint{max-width:380px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.pv-loading{display:flex;flex-direction:column;align-items:center;gap:8px;padding:38px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.pv-loading-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pv-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:34px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.pv-error-detail{max-width:420px;color:var(--dsw-alias-label-tertiary);font-size:11px;word-break:break-word}
.pv-msg{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pv-icon{display:block}
@keyframes pv-spin{to{transform:rotate(360deg)}}
@media (max-width:900px){.pv-grid{grid-template-columns:1fr}.pv-col{max-height:320px}}
@media (prefers-reduced-motion:reduce){.pv-spinner{animation:none}}
`

    // ---- shared widgets --------------------------------------------------
    /** Sidebar icon: a commit node with a branch line. */
    function ProvenanceIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h(
        'svg',
        { className: 'pv-icon', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', {
          d: 'M6 4v9.5M6 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM18 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM18 8.5v3.2a5 5 0 0 1-5 5H8.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Loading skeleton. */
    function LoadingState(props) {
      const tr = props.tr
      return h(
        'div',
        { className: 'pv-loading' },
        h('span', { className: 'pv-spinner', 'aria-hidden': true }),
        h('div', null, tr('state.loading')),
        h('div', { className: 'pv-loading-hint' }, tr('state.loadingHint')),
      )
    }

    /** Error state with a retry button. */
    function ErrorState(props) {
      const tr = props.tr
      return h(
        'div',
        { className: 'pv-error' },
        h('div', null, tr('state.error')),
        h('div', { className: 'pv-error-detail' }, props.detail || ''),
        h(
          'button',
          { type: 'button', className: 'pv-btn', 'data-action': 'retry', onClick: () => props.onRetry && props.onRetry() },
          tr('state.retry'),
        ),
      )
    }

    /** Empty state. */
    function EmptyState(props) {
      const tr = props.tr
      return h(
        'div',
        { className: 'pv-empty' },
        h('div', null, tr('state.empty')),
        h('div', { className: 'pv-empty-hint' }, tr('state.emptyHint')),
      )
    }

    /** One record card in the timeline. */
    function RecordCard(props) {
      const record = props.record
      const tr = props.tr
      const now = props.now
      const model = modelLabel(record)
      const lines = record.linesAdded > 0 || record.linesRemoved > 0
        ? tr('record.lines', { added: record.linesAdded, removed: record.linesRemoved })
        : tr('record.noLines')
      return h(
        'div',
        { className: 'pv-record', 'data-seq': String(record.seq), 'data-tool': record.tool },
        h(
          'div',
          { className: 'pv-record-head' },
          h(
            'div',
            { className: 'pv-record-meta' },
            tr('record.meta', { seq: record.seq, time: fmtTime(record.time, now), model: model || tr('unknown'), tool: record.tool }),
          ),
          h(
            'div',
            { className: 'pv-record-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'pv-btn-ghost pv-btn',
                'data-action': 'copy',
                onClick: () => {
                  try {
                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                      void navigator.clipboard.writeText(record.snippet)
                    }
                  } catch {
                    /* clipboard unavailable */
                  }
                  if (typeof props.onCopied === 'function') props.onCopied(record)
                },
              },
              tr('timeline.copy'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pv-btn',
                'data-action': 'pin',
                onClick: () => props.onPin && props.onPin(record),
              },
              tr('timeline.pin'),
            ),
          ),
        ),
        h('code', { className: 'pv-code' }, record.snippet || '—'),
        h(
          'div',
          { className: 'pv-record-lines' },
          h('span', null, lines),
          record.beforeHash !== null
            ? h('span', { className: 'pv-hash' }, tr('record.before', { hash: record.beforeHash.slice(0, 8) }))
            : null,
          record.afterHash !== null
            ? h('span', { className: 'pv-hash' }, tr('record.after', { hash: record.afterHash.slice(0, 8) }))
            : null,
        ),
      )
    }

    /** Inline note form shown when a record is being pinned. */
    function DecisionForm(props) {
      const tr = props.tr
      const record = props.record
      return h(
        'div',
        { className: 'pv-note-form', 'data-action': 'decision-form' },
        h('div', { className: 'pv-note-label' }, tr('decision.file', { file: record.relPath || basenameOf(record.path), seq: record.seq })),
        h('div', { className: 'pv-note-label' }, tr('decision.note')),
        h('textarea', {
          className: 'pv-input',
          'data-role': 'decision-note',
          placeholder: tr('decision.notePlaceholder'),
          value: props.value,
          onChange: (event) => {
            const value = event !== null && event !== undefined && event.target ? event.target.value : ''
            if (typeof props.onChange === 'function') props.onChange(String(value))
          },
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(
            'button',
            { type: 'button', className: 'pv-btn pv-btn-primary', 'data-action': 'decision-confirm', onClick: () => props.onConfirm && props.onConfirm() },
            tr('decision.add'),
          ),
          h(
            'button',
            { type: 'button', className: 'pv-btn', 'data-action': 'decision-cancel', onClick: () => props.onCancel && props.onCancel() },
            tr('decision.cancel'),
          ),
        ),
      )
    }

    /** The whole Provenance page mounted in the `settings.section` slot. */
    function ProvenanceSection(props) {
      const zh = pageIsChinese(props)
      const tr = textOf(props.t, zh)
      const loadReport = typeof props.fetchReport === 'function' ? props.fetchReport : fetchReport
      const loadFile = typeof props.fetchFile === 'function' ? props.fetchFile : fetchFile
      const sendAction = typeof props.postAction === 'function' ? props.postAction : postAction
      const loadExport = typeof props.fetchExport === 'function' ? props.fetchExport : fetchExport
      const saveDownload = typeof props.downloadFile === 'function' ? props.downloadFile : downloadFile

      const [report, setReport] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(true)
      const [cwd, setCwd] = React.useState('')
      const [relPath, setRelPath] = React.useState('')
      const [file, setFile] = React.useState(null)
      const [fileBusy, setFileBusy] = React.useState(false)
      const [fileError, setFileError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [pending, setPending] = React.useState(null)
      const [noteDraft, setNoteDraft] = React.useState('')
      const [timedOut, setTimedOut] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const pollSince = React.useRef(0)

      // Report: initial load + every manual / poll refresh.
      React.useEffect(() => {
        let alive = true
        if (report === null) setBusy(true)
        loadReport()
          .then((next) => {
            if (!alive) return
            setReport(next)
            setError(null)
            setBusy(false)
            if (next.building !== true) {
              setTimedOut(false)
              pollSince.current = 0
            }
          })
          .catch((failure) => {
            if (!alive) return
            setError(failure && failure.message ? failure.message : String(failure))
            setBusy(false)
          })
        return () => {
          alive = false
        }
      }, [tick])

      // While the host rebuilds, poll until it reports `building: false`.
      const building = report !== null && report.building === true
      React.useEffect(() => {
        if (!building || timedOut) return undefined
        if (pollSince.current === 0) pollSince.current = Date.now()
        const timer = setInterval(() => {
          if (Date.now() - pollSince.current > BUILDING_TIMEOUT_MS) {
            setTimedOut(true)
            return
          }
          setTick((value) => value + 1)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [building, timedOut])

      // Keep the workspace selection valid as data changes.
      React.useEffect(() => {
        if (report === null) return
        const workspaces = report.workspaces
        if (workspaces.length === 0) {
          if (cwd !== '') setCwd('')
          if (relPath !== '') setRelPath('')
          return
        }
        if (!workspaces.some((workspace) => workspace.cwd === cwd)) {
          setCwd(workspaces[0].cwd)
          setRelPath('')
        }
      }, [report])

      // File timeline for the current selection.
      const builtAt = report === null ? 0 : report.builtAt
      React.useEffect(() => {
        if (cwd === '' || relPath === '') {
          setFile(null)
          setFileError(null)
          return undefined
        }
        let alive = true
        setFileBusy(true)
        loadFile(cwd, relPath)
          .then((next) => {
            if (!alive) return
            setFile(next)
            setFileError(null)
            setFileBusy(false)
          })
          .catch((failure) => {
            if (!alive) return
            setFileError(failure && failure.message ? failure.message : String(failure))
            setFileBusy(false)
          })
        return () => {
          alive = false
        }
      }, [cwd, relPath, builtAt, tick])

      const workspaces = report === null ? [] : report.workspaces
      const selectedWorkspace = workspaces.find((workspace) => workspace.cwd === cwd) || null
      const files = selectedWorkspace === null ? [] : selectedWorkspace.files
      const decisions = report === null ? [] : report.decisions

      const selectWorkspace = (nextCwd) => {
        setCwd(nextCwd)
        setRelPath('')
        setFile(null)
        setPending(null)
        setActionError('')
      }

      const selectFile = (nextRelPath) => {
        setRelPath(nextRelPath)
        setPending(null)
        setActionError('')
      }

      const refresh = () => {
        setMessage('')
        sendAction({ action: 'refresh' })
          .then((result) => {
            if (result === null || typeof result !== 'object' || result.ok !== true) throw new Error('refresh failed')
            setTimedOut(false)
            pollSince.current = 0
            setReport((previous) => (previous === null ? previous : { ...previous, building: true }))
            setTick((value) => value + 1)
          })
          .catch((failure) => {
            setActionError(failure && failure.message ? failure.message : String(failure))
          })
      }

      const startPin = (record) => {
        setPending(record)
        setNoteDraft('')
        setActionError('')
      }

      const confirmPin = () => {
        if (pending === null) return
        const record = pending
        sendAction({
          action: 'decision-add',
          cwd: record.cwd || cwd,
          relPath: record.relPath === null ? basenameOf(record.path) : record.relPath,
          sessionId: record.sessionId,
          seq: record.seq,
          note: noteDraft,
        })
          .then((result) => {
            if (result === null || typeof result !== 'object' || result.ok !== true || result.decision === undefined) {
              throw new Error('decision-add failed')
            }
            const decision = normDecision(result.decision)
            setReport((previous) => (previous === null || decision === null
              ? previous
              : { ...previous, decisions: previous.decisions.concat([decision]) }))
            setPending(null)
            setNoteDraft('')
            setActionError('')
          })
          .catch((failure) => {
            setActionError(tr('decision.error', { error: failure && failure.message ? failure.message : String(failure) }))
          })
      }

      const removeDecision = (decision) => {
        sendAction({ action: 'decision-remove', id: decision.id })
          .then((result) => {
            if (result === null || typeof result !== 'object' || result.ok !== true) throw new Error('decision-remove failed')
            setReport((previous) => (previous === null
              ? previous
              : { ...previous, decisions: previous.decisions.filter((entry) => entry.id !== decision.id) }))
            setActionError('')
          })
          .catch((failure) => {
            setActionError(tr('decision.error', { error: failure && failure.message ? failure.message : String(failure) }))
          })
      }

      const runExport = (format) => {
        setMessage('')
        loadExport(format, cwd, relPath)
          .then((exported) => {
            saveDownload(exported.filename, exported.content, format === 'json' ? 'application/json' : 'text/markdown')
            setMessage(tr('export.done', { filename: exported.filename }))
          })
          .catch((failure) => {
            setMessage(tr('export.error', { error: failure && failure.message ? failure.message : String(failure) }))
          })
      }

      const state = report === null && error === null
        ? 'loading'
        : report === null
          ? 'error'
          : report.stats.records === 0 && report.decisions.length === 0 && report.workspaces.length === 0
            ? 'empty'
            : 'populated'

      const chips = report === null
        ? null
        : h(
            'div',
            { className: 'pv-chips' },
            h('span', { 'data-stat': 'sessions' }, tr('chip.sessions', { n: report.stats.sessions })),
            h('span', { 'data-stat': 'records' }, tr('chip.records', { n: report.stats.records })),
            h('span', { 'data-stat': 'files' }, tr('chip.files', { n: report.stats.files })),
            h('span', { 'data-stat': 'workspaces' }, tr('chip.workspaces', { n: report.stats.workspaces })),
          )

      const buildNotice = report !== null && report.building
        ? h(
            'div',
            { className: 'pv-notice', 'data-role': 'building' },
            h('span', { className: 'pv-spinner', 'aria-hidden': true }),
            h('span', null, timedOut ? tr('buildingTimeout') : tr('building')),
          )
        : report !== null && typeof report.lastError === 'string' && report.lastError !== ''
          ? h('div', { className: 'pv-notice pv-stale', 'data-role': 'stale' }, tr('staleError'))
          : null

      const header = h(
        'div',
        { className: 'pv-head' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h2', { className: 'pv-title' }, tr('title')),
          h('div', { className: 'pv-sub' }, tr('subtitle')),
          chips,
          report !== null && typeof report.note === 'string' && report.note !== '' ? h('div', { className: 'pv-notice', 'data-role': 'note' }, tr('fallbackNote')) : null,
        ),
        h(
          'div',
          { className: 'pv-head-actions' },
          report !== null ? h('span', { className: 'pv-msg' }, tr('builtAt', { time: fmtTime(report.builtAt) })) : null,
          h(
            'button',
            { type: 'button', className: 'pv-btn', 'data-action': 'refresh', onClick: refresh, disabled: report !== null && report.building },
            report !== null && report.building ? tr('refreshing') : tr('refresh'),
          ),
        ),
      )

      const workspaceColumn = h(
        'div',
        { className: 'pv-col' },
        h(
          'div',
          { className: 'pv-col-head' },
          h('h3', { className: 'pv-col-title' }, tr('workspace.title')),
          h('span', { className: 'pv-col-count' }, String(workspaces.length)),
        ),
        h(
          'div',
          { className: 'pv-list', 'data-role': 'workspaces' },
          workspaces.length === 0
            ? h('div', { className: 'pv-empty' }, tr('workspace.empty'))
            : workspaces.map((workspace) =>
                h(
                  'button',
                  {
                    key: workspace.cwd,
                    type: 'button',
                    className: 'pv-item' + (workspace.cwd === cwd ? ' pv-item-on' : ''),
                    'data-cwd': workspace.cwd,
                    'aria-pressed': workspace.cwd === cwd ? 'true' : 'false',
                    title: workspace.cwd,
                    onClick: () => selectWorkspace(workspace.cwd),
                  },
                  h('span', { className: 'pv-item-name' }, shortCwd(workspace.cwd)),
                  h(
                    'span',
                    { className: 'pv-item-meta' },
                    h('span', null, tr('workspace.files', { n: workspace.files.length })),
                    h('span', null, String(workspace.total)),
                  ),
                ),
              ),
        ),
      )

      const fileColumn = h(
        'div',
        { className: 'pv-col' },
        h(
          'div',
          { className: 'pv-col-head' },
          h('h3', { className: 'pv-col-title' }, tr('file.title')),
          h('span', { className: 'pv-col-count' }, String(files.length)),
        ),
        h(
          'div',
          { className: 'pv-list', 'data-role': 'files' },
          files.length === 0
            ? h('div', { className: 'pv-empty' }, tr('file.empty'))
            : files.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.relPath,
                    type: 'button',
                    className: 'pv-item' + (entry.relPath === relPath ? ' pv-item-on' : ''),
                    'data-relpath': entry.relPath,
                    'aria-pressed': entry.relPath === relPath ? 'true' : 'false',
                    title: entry.relPath,
                    onClick: () => selectFile(entry.relPath),
                  },
                  h('span', { className: 'pv-item-name' }, entry.relPath),
                  h(
                    'span',
                    { className: 'pv-item-meta' },
                    h('span', null, tr('file.count', { n: entry.count })),
                    entry.models.slice(0, 2).map((model) => h('span', { key: model, className: 'pv-badge' }, model)),
                  ),
                ),
              ),
        ),
      )

      const timelineBody = fileError !== null
        ? h('div', { className: 'pv-error' }, h('div', null, tr('state.partial')), h('div', { className: 'pv-error-detail' }, fileError))
        : relPath === ''
          ? h('div', { className: 'pv-empty' }, tr('timeline.hint'))
          : fileBusy && file === null
            ? h('div', { className: 'pv-empty' }, tr('timeline.loading'))
            : file !== null && file.records.length > 0
              ? file.records.map((record) =>
                  pending !== null && pending.seq === record.seq && pending.sessionId === record.sessionId
                    ? h(
                        'div',
                        { key: `${record.sessionId}-${record.seq}`, className: 'pv-record', 'data-seq': String(record.seq) },
                        h(
                          'div',
                          { className: 'pv-record-head' },
                          h(
                            'div',
                            { className: 'pv-record-meta' },
                            tr('record.meta', {
                              seq: record.seq,
                              time: fmtTime(record.time),
                              model: modelLabel(record) || tr('unknown'),
                              tool: record.tool,
                            }),
                          ),
                        ),
                        h('code', { className: 'pv-code' }, record.snippet || '—'),
                        h(DecisionForm, {
                          tr,
                          record,
                          value: noteDraft,
                          onChange: setNoteDraft,
                          onConfirm: confirmPin,
                          onCancel: () => {
                            setPending(null)
                            setNoteDraft('')
                          },
                        }),
                      )
                    : h(RecordCard, {
                        key: `${record.sessionId}-${record.seq}`,
                        record,
                        tr,
                        now: Date.now(),
                        onPin: startPin,
                      }),
                )
              : h('div', { className: 'pv-empty' }, tr('timeline.empty'))

      const timelineColumn = h(
        'div',
        { className: 'pv-col' },
        h(
          'div',
          { className: 'pv-col-head' },
          h('h3', { className: 'pv-col-title' }, tr('timeline.title')),
          h('span', { className: 'pv-col-count' }, relPath === '' ? '' : relPath),
        ),
        h('div', { className: 'pv-timeline', 'data-role': 'timeline' }, timelineBody),
      )

      const ledger = h(
        'div',
        { className: 'pv-ledger', 'data-role': 'ledger' },
        h(
          'div',
          { className: 'pv-ledger-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h3', { className: 'pv-ledger-title' }, tr('decision.title')),
            h('div', { className: 'pv-ledger-desc' }, tr('decision.desc')),
          ),
          h(
            'div',
            { className: 'pv-ledger-actions' },
            h(
              'button',
              { type: 'button', className: 'pv-btn', 'data-action': 'export-md', onClick: () => runExport('md') },
              tr('export.md'),
            ),
            h(
              'button',
              { type: 'button', className: 'pv-btn', 'data-action': 'export-json', onClick: () => runExport('json') },
              tr('export.json'),
            ),
          ),
        ),
        message !== '' ? h('div', { className: 'pv-msg', 'data-role': 'message' }, message) : null,
        actionError !== '' ? h('div', { className: 'pv-msg pv-stale', 'data-role': 'action-error' }, actionError) : null,
        h(
          'div',
          { className: 'pv-decisions', 'data-role': 'decisions' },
          decisions.length === 0
            ? h('div', { className: 'pv-empty' }, tr('decision.empty'))
            : decisions.map((decision) =>
                h(
                  'div',
                  { key: decision.id, className: 'pv-decision', 'data-decision-id': decision.id },
                  h(
                    'div',
                    { className: 'pv-decision-main' },
                    h('div', { className: 'pv-decision-title' }, decision.title || basenameOf(decision.relPath)),
                    decision.note !== '' ? h('div', { className: 'pv-decision-note' }, decision.note) : null,
                    h(
                      'div',
                      { className: 'pv-decision-meta' },
                      h('span', null, decision.relPath),
                      h('span', null, tr('decision.file', { file: basenameOf(decision.relPath), seq: decision.seq })),
                      h('span', null, tr('decision.created', { time: fmtTime(decision.createdAt) })),
                    ),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'pv-btn-ghost pv-btn', 'data-action': 'remove-decision', onClick: () => removeDecision(decision) },
                    tr('decision.remove'),
                  ),
                ),
              ),
        ),
      )

      let body = null
      if (state === 'loading') body = h(LoadingState, { tr })
      else if (state === 'error') body = h(ErrorState, { tr, detail: error, onRetry: () => setTick((value) => value + 1) })
      else if (state === 'empty') body = h(EmptyState, { tr })
      else body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h(HeaderGrid, { workspaceColumn, fileColumn, timelineColumn }), ledger)

      return h(
        'div',
        {
          className: 'pv-root',
          'data-state': state,
          'data-building': report !== null && report.building ? '1' : '0',
          'data-cwd': cwd,
          'data-relpath': relPath,
        },
        h('style', null, CSS),
        header,
        buildNotice,
        body,
      )
    }

    /** Thin wrapper so the three-column grid is a component (hook positions stay stable). */
    function HeaderGrid(props) {
      return h('div', { className: 'pv-grid' }, props.workspaceColumn, props.fileColumn, props.timelineColumn)
    }

    // ---- plugin registration --------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: TEXT.zh, en: TEXT.en }),
          'provenance: dictionaries',
        )
        const getLanguage = () => activeLanguage(ctx)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'provenance',
              order: 5,
              label: () => (/^zh/i.test(getLanguage()) ? '溯源' : 'Provenance'),
              locale: NS,
              inject: () => ({ fetchReport, fetchFile, postAction, fetchExport, downloadFile, getLanguage }),
            },
            ProvenanceSection,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'provenance' }, ProvenanceIcon),
        )
      },
      // Pure model surface for the no-browser tests; inert at runtime.
      __model: {
        NS,
        ROUTE,
        POLL_MS,
        BUILDING_TIMEOUT_MS,
        FILE_RECORD_CAP,
        TEXT,
        textOf,
        format,
        activeLanguage,
        isChinese,
        pageIsChinese,
        fmtClock,
        fmtTime,
        shortCwd,
        basenameOf,
        modelLabel,
        parseReport,
        parseFile,
        normDecision,
        normWorkspace,
        normFile,
        normRecord,
        fetchReport,
        fetchFile,
        postAction,
        fetchExport,
        downloadFile,
        ProvenanceSection,
        ProvenanceIcon,
        HeaderGrid,
        LoadingState,
        ErrorState,
        EmptyState,
        RecordCard,
        DecisionForm,
      },
    }
  },
})
