# dsh-provenance

**Line-level provenance and a decision ledger for agent edits.** Answer "who wrote this line — which session, which model, which tool?" for every file the agent changed on this machine, then pin the important changes as decisions and export an audit trail as Markdown or JSON.

## Install

- **DSH marketplace**: install `@ruaibeite/dsh-provenance` from the community plugin catalog (requires the `dsh-plugin` topic).
- **From source**: clone this repository, then add the plugin to your profile's layer stack:

  ```sh
  git clone https://github.com/ruaibeite/dsh-provenance.git
  ```

  Add `@ruaibeite/dsh-provenance` to your web profile's `dsh.profile.bundles` (or symlink the directory into the profile's `node_modules/@ruaibeite/`), then restart DSH. The page appears in **Settings → Provenance** (id `provenance`, order 5).

## What it does

A single Settings page with a master-detail browser:

1. **Workspaces** — every workspace the agent has touched on this machine, newest first.
2. **Files** — per workspace, the changed files with record counts and the models that wrote them.
3. **Record timeline** — one card per `write` / `edit` call: `#seq · time · model · tool`, a copyable snippet, the line delta, before/after content hashes, and a **Pin as decision** button.
4. **Decision ledger** — your own pinned entries with an optional note ("why was this change made?"); remove them at any time.
5. **Export** — Markdown (human-readable audit) or JSON (machine-readable), downloaded straight from the page.

It also normalizes relative paths against the session's working directory and keeps records that point outside it (with no relative path).

## How it works

- The host half reads the local session history, **read-only**. Preferred source: `ctx.sessionQuery.listSessions()` + `readSession(id)`. When the session service is unavailable it falls back to scanning `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` directly, decoding every Zstandard frame (the JSONL backend appends one frame per flush batch, so single-frame decoders would miss most events).
- Only `tool/call` events whose tool is `write` or `edit` become records. The model route is taken from the most recent `assistant/message` source, the turn/step from the tool call, and calls whose `tool/result` reports `ok:false` are dropped.
- Records are aggregated per workspace and file and cached at `$DSH_HOME/cache/provenance/index.json`. The index is rebuilt when older than 5 minutes (background, single-flight) or when you press **Refresh**. Per-file history keeps the newest 200 records; the whole index is capped at 20k records. Decisions live in `$DSH_HOME/cache/provenance/decisions.json` and never trigger a rebuild.
- The browser half only calls this plugin's own same-origin route (`GET|POST /dsh-provenance/api`); it imports nothing from `@deepseek-ai/*` and uses theme tokens only.

## Privacy

- **Local-only**: no network request, no upload, no telemetry.
- **Read-only**: the plugin never writes session logs, never appends events and never modifies your repository.
- **Its own cache only**: the only writes are `$DSH_HOME/cache/provenance/index.json` and `decisions.json` (atomic temp file + rename).
- It does not read credentials or print prompts to logs.

## Known limitations (v0.1.0)

- Only the built-in `write` / `edit` tool calls are tracked. Changes made through shell redirection, formatters, external editors, `git` or other tools are **not** visible.
- A record describes the **call intent**, not the final file line number — code keeps changing, so use the content hashes (sha256, first 16 hex chars) to locate changes.
- Failed calls are filtered only when the matching `tool/result` carries `ok:false`; an interrupted session may still list attempted edits.
- Paths are normalized with `path.resolve`; symbolic links are not resolved.
- Subagent sessions (`delegationDepth > 0`) are skipped to keep the ledger readable.
- The decision ledger is a lightweight ADR: notes are user-authored, no ADR is generated automatically.
- Only sessions visible to `sessionQuery` (or present as local logs) are indexed; at most the newest 200 sessions / 50k events per session are scanned.

## Verify

```sh
cd dsh-provenance
node --check index.js && node --check client.js
npm test        # host.mjs (31 tests) + render.mjs (14 tests), no browser / no network / no real ~/.dsh
```

The tests use inline fixtures and temporary `DSH_HOME` directories only.

## License

MIT.
