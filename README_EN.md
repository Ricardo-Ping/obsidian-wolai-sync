# Obsidian Wolai Sync

[简体中文](README.md) | [English](README_EN.md)

An Obsidian community plugin for synchronizing Markdown notes, database records, child pages, and images with Wolai.

> This project is an enhanced derivative of [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync). It preserves the original copyright and license and is maintained by [Ricardo-Ping](https://github.com/Ricardo-Ping). Thanks to the original author, Li Wei, for the foundation of this project.

## Features

- Full two-way synchronization between Obsidian and Wolai.
- Incremental synchronization based on page versions, edit times, content fingerprints, and image state.
- Direct synchronization of ordinary Wolai pages in addition to database records, including recursive child pages.
- Page hierarchy mapping: every Wolai child page becomes an independent Markdown file under its parent's directory.
- Incremental images stored in the corresponding page's `pictures/` directory.
- Math conversion between Wolai inline/block equations and Obsidian MathJax `$...$` / `$$...$$` syntax.
- In-place updates and conflict protection: files with `wolai_id` update the existing page; concurrent changes stop and save the Wolai version under `_conflicts/`.
- Atomic recovery state with one lightweight journal entry per completed page; parents are saved before descending into child trees.
- Local rolling-hour API quota control with slow synchronization and automatic continuation.
- Pause, resume, and stop controls for full and incremental jobs.
- Safe cleanup only after a successful full synchronization; eligible stale files are moved to the system trash.
- Live progress and streaming logs for synchronization, API usage, HTTP 429 retries, successes, and errors.
- Optional scheduled synchronization and file watching, both disabled by default on new installations.
- One-way “Sync to Wolai” mode that does not delete Wolai content.

## Installation

### Build from source

Node.js 18 or later is required.

```bash
git clone https://github.com/Ricardo-Ping/obsidian-wolai-sync.git
cd obsidian-wolai-sync
npm install
npm run build
```

Copy the following files into your Obsidian vault:

```text
<your-vault>/.obsidian/plugins/obsidian-wolai-sync/
├── main.js
├── manifest.json
└── styles.css
```

Restart Obsidian and enable **Wolai Sync** under **Settings → Community plugins**.

## Wolai Configuration

1. Create an application in the [Wolai Developer Center](https://www.wolai.com/developers).
2. Obtain its App ID and App Secret, and grant it access to the target pages or database.
3. Enter the following values in the plugin settings:
   - Database ID when database synchronization is needed;
   - App ID;
   - App Secret;
   - Ordinary Wolai pages, optionally one per line as `Title | page URL or page ID`;
   - The hourly API quota matching your Wolai plan.
4. Select an Obsidian synchronization folder and use **Test connection** before the first run.

Configuration is stored only in the local Obsidian plugin data. Never commit `data.json`, logs, or synchronization state files.

## Database Fields

Database synchronization retains the data model of the upstream project and requires at least:

| Field | Type | Purpose |
| --- | --- | --- |
| Title (`标题`) | Title/text | Obsidian file title |
| Sync status (`同步状态`) | Select | Values such as `Pending` and `Synced` |

Recursive synchronization of ordinary pages does not require a database.

## Synchronization Modes

### Full two-way synchronization

Reads all configured pages and database records again and writes their pages and images. Final state and safe cleanup are committed only when the entire run succeeds.

### Incremental two-way synchronization

Reads lightweight metadata first and skips unchanged pages. Changed pages are fetched in full, while new, modified, and removed images are handled independently. Each completed page appends a lightweight checkpoint, and a successful run atomically compacts the final state; parents are saved before recursion.

### Sync to Wolai only

Writes pending Obsidian files to Wolai without running Wolai → Obsidian synchronization. Files with `wolai_id` update that page in place; files without one create a database record. Missing local files do not delete Wolai pages.

### Upgrading legacy state (1.3.3)

Reload the plugin and run incremental two-way sync; do not clear checkpoints or start over with a full sync. If a legacy record has no content hash, its Wolai page is read to verify the body first. File size or modification time alone never triggers an upload.

- Matching bodies: preserve the local body and custom properties, refresh the baseline, clear false `Conflict` / `localDirty` markers left by 1.3.0, and continue to child pages.
- Legacy math formatting only: for older-renderer notes still marked `Synced`, with unchanged remote metadata and no known local edits, reconstruct the old rendering from Wolai block types. Migrate to `$…$` / `$$…$$` only when the local body matches that rendering; never blindly strip dollar signs from Markdown. Back up the original file in the installed plugin's `math-migration-backups/` directory before writing, preserve custom properties, and reuse unchanged pictures.
- When the entire historical page state is absent, the same backed-up migration is allowed only for a note with a matching `wolai_id`, `Synced` status, a valid `last_sync`, no other sync record, and an exact legacy-rendered body match. Other text, formula or image-reference changes, and `Modified` / `Conflict` status, do not bypass protection.
- Missing historical baseline and different bodies: retain the local note, save a Wolai copy, and report `SYNC_BASELINE_UNKNOWN` for manual review instead of guessing which side is correct.
- Known baselines with genuinely conflicting edits still receive conflict protection.

Initial verification of legacy pages requires API requests. Subsequent runs can fast-skip using the new baselines. Upgrading does not clear existing checkpoints or conflict copies.

### Isolated page failures and progress

A page conflict or read failure is recorded without stopping later siblings. Children discovered from a conflicted parent are also processed. Cancellation still stops traversal. An incomplete run reports a summary of unresolved pages as **partially completed**, never “everything is up to date”; incomplete imports retain checkpoints and do not clean up old files or pictures. Resumed verification remains subject to the existing 24-hour validity window and local-file checks.

Because the tree size is discovered during traversal, the UI uses an indeterminate progress bar with **processed / discovered** counts and the current path, instead of holding a misleading estimate at 94%. Processed counts include successful, skipped, and failed attempts; unresolved counts are summarized separately. Only an entirely successful run reaches 100%.

### Within-page checkpoints for large pages (1.3.3)

- Full and incremental imports append each successfully fetched children batch, including its cursor, to `wolai-block-checkpoints/` in the plugin directory. Interrupted reads can reuse batches after quota waits or reloads under the same page revision.
- These are interrupted-read snapshots valid for up to 24 hours, not zero-API live change detection. The page revision is checked before resuming and again after resumed or long reads. Revision/account changes invalidate the snapshot. It is removed only after the note and its sync baseline are saved. Outbound conflict checks never reuse these snapshots.
- Block IDs are de-duplicated. Cycles, repeated cursors, non-advancing pagination, and excessive depth/size produce explicit errors instead of unbounded requests. A response claiming another page without a usable cursor is no longer silently accepted as complete.
- Logs include request sequence, method, endpoint path, status, duration, batch counts and cache reuse, without credentials, request bodies or signed image URLs. The 30-second deadline also covers response bodies. Temporary image URLs are refreshed only when a cached image actually needs downloading.
- Older versions did not persist within-page reads, so those previously fetched batches cannot be recovered retroactively. The first read after upgrading starts building the journal. API quotas still apply.

Read journals contain note content: treat them as private data. They are excluded from Git together with migration backups, credentials and sync state.

### Whole-table reads and request reduction (1.3.4)

`GET /blocks/{tableId}` can return a complete `table_content` matrix and `table_setting`, unlike the direct-children endpoint. The reader validates revision, dimensions, cell count and supported content before replacing per-cell traversal with one detail request. Unsupported/incomplete matrices fall back to the original traversal; network failures and changed revisions never become an empty successful table. Whole-table responses participate in the existing within-page checkpoint journal.

- Supported text tables preserve cells, empty values, numerical strings (including leading/trailing zeros and percentages), line breaks, common rich text and inline math. Equivalent LaTeX `\vert{}` / `\Vert{}` commands avoid Markdown column separators changing absolute-value/norm formulas.
- This is not pixel-identical rendering: widths, colors, merged cells and special embeds are not guaranteed. Headerless tables receive an empty Markdown header. Unsupported content falls back to block traversal and may remain plain text rather than a faithful table layout.
- **Tables are inbound-only (Wolai → Obsidian).** Outbound synchronization of table-containing notes and replacement of existing remote tables are blocked to prevent destructive paragraph conversion. Edit those pages in Wolai.
- Incremental sync refreshes legacy notes containing `*[表格内容]*`, without invalidating every ordinary page. Clean, baseline-verified legacy notes are backed up in `table-migration-backups/` before replacement. Missing baselines and local edits retain conflict protection.
- Same-structure offline benchmark: 22 tables / 564 cells, **592 → 28** successful content requests (95.3% fewer). This is not an end-to-end live-page benchmark and excludes authentication, revision checks, images and retries. A live 7×6 table was checked cell-by-cell against the generated Markdown: all 42 text values matched.

Nested tables render at page level in reading order to avoid becoming indented code blocks; original indentation is not retained. Unsupported-table fallback adds one detail probe over the original traversal. Detail-read batch counts exclude retries, while API accounting includes every HTTP attempt and retry.

GFM parsing and MathJax glyph/bounding-box tests cover numerical strings, cell boundaries and formulas. No additional Obsidian math plugin is required. Test-only dependencies are not included in the runtime bundle. See [validation notes](docs/table-optimization-validation.md).

## Output Layout

For a Wolai parent page named `Database Query Rewriting` with a child page named `GRewriter`:

```text
Wolai/
├── Database Query Rewriting.md
└── Database Query Rewriting/
    ├── pictures/
    ├── GRewriter.md
    └── GRewriter/
        └── pictures/
```

Images belonging to each page are stored in that page's own `pictures/` directory.

## API Limits and Slow Synchronization

Before an actual Wolai API request is sent, the plugin records a local timestamp and enforces the selected quota over a rolling 60-minute window. When the quota is exhausted, the current job remains queued until older requests leave the window. Local waiting checks do not consume API calls.

Wolai may still return HTTP 429. The plugin honors `Retry-After` when supplied and retries with backoff. Monthly limits cannot be avoided by delaying requests.

## Safety

- `App Secret`, local settings, logs, API counters, and incremental state are excluded through `.gitignore`.
- Scheduled synchronization and file watching are disabled by default.
- Failed or cancelled full runs never trigger stale-file cleanup.
- Cleanup only considers plugin-generated files recorded in its manifest and not manually modified by the user, and prefers moving them to the system trash.
- Concurrent local and remote edits are not overwritten automatically. The Wolai version is stored under `_conflicts/` and the run reports a conflict.

## Development

```bash
npm install
npm run lint
npm test
npm run build
# Run all checks at once
npm run check
```

The repository contains source code only. It excludes `node_modules/`, local settings, logs, synchronization state, and the generated `main.js`. A release package must contain `main.js`, `manifest.json`, and `styles.css`.

## Known Limitations

- Wolai blocks and Markdown have different data models; complex nesting, some database properties, and special rich text may not convert losslessly.
- Network failures, server-side rate limits, and monthly plan limits can still pause or fail a job.
- Editing the same page on both sides creates a conflict copy that must be merged manually before marking the file `Modified` again.
- The plugin is not currently listed in the official Obsidian community plugin directory and must be installed manually.

## Origin and License

This project is a modified derivative of [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync), which is based on the Obsidian Sample Plugin and uses a 0BSD-style license text.

See [LICENSE](LICENSE) for copyright and licensing details. The original notice is preserved, and enhancements made in 2026 are copyrighted by Ricardo_PING.

## Contributing

Issues and pull requests are welcome. Before attaching diagnostic logs, remove App IDs, App Secrets, page IDs, page titles, and local filesystem paths.
