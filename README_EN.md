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
