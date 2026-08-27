import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('page blocks are synchronization boundaries', async () => {
    const source = await read('src/PageBlockReader.ts');
    assert.match(source, /block\.type !== 'page'/);
    assert.match(source, /parentBlockId: parentId/);
    assert.doesNotMatch(source, /expandedChildBlocks\.map/);
});

test('database and page children implement cursor pagination', async () => {
    const source = await read('src/WolaiAPI.ts');
    const reader = await read('src/PageBlockReader.ts');
    assert.match(source, /content\.has_more === true/);
    assert.match(source, /start_cursor=\$\{encodeURIComponent\(cursor\)\}/);
    assert.match(reader, /has_more 但无 next_cursor/);
    assert.match(reader, /Repeated pagination cursor/);
});

test('page trees are serial and isolate child failures', async () => {
    const source = await read('src/SyncManager.ts');
    assert.doesNotMatch(source, /Promise\.all\(pages\.map\(syncPage\)\)/);
    assert.match(source, /if \(!success\) allSucceeded = false/);
    assert.doesNotMatch(source, /if \(!childSuccess\) throw new Error/);
    assert.match(source, /mode === 'full'.*this\.settings\.safeCleanup/);
});

test('new installations do not enable automatic synchronization', async () => {
    const source = await read('main.ts');
    assert.match(source, /autoSync: false/);
});

test('runtime and sensitive files are excluded from source control', async () => {
    const ignore = await read('.gitignore');
    for (const name of [
        'data.json', 'sync.log', 'sync-records.json', 'wolai-api-quota.json',
        'wolai-generated-files.json', 'wolai-incremental-state.json', 'wolai-incremental-journal.jsonl',
        'wolai-resume-state.json', 'wolai-file-queue.json', 'math-migration-backups/', 'wolai-block-checkpoints/', '*.json.tmp', '*.json.bak'
    ]) assert.match(ignore, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('package metadata and license agree', async () => {
    const pkg = JSON.parse(await read('package.json'));
    const readme = await read('README.md');
    assert.equal(pkg.author, 'Ricardo_PING');
    assert.equal(pkg.license, '0BSD');
    assert.match(readme, /0BSD/);
});

test('API accounting uses one persistent pre-request counter', async () => {
    const api = await read('src/WolaiAPI.ts');
    const manager = await read('src/SyncManager.ts');
    assert.match(api, /await this\.beforeRequest\?\.\(\)/);
    assert.doesNotMatch(api, /incrementAPICall/);
    assert.match(manager, /this\.apiTotalRequests\+\+/);
    assert.match(manager, /this\.apiTodayRequests\+\+/);
    assert.match(manager, /addApiStatsListener/);
    assert.match(manager, /hourly: this\.apiRequestTimestamps\.length/);
});

test('settings log view subscribes to streaming log lines', async () => {
    const settings = await read('src/SettingsTab.ts');
    const manager = await read('src/SyncManager.ts');
    assert.match(settings, /addLogListener\(appendLine\)/);
    assert.match(settings, /logEl\.value = \(logEl\.value \+ line\)/);
    assert.match(manager, /for \(const listener of this\.logListeners\) listener\(line\)/);
});

test('completed pages are journaled without committing unfinished deletions', async () => {
    const manager = await read('src/SyncManager.ts');
    assert.match(manager, /appendIncrementalCheckpoint/);
    assert.match(manager, /wolai-incremental-journal\.jsonl/);
    assert.match(manager, /appendIncrementalCheckpoint\(row\.page_id, nextState\[row\.page_id\]\)/);
    assert.match(manager, /successCount === pages\.length[\s\S]*await this\.saveIncrementalState\(nextState\)/);
});

test('linked Obsidian pages update in place with conflict protection', async () => {
    const api = await read('src/WolaiAPI.ts');
    const manager = await read('src/SyncManager.ts');
    assert.match(api, /method: 'PUT'/);
    assert.match(api, /method: 'DELETE'/);
    assert.match(api, /replacePageContent/);
    assert.match(api, /block\.type !== 'page'/);
    assert.match(manager, /SYNC_CONFLICT/);
    assert.match(manager, /缺少远端基线，已阻止覆盖/);
    assert.match(manager, /outboundUpdatedPageIds/);
});

test('runtime state is atomic and page journals precede child traversal', async () => {
    const manager = await read('src/SyncManager.ts');
    assert.match(manager, /writeRuntimeJsonAtomic/);
    assert.match(manager, /\.tmp/);
    assert.match(manager, /\.bak/);
    const checkpoint = manager.indexOf('appendIncrementalCheckpoint(row.page_id, nextState[row.page_id])');
    const childLoop = manager.indexOf('return await visitChildren()', checkpoint);
    assert.ok(checkpoint >= 0 && childLoop > checkpoint);
});

test('file watcher queues work and detects content hashes', async () => {
    const entry = await read('main.ts');
    const manager = await read('src/SyncManager.ts');
    assert.match(entry, /pendingFileSyncs/);
    assert.match(entry, /processFileSyncQueue/);
    assert.match(entry, /wolai-file-queue\.json/);
    assert.match(entry, /if \(!completed\)[\s\S]*scheduleFileQueueRetry/);
    assert.match(entry, /fileQueueWrite/);
    assert.match(manager, /prepareLocalFileForSync/);
    assert.match(manager, /if \(await this\.prepareLocalFileForSync\(filePath\)\)/);
    assert.match(manager, /检测到 Obsidian 本地修改/);
});

test('database read failures propagate instead of becoming empty results', async () => {
    const api = await read('src/WolaiAPI.ts');
    assert.match(api, /Missing database content/);
    assert.match(api, /Missing next_cursor for database/);
    assert.doesNotMatch(api, /if \(!content\) \{\s*break;/);
});

test('runtime files use the installed plugin directory', async () => {
    const entry = await read('main.ts');
    const manager = await read('src/SyncManager.ts');
    assert.match(entry, /this\.manifest\.dir/);
    assert.match(manager, /pluginDirectory: string/);
    assert.doesNotMatch(manager, /obsidian-wolai-sync-master/);
});

test('Wolai and Obsidian math syntax is converted in both directions', async () => {
    const parser = await read('src/MarkdownParser.ts');
    const pkg = JSON.parse(await read('package.json'));
    assert.ok(pkg.devDependencies['remark-math']);
    assert.match(parser, /\.use\(remarkMath as any\)/);
    assert.match(parser, /case 'math':[\s\S]*type: 'block_equation'/);
    assert.match(parser, /case 'inlineMath':[\s\S]*type: 'equation'/);
    assert.match(parser, /case 'block_equation':\s*case 'equation':/);
    assert.match(parser, /richText\.type === 'equation'/);
});

test('converter upgrades invalidate Markdown without forcing full image downloads', async () => {
    const manager = await read('src/SyncManager.ts');
    assert.match(manager, /converterVersion = 2/);
    assert.match(manager, /previousPage\.converterVersion === this\.converterVersion/);
    assert.match(manager, /previousPage\?\.converterVersion !== this\.converterVersion/);
    assert.match(manager, /converterVersion: this\.converterVersion/);
});

test('transient network failures retry and interrupted incremental runs resume', async () => {
    const api = await read('src/WolaiAPI.ts');
    const manager = await read('src/SyncManager.ts');
    const gitignore = await read('.gitignore');
    assert.match(api, /Wolai API 网络请求失败/);
    assert.match(api, /\[408, 425, 500, 502, 503, 504\]/);
    assert.match(api, /requestTimeoutMs = 30_000/);
    assert.match(manager, /wolai-resume-state\.json/);
    assert.match(manager, /从断点跳过已核验页面/);
    assert.match(manager, /await this\.clearResumeState\(\)/);
    assert.match(gitignore, /wolai-resume-state\.json/);
});
