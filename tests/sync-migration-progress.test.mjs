import test from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';
import { createHarness, legacyState, syncPage, runtimeDir } from './helpers/sync-harness.mjs';

const note = (body, id = 'root', data = {}) => matter.stringify(body, {
    sync_status: 'Synced', wolai_id: id, last_sync: '2026-01-01', ...data
});
const mathBlocks = [
    { id: 'intro', type: 'text', content: 'Price $5; keep literal dollars.' },
    { id: 'formula', type: 'block_equation', content: 'f(x)=\\frac{1}{1+e^{-x}}' },
    { id: 'inline', type: 'text', content: ['Probability ', { type: 'equation', title: 'p_i' }, '.'] },
    { id: 'old-equation', type: 'equation', content: 'y=x+1' },
    { id: 'code', type: 'code', content: 'echo "$USER"\n$$\nx+1\n$$', language: 'sh' }
];
const mathState = () => ({ root: legacyState({ remoteVersion: 2, remoteEditedAt: 200 }) });
const backups = h => [...h.vault.contents.keys()].filter(p => p.includes('/math-migration-backups/'));
const conflicts = h => [...h.vault.contents.keys()].filter(p => p.startsWith('Wolai/_conflicts/'));

test('legacy formula rendering matches pre-upgrade syntax without touching literal/code dollars', async () => {
    const h = await createHarness();
    const legacy = h.manager.renderPageMarkdown(mathBlocks, 'Root', 'root', '', true, true);
    assert.ok(legacy.includes('\nf(x)=\\frac{1}{1+e^{-x}}\n'));
    assert.ok(legacy.includes('Probability p_i.'));
    assert.ok(legacy.includes('$$\ny=x+1\n$$'), 'old equation type already used delimiters');
    assert.ok(legacy.includes('Price $5;'));
    assert.ok(legacy.includes('```sh\necho "$USER"\n$$\nx+1\n$$\n```'));
});

test('verified legacy formulas migrate with exact backup, properties and cached pictures preserved', async () => {
    const imagePath = 'Wolai/Root/pictures/image.png';
    const blocks = [...mathBlocks, { id: 'image', type: 'image', version: 4, edited_at: 400,
        media: { download_url: 'https://example.invalid/image.png' } }];
    const state = mathState();
    state.root.images = { image: { version: 4, editedAt: 400, path: imagePath } };
    const h = await createHarness({ state, pages: { root: { blocks } } });
    h.vault.seed(imagePath, 'cached-image');
    const original = note(h.manager.renderPageMarkdown(blocks, 'Root', 'root', '', true, true), 'root', { tags: ['math'], custom: 'keep' });
    h.vault.seed('Wolai/Root.md', original);
    const resume = { startedAt: Date.now(), verifiedPageIds: {} };
    const first = await syncPage(h, state, resume);
    assert.equal(first.success, true);
    assert.equal(first.changes.size, 1);
    assert.equal(backups(h).length, 1);
    assert.equal(h.vault.readPath(backups(h)[0]), original);
    const after = matter(h.vault.readPath('Wolai/Root.md'));
    assert.equal(after.content.trim(), h.manager.renderPageMarkdown(blocks, 'Root', 'root', ''));
    assert.deepEqual(after.data.tags, ['math']);
    assert.equal(after.data.custom, 'keep');
    assert.deepEqual(conflicts(h), []);
    assert.ok(!h.vault.writes.includes(imagePath));
    assert.equal(first.nextState.root.converterVersion, 2);
    assert.ok(first.nextState.root.localHash);
    assert.ok(resume.verifiedPageIds.root);
    assert.ok(h.logs.some(l => l.message.includes('迁移旧版公式格式')));
    h.requests.length = 0;
    const second = await syncPage(h, await h.manager.loadIncrementalState(), resume);
    assert.equal(second.success, true);
    assert.equal(second.changes.size, 0);
    assert.deepEqual(h.requests, []);
    assert.equal(backups(h).length, 1);
});

for (const scenario of ['changed-text', 'changed-formula', 'current-converter', 'remote-changed', 'explicit-dirty', 'wrong-image-path']) {
    test(`formula migration refuses unsafe case: ${scenario}`, async () => {
        const state = mathState();
        const h = await createHarness({ state, pages: { root: { blocks: mathBlocks } } });
        let body = h.manager.renderPageMarkdown(mathBlocks, 'Root', 'root', '', true, true);
        let status = 'Synced';
        if (scenario === 'changed-text') body += '\nMy local addition';
        if (scenario === 'changed-formula') body = body.replace('e^{-x}', 'e^{-2x}');
        if (scenario === 'current-converter') state.root.converterVersion = 2;
        if (scenario === 'remote-changed') state.root.remoteVersion = 1;
        if (scenario === 'explicit-dirty') status = 'Modified';
        if (scenario === 'wrong-image-path') body += '\n![[my-image.png]]';
        const original = note(body, 'root', { sync_status: status });
        h.vault.seed('Wolai/Root.md', original);
        const result = await syncPage(h, state);
        assert.equal(result.success, false);
        assert.equal(h.vault.readPath('Wolai/Root.md'), original);
        assert.equal(backups(h).length, 0);
        assert.equal(conflicts(h).length, 1);
        assert.equal(result.nextState.root, undefined);
    });
}

test('backup failure or an edit during backup cannot overwrite the local note', async () => {
    for (const type of ['failure', 'edit']) {
        const state = mathState();
        const h = await createHarness({ state, pages: { root: { blocks: mathBlocks } } });
        const original = note(h.manager.renderPageMarkdown(mathBlocks, 'Root', 'root', '', true, true));
        h.vault.seed('Wolai/Root.md', original);
        const write = h.vault.adapter.write;
        h.vault.adapter.write = async (path, content) => {
            if (path.includes('/math-migration-backups/')) {
                if (type === 'failure') throw new Error('disk full');
                h.vault.seed('Wolai/Root.md', original + '\nUser typed during backup');
            }
            await write(path, content);
        };
        const result = await syncPage(h, state);
        assert.equal(result.success, false);
        assert.equal(result.nextState.root, undefined);
        assert.equal(h.vault.readPath('Wolai/Root.md'), type === 'failure' ? original : original + '\nUser typed during backup');
        assert.ok(!h.vault.writes.includes('Wolai/Root.md'));
    }
});

const tree = () => ({
    root: { blocks: [{ id: 'bad', type: 'page', content: 'Bad' }, { id: 'good', type: 'page', content: 'Good' }] },
    bad: { blocks: [{ id: 'bad-text', type: 'text', content: 'Remote body' }] },
    good: { blocks: [{ id: 'good-text', type: 'text', content: 'Good body' }] }
});

for (const path of ['fresh', 'fast-skip', 'resume']) {
    test(`one conflicting child does not block later siblings (${path})`, async () => {
        const h = await createHarness({ pages: tree() });
        const state = {};
        const resume = { startedAt: Date.now(), verifiedPageIds: {} };
        if (path !== 'fresh') {
            const rootNote = note(h.manager.renderPageMarkdown(h.pages.root.blocks, 'Root', 'root', ''));
            h.vault.seed('Wolai/Root.md', rootNote);
            state.root = legacyState({ converterVersion: 2, remoteVersion: 2, remoteEditedAt: 200,
                localHash: h.manager.markdownParser.createHash(rootNote), children: [
                    { pageId: 'bad', title: 'Bad', relativeDir: 'Root' },
                    { pageId: 'good', title: 'Good', relativeDir: 'Root' }
                ] });
            if (path === 'resume') resume.verifiedPageIds.root = Date.now();
        }
        const local = note('Local changes', 'bad');
        h.vault.seed('Wolai/Root/Bad.md', local);
        const result = await syncPage(h, state, resume);
        assert.equal(result.success, false);
        assert.ok(h.vault.files.has('Wolai/Root/Good.md'));
        assert.equal(h.vault.readPath('Wolai/Root/Bad.md'), local);
        assert.equal(h.manager.inboundFailures.size, 1);
        assert.ok(!h.logs.some(l => /Failed to (resume|check|sync) child/.test(l.message)));
        assert.ok(resume.verifiedPageIds.good);
        assert.ok(!resume.verifiedPageIds.bad);
        if (path === 'resume') assert.ok(!h.requests.includes('metadata:root'));
        if (path === 'fast-skip') assert.ok(!h.requests.includes('blocks:root'));
    });
}

test('a conflicted root still visits discovered descendants without checkpointing the root', async () => {
    const h = await createHarness({ pages: tree() });
    h.vault.seed('Wolai/Root.md', note('Root local addition'));
    const result = await syncPage(h, {});
    assert.equal(result.success, false);
    assert.equal(result.nextState.root, undefined);
    assert.ok(result.nextState.bad);
    assert.ok(result.nextState.good);
    assert.equal(h.manager.inboundFailures.size, 1);
});

test('partial run keeps resume/journal, never cleans files or claims no changes; next run resumes', async () => {
    const h = await createHarness({ pages: tree() });
    h.manager.settings.safeCleanup = true;
    h.vault.seed('Wolai/Root/Bad.md', note('Local edits', 'bad'));
    const progress = [];
    h.manager.addProgressListener((percent, message) => progress.push({ percent, message }));
    const first = await h.manager.incrementalSync();
    assert.equal(first.status, 'partial');
    assert.equal(first.failedPages, 1);
    assert.equal(first.wolaiToObsidian, 2);
    assert.ok(h.vault.files.has(`${runtimeDir}/wolai-resume-state.json`));
    assert.ok(h.vault.files.has(`${runtimeDir}/wolai-incremental-journal.jsonl`));
    assert.ok(progress.filter(p => p.message.includes('已发现')).every(p => p.percent === null));
    assert.ok(!progress.some(p => p.percent === 100));
    assert.ok(h.logs.some(l => l.message.includes('未完成页面：Wolai/Root/Bad.md')));
    assert.ok(!h.logs.some(l => l.message.includes('没有检测到增量')));
    const journal = h.vault.readPath(`${runtimeDir}/wolai-incremental-journal.jsonl`);
    const full = await h.manager.fullSync();
    assert.equal(full.status, 'partial'); // MemoryVault.trash would throw if cleanup ran.
    assert.ok(h.vault.readPath(`${runtimeDir}/wolai-incremental-journal.jsonl`).startsWith(journal));
    h.vault.seed('Wolai/Root/Bad.md', note('# Bad\n\nRemote body', 'bad'));
    h.requests.length = 0;
    const retry = await h.manager.incrementalSync();
    assert.equal(retry.status, 'no_changes');
    assert.deepEqual(h.requests, ['metadata:bad', 'blocks:bad']);
    assert.ok(!h.vault.files.has(`${runtimeDir}/wolai-resume-state.json`));
    assert.ok(!h.vault.files.has(`${runtimeDir}/wolai-incremental-journal.jsonl`));
});

test('tree discovery never publishes estimated 94% and waiting keeps indeterminate progress', async () => {
    const h = await createHarness();
    const events = [];
    h.manager.addProgressListener((percent, message) => events.push({ percent, message }));
    const ctx = { seen: new Set(), completed: 134, total: 142, mode: 'incremental' };
    h.manager.reportPageProgress(ctx, 'First', 'Root');
    ctx.total = 249; ctx.completed = 193;
    h.manager.reportPageProgress(ctx, 'Next', 'Root');
    h.manager.reportProgress(h.manager.currentProgress, '等待额度');
    assert.deepEqual(events.map(p => p.percent), [null, null, null]);
    assert.ok(events[1].message.includes('已处理 193 / 已发现 249'));
    assert.ok(h.logs.every(l => !l.message.includes('%')));
});

test('cancellation is not swallowed as an isolated page failure', async () => {
    const h = await createHarness({ pages: tree() });
    const read = h.manager.wolaiAPI.getAllPageBlocks;
    h.manager.wolaiAPI.getAllPageBlocks = async id => {
        if (id === 'bad') throw new Error('WOLAI_SYNC_CANCELLED');
        return await read(id);
    };
    const result = await h.manager.incrementalSync();
    assert.equal(result.status, 'cancelled');
    assert.ok(!h.requests.includes('metadata:good'));
    assert.equal(h.manager.inboundFailures.size, 0);
});

test('failed database metadata does not abort configured pages or clear their checkpoints', async () => {
    const h = await createHarness({ pages: { root: { blocks: [] }, bad: { error: 'offline' } } });
    h.manager.wolaiAPI.getAllDatabaseContent = async () => [
        { page_id: 'bad', data: { '标题': { value: 'Bad' }, '同步状态': { value: 'Pending' } } }
    ];
    h.manager.findImportedFileByWolaiId = async () => ({ lastSync: 1 });
    const result = await h.manager.incrementalSync();
    assert.equal(result.status, 'partial');
    assert.equal(result.failedPages, 1);
    assert.ok(h.vault.files.has('Wolai/Root.md'));
    assert.ok(h.vault.files.has(`${runtimeDir}/wolai-resume-state.json`));
});

test('failed upload prevents cleanup/finalization even if all configured imports succeed', async () => {
    const h = await createHarness({ pages: { root: { blocks: [] } } });
    h.manager.settings.safeCleanup = true;
    h.vault.seed('Wolai/Upload.md', note('Upload', 'upload'));
    h.manager.prepareLocalFileForSync = async p => p === 'Wolai/Upload.md';
    h.manager.syncObsidianToWolai = async () => false;
    const result = await h.manager.fullSync();
    assert.equal(result.status, 'partial');
    assert.equal(result.failedPages, 1);
    assert.ok(h.vault.files.has(`${runtimeDir}/wolai-incremental-journal.jsonl`));
});

test('formula-only legacy note without any page state migrates after backup', async () => {
    const h=await createHarness({pages:{root:{blocks:mathBlocks}}});
    const original=note(h.manager.renderPageMarkdown(mathBlocks,'Root','root','',true,true),'root',{custom:'keep'});
    h.vault.seed('Wolai/Root.md',original);
    const result=await syncPage(h,{});
    assert.equal(result.success,true);
    assert.equal(h.vault.readPath(backups(h)[0]),original);
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.custom,'keep');
    assert.ok(result.nextState.root.localHash);
    assert.equal(conflicts(h).length,0);
});

for(const change of ['text','formula','no-provenance','modified']) {
    test(`no-state migration does not bypass real edits or missing provenance: ${change}`,async()=>{
        const h=await createHarness({pages:{root:{blocks:mathBlocks}}});
        let body=h.manager.renderPageMarkdown(mathBlocks,'Root','root','',true,true);
        if(change==='text')body+='\nMy addition';
        if(change==='formula')body=body.replace('e^{-x}','e^{-9x}');
        const original=note(body,'root',change==='no-provenance'?{last_sync:''}:change==='modified'?{sync_status:'Modified'}:{});
        h.vault.seed('Wolai/Root.md',original);
        assert.equal((await syncPage(h,{})).success,false);
        assert.equal(h.vault.readPath('Wolai/Root.md'),original);
        assert.equal(backups(h).length,0);
    });
}

test('page read cache is cleared only after the page baseline is durable',async()=>{
    const h=await createHarness({pages:{root:{blocks:mathBlocks}}});
    let cleared=false;
    h.manager.wolaiAPI.clearPageReadCheckpoint=async id=>{
        assert.ok((await h.manager.loadIncrementalState())[id]?.localHash);
        cleared=true;
    };
    assert.equal((await syncPage(h,{})).success,true);
    assert.equal(cleared,true);
});

test('runtime page read store supports backup recovery and rejects path traversal',async()=>{
    const h=await createHarness();
    const store=h.manager.createPageReadStore();
    await store.reset('root','header\n');
    await store.append('root','batch\n');
    assert.equal(await store.read('root'),'header\nbatch\n');
    const file=`${runtimeDir}/wolai-block-checkpoints/root.jsonl`;
    await h.vault.adapter.rename(file,`${file}.bak`);
    assert.equal(await store.read('root'),'header\nbatch\n');
    await store.append('root','resumed\n');
    assert.equal(await store.read('root'),'header\nbatch\nresumed\n');
    await assert.rejects(store.reset('../data','bad'),/Invalid page/);
    await store.remove('root');
    assert.equal(await store.read('root'),null);
});

test('unchanged cached pictures need neither URL refresh nor another download',async()=>{
    const h=await createHarness();
    const image={id:'img',type:'image',version:2,edited_at:200,fromReadCheckpoint:true,
        media:{download_url:'https://example.invalid/expired.png'}};
    const path='Wolai/Root/pictures/img.png';
    h.vault.seed(path,'cached-bytes');
    const result=await h.manager.downloadPageImages([image],'Root','',new Set(),'incremental',{
        img:{version:2,editedAt:200,path}
    });
    assert.equal(result.changed,false);
    assert.deepEqual(h.requests,[]);
});

test('changed cached image invalidates page read journal and does not overwrite the note',async()=>{
    const h=await createHarness({pages:{
        root:{blocks:[{id:'img',type:'image',version:2,edited_at:200,fromReadCheckpoint:true,
            media:{download_url:'https://example.invalid/expired.png'}}]},
        img:{blocks:[],metadata:{version:3,edited_at:300,media:{download_url:'https://example.invalid/current.png'}}}
    }});
    let cleared=false;
    h.manager.wolaiAPI.clearPageReadCheckpoint=async id=>{assert.equal(id,'root');cleared=true;};
    const result=await syncPage(h,{});
    assert.equal(result.success,false);
    assert.equal(cleared,true);
    assert.ok(!h.vault.files.has('Wolai/Root.md'));
    assert.equal(result.nextState.root,undefined);
});
