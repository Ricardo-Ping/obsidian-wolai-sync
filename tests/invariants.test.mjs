import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('page blocks are synchronization boundaries', async () => {
    const source = await read('src/WolaiAPI.ts');
    assert.match(source, /block\.type !== 'page'/);
    assert.match(source, /parentBlockId: block\.id/);
    assert.doesNotMatch(source, /expandedChildBlocks\.map/);
});

test('database and page children implement cursor pagination', async () => {
    const source = await read('src/WolaiAPI.ts');
    assert.match(source, /content\.has_more === true/);
    assert.match(source, /start_cursor=\$\{encodeURIComponent\(cursor\)\}/);
    assert.match(source, /has_more 但无 next_cursor/);
    assert.match(source, /Repeated pagination cursor/);
});

test('page trees are serial and child failures propagate', async () => {
    const source = await read('src/SyncManager.ts');
    assert.doesNotMatch(source, /Promise\.all\(pages\.map\(syncPage\)\)/);
    assert.match(source, /if \(!childSuccess\) throw new Error/);
    assert.match(source, /successCount === pages\.length && this\.settings\.safeCleanup/);
});

test('new installations do not enable automatic synchronization', async () => {
    const source = await read('main.ts');
    assert.match(source, /autoSync: false/);
});

test('runtime and sensitive files are excluded from source control', async () => {
    const ignore = await read('.gitignore');
    for (const name of [
        'data.json', 'sync.log', 'sync-records.json', 'wolai-api-quota.json',
        'wolai-generated-files.json', 'wolai-incremental-state.json'
    ]) assert.match(ignore, new RegExp(name.replaceAll('.', '\\.')));
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

test('completed pages are checkpointed without committing unfinished deletions', async () => {
    const manager = await read('src/SyncManager.ts');
    assert.match(manager, /saveIncrementalCheckpoint/);
    assert.match(manager, /\{ \.\.\.previousState, \.\.\.nextState \}/);
    assert.match(manager, /await this\.saveIncrementalCheckpoint\(previousState, nextState\)/);
    assert.match(manager, /successCount === pages\.length[\s\S]*await this\.saveIncrementalState\(nextState\)/);
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
    assert.match(manager, /previousPage\.converterVersion !== this\.converterVersion/);
    assert.match(manager, /converterVersion: this\.converterVersion/);
});

test('transient network failures retry and interrupted incremental runs resume', async () => {
    const api = await read('src/WolaiAPI.ts');
    const manager = await read('src/SyncManager.ts');
    const gitignore = await read('.gitignore');
    assert.match(api, /Wolai API 网络请求失败/);
    assert.match(api, /\[408, 425, 500, 502, 503, 504\]/);
    assert.match(manager, /wolai-resume-state\.json/);
    assert.match(manager, /从断点跳过已核验页面/);
    assert.match(manager, /await this\.clearResumeState\(\)/);
    assert.match(gitignore, /wolai-resume-state\.json/);
});
