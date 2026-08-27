import test from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';
import { createHarness, legacyState, syncPage, runtimeDir } from './helpers/sync-harness.mjs';

const textBlocks = [{ id: 'text', type: 'text', content: 'Same note body', version: 2 }];
const pages = () => ({ root: { blocks: textBlocks } });
const note = (body, status = 'Synced', data = {}) => matter.stringify(body, {
    sync_status: status, wolai_id: 'root', last_sync: '2026-01-01T00:00:00.000Z', ...data
});
const bodyFor = h => h.manager.renderPageMarkdown(textBlocks, 'Root', 'root', '');
const conflicts = h => [...h.vault.contents.keys()].filter(path => path.startsWith('Wolai/_conflicts/'));

test('legacy mtime mismatch is unknown, not a local edit or automatic upload', async () => {
    const state = { root: legacyState() };
    const h = await createHarness({ state, manifest: { 'Wolai/Root.md': { size: 1, mtime: 1 } } });
    const original = note('Keep this note');
    h.vault.seed('Wolai/Root.md', original);
    assert.equal(await h.manager.prepareLocalFileForSync('Wolai/Root.md'), false);
    assert.equal(h.vault.readPath('Wolai/Root.md'), original);
    assert.deepEqual(h.requests, []);
    assert.equal(h.vault.contents.has(`${runtimeDir}/wolai-incremental-journal.jsonl`), false);
    assert.ok(h.logs.some(log => log.message.includes('缺少本地内容基线')));
});

test('legacy Modified notes are deferred and force upload cannot bypass missing baseline', async () => {
    const h = await createHarness({ state: { root: legacyState() }, pages: pages() });
    h.vault.seed('Wolai/Root.md', note(bodyFor(h), 'Modified'));
    assert.equal(await h.manager.prepareLocalFileForSync('Wolai/Root.md'), false);
    assert.equal(await h.manager.syncFile('Wolai/Root.md'), false);
    assert.deepEqual(h.requests, []);
});

test('matching legacy Conflict body repairs metadata without replacing body/custom properties', async () => {
    const state = { root: legacyState({ localDirty: true }) };
    const h = await createHarness({ state, pages: pages() });
    const original = note(bodyFor(h), 'Conflict', { tags: ['keep'], custom: 'local value' });
    h.vault.seed('Wolai/Root.md', original);
    const result = await syncPage(h, state);
    assert.equal(result.success, true);
    const after = matter(h.vault.readPath('Wolai/Root.md'));
    assert.equal(after.content, matter(original).content);
    assert.deepEqual(after.data.tags, ['keep']);
    assert.equal(after.data.custom, 'local value');
    assert.equal(after.data.sync_status, 'Synced');
    assert.equal(result.nextState.root.localDirty, false);
    assert.equal(result.nextState.root.converterVersion, 2);
    assert.equal(result.nextState.root.localHash, h.manager.markdownParser.createHash(h.vault.readPath('Wolai/Root.md')));
    assert.equal(result.changes.size, 0);
    assert.deepEqual(conflicts(h), []);
    const persisted = await h.manager.loadIncrementalState();
    assert.equal(persisted.root.localHash, result.nextState.root.localHash);
    assert.ok(h.logs.some(log => log.message.includes('正文一致，已核验并更新同步基线')));
});

test('matching body in Synced legacy note gets a baseline without rewriting the note', async () => {
    const state = { root: legacyState() };
    const h = await createHarness({ state, pages: pages() });
    const original = note(bodyFor(h));
    h.vault.seed('Wolai/Root.md', original);
    const result = await syncPage(h, state);
    assert.equal(result.success, true);
    assert.equal(h.vault.readPath('Wolai/Root.md'), original);
    assert.ok(!h.vault.writes.includes('Wolai/Root.md'));
    assert.ok(result.nextState.root.localHash);
});

test('unknown baseline plus different body preserves local content and reports unknown, not proven conflict', async () => {
    const state = { root: legacyState({ localDirty: true }) };
    const h = await createHarness({ state, pages: pages() });
    const original = note('My unsynchronized changes', 'Conflict');
    h.vault.seed('Wolai/Root.md', original);
    const result = await syncPage(h, state);
    assert.equal(result.success, false);
    assert.equal(h.vault.readPath('Wolai/Root.md'), original);
    assert.equal(result.nextState.root, undefined);
    assert.equal(conflicts(h).length, 1);
    assert.ok(h.logs.some(log => log.message.includes('SYNC_BASELINE_UNKNOWN')));
    assert.ok(!h.logs.some(log => log.message.includes('SYNC_CONFLICT:')));
});

test('different content with known concurrent changes remains a real conflict; images are not downloaded first', async () => {
    const state = { root: legacyState({ localHash: 'old-local-hash', converterVersion: 2 }) };
    const remote = pages();
    remote.root.blocks = [...textBlocks, { id: 'img', type: 'image', media: { download_url: 'https://example.invalid/image.png' } }];
    const h = await createHarness({ state, pages: remote });
    const original = note('My local changes', 'Modified');
    h.vault.seed('Wolai/Root.md', original);
    const result = await syncPage(h, state);
    assert.equal(result.success, false);
    assert.equal(h.vault.readPath('Wolai/Root.md'), original);
    assert.ok(h.logs.some(log => log.message.includes('SYNC_CONFLICT:')));
    assert.ok(!h.logs.some(log => log.message.includes('images failed')));
    assert.ok(h.vault.readPath(conflicts(h)[0]).includes('https://example.invalid/image.png'));
});

test('known clean local baseline still accepts a remote edit', async () => {
    const original = note('Previous remote content');
    const h = await createHarness({ pages: pages() });
    const state = { root: legacyState({ localHash: h.manager.markdownParser.createHash(original), converterVersion: 2 }) };
    h.vault.seed('Wolai/Root.md', original);
    const result = await syncPage(h, state);
    assert.equal(result.success, true);
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).content, matter(note(bodyFor(h))).content);
    assert.equal(result.changes.size, 1);
});

test('matching Conflict must be reconciled even when remote metadata and resume markers match', async () => {
    const h = await createHarness({ pages: pages() });
    const original = note(bodyFor(h), 'Conflict');
    const state = { root: legacyState({ localHash: h.manager.markdownParser.createHash(original),
        localDirty: true, converterVersion: 2, remoteVersion: 2, remoteEditedAt: 200 }) };
    h.vault.seed('Wolai/Root.md', original);
    const resume = { startedAt: Date.now(), verifiedPageIds: { root: Date.now() } };
    const result = await syncPage(h, state, resume);
    assert.equal(result.success, true);
    assert.ok(h.requests.includes('blocks:root'));
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.sync_status, 'Synced');
});

test('repaired parent checkpoint survives a failed child and existing resume entries remain', async () => {
    const remote = { root: { blocks: [...textBlocks, { id: 'child', type: 'page', content: 'Child' }] },
        child: { error: 'offline child', blocks: [] } };
    const state = { root: legacyState({ localDirty: true }) };
    const h = await createHarness({ state, pages: remote });
    h.vault.seed('Wolai/Root.md', note(h.manager.renderPageMarkdown(remote.root.blocks, 'Root', 'root', ''), 'Conflict'));
    const resume = { startedAt: Date.now(), verifiedPageIds: Object.fromEntries(
        Array.from({ length: 189 }, (_, index) => [`verified-${index}`, Date.now()])) };
    const result = await syncPage(h, state, resume);
    assert.equal(result.success, false);
    assert.ok(h.requests.includes('metadata:child'));
    const persisted = await h.manager.loadIncrementalState();
    assert.equal(persisted.root.localDirty, false);
    assert.ok(persisted.root.localHash);
    assert.equal(Object.keys(resume.verifiedPageIds).length, 190);
    assert.ok(resume.verifiedPageIds.root);
    const savedResume = JSON.parse(h.vault.readPath(`${runtimeDir}/wolai-resume-state.json`));
    assert.ok(savedResume.verifiedPageIds['verified-188']);
    h.pages.child = { blocks: [{ id: 'child-text', type: 'text', content: 'Child content' }] };
    h.requests.length = 0;
    const resumed = await syncPage(h, persisted, resume);
    assert.equal(resumed.success, true);
    assert.ok(!h.requests.includes('metadata:root'));
    assert.ok(h.requests.includes('blocks:child'));
    assert.equal(h.vault.files.has('Wolai/Root/Child.md'), true);
});

test('body comparison ignores sync metadata/line endings, but not indentation or hard breaks', async () => {
    const h = await createHarness();
    assert.equal(h.manager.markdownBodiesEqual(note('line\r\nnext\r\n', 'Conflict'), '\nline\nnext\n'), true);
    assert.equal(h.manager.markdownBodiesEqual(note('line  \nnext'), 'line\nnext'), false);
    assert.equal(h.manager.markdownBodiesEqual(note('    code'), 'code'), false);
    assert.equal(h.manager.markdownBodiesEqual(note('$x+1$'), '$x+2$'), false);
});

test('outbound content already equal only refreshes baseline and does not PUT Wolai', async () => {
    const h = await createHarness({ pages: pages() });
    const original = note(bodyFor(h), 'Modified');
    h.vault.seed('Wolai/Root.md', original);
    h.vault.seed(`${runtimeDir}/wolai-incremental-state.json`, JSON.stringify({
        root: legacyState({ localHash: 'older-local-hash', converterVersion: 2 })
    }));
    assert.equal(await h.manager.syncFile('Wolai/Root.md'), true);
    assert.deepEqual(conflicts(h), []);
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.sync_status, 'Synced');
    assert.ok(h.logs.some(log => log.message.includes('无需上传或生成冲突')));
});

test('local edit during remote verification is preserved and never checkpointed as synchronized', async () => {
    const state = { root: legacyState() };
    const h = await createHarness({ state, pages: pages() });
    h.vault.seed('Wolai/Root.md', note(bodyFor(h), 'Conflict'));
    const newer = note('Typed while waiting', 'Modified');
    h.manager.wolaiAPI.getAllPageBlocks = async () => {
        h.vault.seed('Wolai/Root.md', newer);
        return textBlocks;
    };
    const result = await syncPage(h, state);
    assert.equal(result.success, false);
    assert.equal(h.vault.readPath('Wolai/Root.md'), newer);
    assert.equal(result.nextState.root, undefined);
    assert.ok(h.logs.some(log => log.message.includes('SYNC_LOCAL_CHANGED')));
});

test('matching legacy image embeds use the same local pictures paths and reuse cached images', async () => {
    const remote = pages();
    remote.root.blocks = [...textBlocks, { id: 'img', type: 'image', version: 4, edited_at: 400,
        media: { download_url: 'https://example.invalid/image.png?signature=changed' } }];
    const imagePath = 'Wolai/Root/pictures/img.png';
    const state = { root: legacyState({ localDirty: true,
        images: { img: { version: 4, editedAt: 400, path: imagePath } } }) };
    const h = await createHarness({ state, pages: remote });
    const body = h.manager.renderPageMarkdown(remote.root.blocks, 'Root', 'root', '');
    assert.ok(body.includes(`![[${imagePath}]]`));
    h.vault.seed(imagePath, 'existing-image-bytes');
    h.vault.seed('Wolai/Root.md', note(body, 'Conflict'));
    const result = await syncPage(h, state);
    assert.equal(result.success, true);
    assert.equal(result.nextState.root.localDirty, false);
    assert.equal(h.vault.readPath(imagePath), 'existing-image-bytes');
    assert.ok(!h.vault.writes.includes(imagePath));
    assert.deepEqual(conflicts(h), []);
});

test('reconciled baseline enables fast skip on the following ordinary incremental run', async () => {
    const state = { root: legacyState({ converterVersion: 2, remoteVersion: 2, remoteEditedAt: 200 }) };
    const h = await createHarness({ state, pages: pages() });
    h.vault.seed('Wolai/Root.md', note(bodyFor(h)));
    const first = await syncPage(h, state);
    assert.equal(first.success, true);
    assert.ok(h.requests.includes('blocks:root'), 'missing baseline must not be silently fast-skipped');
    const persisted = await h.manager.loadIncrementalState();
    h.requests.length = 0;
    const second = await syncPage(h, persisted);
    assert.equal(second.success, true);
    assert.deepEqual(h.requests, ['metadata:root']);
    assert.equal(second.changes.size, 0);
});
