<!-- PR title: Add ruaibeite/dsh-provenance -->

Adds one entry file:

`data/plugins/ruaibeite__dsh-provenance.yml`

- Single entry; no other files touched, and the generated READMEs are left untouched.
- The repository declares `dsh.bundle` in `package.json` (with `cordis.patch.yml`) and ships real host + client code.
- `dsh-plugin` topic is set on the repository.
- Description states what the code does: the host half reads the local session history read-only (preferred: `ctx.sessionQuery.listSessions()` + `readSession(id)`; fallback: scanning `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` with a multi-frame Zstandard decoder) and turns `write` / `edit` tool calls into provenance records (session, seq, time, model route, tool, workspace-relative path, before/after content hashes, snippet, line delta). Records are aggregated per workspace and file into `$DSH_HOME/cache/provenance/index.json` (5-minute rebuild / manual refresh, single-flight, atomic writes; per-file 200 records, global 20k). The client half adds a **Provenance** section to Settings with a workspace → file → record timeline browser, a decision ledger (pin a record with a note, remove it), and Markdown/JSON export downloaded from the page.
- Read-only: it never writes session logs, never appends events and never modifies the repository; the only writes are its own `$DSH_HOME/cache/provenance/*.json`. No network request, no upload.
- Icon is a GitHub-hosted raster (`assets/icon-180.png`); three real screenshots are declared in the repository's own `screenshots.json` (`assets/screenshot-*.png`: light ledger, decision ledger, dark theme). They were captured from a real DSH 0.2.2-rc.1 web profile with synthetic demo data; no user data is shown.
- No npm package; installs from GitHub. Verified with `npm test` (31 host + 14 browser-harness tests) and a real `dsh --profile web` boot in an isolated `DSH_HOME` (route `GET /dsh-provenance/api?action=report` → 200 JSON).
- The repository was created immediately before this PR, so the submission gate's 1-day repository-age check will fail until it clears on its own; nothing else is pending.