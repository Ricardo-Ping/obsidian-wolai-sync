# Obsidian Wolai Sync

[简体中文](README.md) | [English](README_EN.md)

An Obsidian community plugin for synchronizing Markdown notes, database records, child pages, and images with Wolai. It supports rich text formats, multiple block types, and smart synchronization state management.

> This project is an enhanced derivative of [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync). It preserves the original copyright and license and is maintained by [Ricardo-Ping](https://github.com/Ricardo-Ping). Thanks to the original author, Li Wei, for the foundation of this project.

## ✨ Features

- **🔄 Full two-way sync**: Content synchronization in both directions, Obsidian → Wolai and Wolai → Obsidian.
- **⚡ Incremental two-way sync**: Skips unchanged content based on page revisions, edit times, content fingerprints, and image state.
- **📄 Ordinary page sync**: Besides databases, one or more Wolai page URLs/IDs can be configured directly, with recursive child-page synchronization.
- **🗂️ Page hierarchy mapping**: Every Wolai child page becomes an independent Markdown file under a directory named after its parent page.
- **🖼️ Incremental image sync**: Images are stored in the page's own `pictures/` directory; only new or changed images are updated.
- **🧮 Math conversion**: Two-way conversion between Wolai inline/block equations and Obsidian MathJax `$...$` / `$$...$$` syntax.
- **📊 Efficient whole-table reads**: Reads a complete `table_content` in one detail request and converts supported text tables into Markdown rows and columns instead of fetching cells one by one (about 95.3% fewer requests in a same-structure test).
- **🛡️ In-place updates and conflict protection**: Files with `wolai_id` update the existing page; concurrent local and remote changes stop the overwrite and save the Wolai version under `_conflicts/`.
- **💾 Atomic checkpoints**: Each completed page appends a lightweight journal entry; large pages support within-page checkpoints and resume after interruption, quota waits, or reloads.
- **⏳ API quota protection**: Local rolling-hour usage tracking with slow synchronization that respects your Wolai plan quota, including HTTP 429 backoff retries.
- **⏯️ Task control**: Pause, resume, and stop full or incremental jobs.
- **🧹 Safe cleanup**: Only after a successful full synchronization are plugin-generated, unmodified stale files moved to the system trash.
- **📈 Live logs and progress**: Streaming progress for pages, API calls, 429 retries, successes, and errors.
- **🕐 Scheduled sync and file watching**: Both optional and disabled by default on new installations to avoid unexpected API usage.
- **🔒 Sync to Wolai only**: Keeps the original one-way writing ability without deleting Wolai content.

## 📋 Installation

### Method 1: Manual installation (recommended)

1. Obtain the plugin files (`main.js`, `manifest.json`, `styles.css`).
2. Copy the whole plugin folder into `.obsidian/plugins/obsidian-wolai-sync/` in your vault.
3. Restart Obsidian.
4. Enable **Wolai Sync** under **Settings → Community plugins**.

### Method 2: Build from source

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

## 🎯 Use Cases

- **Knowledge management**: Sync notes from Obsidian to Wolai for team collaboration.
- **Content publishing workflow**: Write in Obsidian and publish to Wolai automatically.
- **Two-way backup**: Keep important content backed up on both platforms.
- **Team collaboration**: Personal editing in Obsidian, shared discussion in Wolai.

## ⚙️ Configuration

### 1. Wolai API settings

1. Create an application in the [Wolai Developer Center](https://www.wolai.com/developers).
2. Obtain its **App ID** and **App Secret**, and grant it access to the target pages or database.
3. Enter the App ID and App Secret in the plugin settings.

### 2. Obsidian settings

- **Sync folder**: The Obsidian folder to synchronize (e.g., `Notes/Wolai`).

### 3. Sync settings

- **Database ID**: Required when using database synchronization.
- **Ordinary pages (optional)**: One per line as `Title | page URL or page ID`, with recursive child-page sync.
- **Hourly API quota**: Match your current Wolai plan.
- **Scheduled sync / interval**: Optional, disabled by default.
- **File watching**: Optional, disabled by default.

Use **Test connection** to verify the configuration. Configuration is stored only in local Obsidian plugin data; never commit `data.json`, logs, or synchronization state files.

### Wolai database requirements

When using database synchronization, the database needs at least the following fields:

| Field | Type | Purpose |
| --- | --- | --- |
| Title | Title/text | Obsidian file title |
| Sync status | Select | Values such as `Pending` and `Synced` |

Recursive synchronization of ordinary pages does not require a database.

## 🚀 Usage

### Manual sync

Click the **Wolai Sync** ribbon icon, or click **Manual sync** in the plugin settings, to run a full two-way sync.

### Force-sync the current file

1. Open the Markdown file you want to sync.
2. Command palette (Ctrl/Cmd + P) → search for **"Force sync current file"**.
3. The plugin bypasses regular checks and writes the current file content to Wolai directly.

### Scheduled sync (optional)

Enable **Scheduled sync** in the settings and set an interval (5–120 minutes); the plugin runs incremental sync periodically.

### File watching (optional)

After enabling **File watching**, changes inside the sync folder are automatically queued for sync.

### Sync status

The plugin tracks sync state in each file's frontmatter:

```yaml
---
sync_status: Synced
wolai_id: "page_id_from_wolai"
last_sync: "2024-01-15T10:30:00.000Z"
---
```

- `Pending`: New file waiting for its first sync to Wolai.
- `Modified`: The file was edited and needs to be re-synced to Wolai.
- `Synced`: Successfully synced; no further action required.
- `Wait For Syncing`: Marked in Wolai to be synced into Obsidian.

### Sync modes

#### Full two-way sync

Reads all configured pages and database records again and writes their pages and images. Final state and safe cleanup are committed only when the entire run succeeds.

#### Incremental two-way sync

Reads lightweight metadata first and skips unchanged pages. Changed pages are fetched in full, while new, modified, and removed images are handled independently. Each completed page appends a lightweight checkpoint, and a successful run atomically compacts the final state; parents are saved before recursion.

#### Sync to Wolai only

Writes pending Obsidian files to Wolai without running Wolai → Obsidian synchronization. Files with `wolai_id` update that page in place; files without one create a database record. Missing local files do not delete Wolai pages.

## 📁 Output Layout

### Page hierarchy mapping

Wolai child pages are saved as independent Markdown files under a directory named after their parent page, and each page's images live in its own `pictures/` directory. For example:

```text
Wolai/
├── Database Query Rewriting.md
└── Database Query Rewriting/
    ├── pictures/
    ├── GRewriter.md
    └── GRewriter/
        └── pictures/
```

### Duplicate titles

Duplicate titles in the same directory receive stable ID-based paths: the existing file keeps its name, while the other page uses `Title--shortID.md`, extending the ID when needed. Path mappings are saved atomically, so restarts, resumes, and traversal-order changes never swap filenames.

## 📊 Large Pages and Whole-Table Optimization

### Within-page checkpoints (large pages)

- Full and incremental syncs append successfully fetched content batches, including cursors, to within-page checkpoints in the plugin directory. Interrupted reads can reuse batches after quota waits or reloads under the same page revision, without re-reading the whole page.
- The page revision is checked before resuming; revision or account changes invalidate the cache. Checkpoints are cleared only after the note and its sync baseline are saved.
- Block IDs are de-duplicated. Cycles, repeated cursors, non-advancing pagination, and excessive depth/size produce explicit errors instead of unbounded requests.
- Logs include request sequence, method, endpoint path, status, and duration, without credentials, request bodies, or signed image URLs.

### Whole-table reads

`GET /blocks/{tableId}` can return a complete `table_content`. The reader validates the table revision, matrix dimensions, cell count, and content type before replacing per-cell traversal with one detail request; unsupported or incomplete details fall back to the original block traversal.

- Supported text tables preserve cells, empty values, leading/trailing zeros, decimal places, percentages, line breaks, common rich text, and inline math. Equivalent LaTeX `\vert{}` / `\Vert{}` commands avoid Markdown column separators changing absolute-value/norm formulas.
- This is not pixel-identical rendering: widths, colors, merged cells, and special embeds are not guaranteed.
- **Tables are inbound-only (Wolai → Obsidian).** Outbound synchronization of table-containing notes is blocked; edit those pages in Wolai.
- Same-structure test (22 tables / 564 cells): 592 → 28 content requests, about **95.3%** fewer.

## ⏳ API Limits and Slow Synchronization

Before an actual Wolai API request is sent, the plugin records a local timestamp and enforces the selected quota over a rolling 60-minute window. When the quota is exhausted, the current job remains queued until older requests leave the window; local waiting checks do not consume API calls.

Wolai may still return HTTP 429. The plugin honors `Retry-After` when supplied and retries with backoff. Monthly limits cannot be avoided by delaying requests.

## 🛠️ Supported Markdown Syntax

### Text formats

- **Bold**: `**bold**` or `__bold__`
- *Italic*: `*italic*` or `_italic_`
- `Inline code`: `` `code` ``
- ~~Strikethrough~~: `~~strikethrough~~`
- [Link](https://example.com): `[link text](URL)`

### Block elements

- Headings: `#` to `######`
- Unordered list: `- item` or `* item`
- Ordered list: `1. item`
- Code block: ```` ```code``` ````
- Quote: `> quoted text`
- Divider: `---` or `***`

## 🛡️ Safety

- `App Secret`, plugin settings, logs, API counters, and incremental state are excluded through `.gitignore`.
- Scheduled sync and file watching are disabled by default to avoid unexpected API usage.
- Failed or cancelled full runs never trigger stale-file cleanup.
- Cleanup only considers plugin-generated files recorded in its manifest and not manually modified by the user, and prefers moving them to the system trash.
- Concurrent local and remote edits are not overwritten automatically. The Wolai version is stored under `_conflicts/`, and the run reports a conflict until it is resolved.

## ❗ Notes

1. Back up important data before syncing.
2. Use **Test connection** to verify the configuration before the first run.
3. Make sure the Wolai application has access to the target pages/database.
4. Avoid editing files during a sync to prevent conflict copies.
5. Some special characters or complex nesting may need escaping or manual handling.

## 🐛 Troubleshooting

### 1. Connection failure

- Check whether the App ID and App Secret are correct.
- Confirm the application is connected to the Wolai workspace and has access to the target pages.
- Verify your network connection.

### 2. Sync failure

- Inspect the Obsidian developer console (Ctrl+Shift+I) for error details.
- Check whether the Wolai database fields are complete.
- Confirm the file's frontmatter format is correct.

### 3. Repeated sync

- Check the file's `sync_status` value.
- Confirm the sync status options in the Wolai database.
- Check whether the hourly API quota has been reached.

### 4. Conflict copies

- Editing the same page on both sides creates a conflict copy; merge it manually and mark the file `Modified` again to continue.

## 📋 Known Limitations

- Wolai blocks and Markdown have different data models; complex nesting, some database properties, and special rich text may not convert losslessly.
- Network failures, server-side rate limits, and monthly plan limits can still pause or fail a job.
- Editing the same page on both sides creates a conflict copy that must be merged manually before marking the file `Modified` again.
- The plugin is not currently listed in the official Obsidian community plugin directory and must be installed manually.

## 🔧 Development

```bash
npm install
npm run lint
npm test
npm run build
# Run all checks at once
npm run check
```

The repository contains source code only. It excludes `node_modules/`, local settings, logs, synchronization state, and the generated `main.js`. A release package must contain `main.js`, `manifest.json`, and `styles.css`.

## 📄 License

This project is a modified derivative of [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync), which is based on the Obsidian Sample Plugin and uses a 0BSD-style license text.

See [LICENSE](LICENSE) for copyright and licensing details. The original notice is preserved, and enhancements made in 2026 are copyrighted by Ricardo_PING.

## 🤝 Contributing

Issues and pull requests are welcome. Before attaching diagnostic logs, remove App IDs, App Secrets, page IDs, page titles, and local filesystem paths.
