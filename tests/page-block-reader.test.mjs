import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const compiled = { exports: {} };
const source = buildSync({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/PageBlockReader.ts'], bundle: true, write: false, platform: 'node', format: 'cjs'
}).outputFiles[0].text;
new Function('module', 'exports', source)(compiled, compiled.exports);
const { PageBlockReader } = compiled.exports;
const metadata = { version: 3, edited_at: 300 };
const block = (id, children) => ({ id, type: 'text', content: id, version: 2, edited_at: 200,
    ...(children ? { children: { ids: children } } : {}) });
const batch = (blocks, nextCursor) => ({ blocks, hasMore: Boolean(nextCursor), nextCursor });

function fixture(pages) {
    const files = new Map();
    const calls = [], logs = [], writes = [], progress = [];
    let cancelled = false;
    const store = {
        read: async id => files.get(id) || null,
        reset: async (id, text) => { files.set(id, text); writes.push('reset'); },
        append: async (id, text) => { files.set(id, files.get(id) + text); writes.push('append'); },
        remove: async id => { files.delete(id); writes.push('remove'); }
    };
    const options = { metadata, resume: true, onProgress: m => progress.push(m) };
    const reader = (scope = 'account') => new PageBlockReader(async (id, cursor) => {
        calls.push(`${id}:${cursor || ''}`);
        const value = pages[`${id}:${cursor || ''}`];
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`Missing fixture ${id}:${cursor || ''}`);
        return structuredClone(value);
    }, (level, message) => logs.push({ level, message }), () => {
        if (cancelled) throw new Error('WOLAI_SYNC_CANCELLED');
    }, store, scope, async () => metadata);
    return { files, calls, logs, writes, reader, options, pages, progress,
        cancel: () => { cancelled = true; } };
}

test('interrupted page resumes persisted pagination and nested blocks after reader recreation', async () => {
    const f = fixture({ 'root:': batch([block('a', ['a1']), block('b')], 'cursor-2'),
        'root:cursor-2': batch([block('c')]), 'a:': new Error('offline') });
    await assert.rejects(f.reader().read('root', f.options), /offline/);
    assert.equal(f.writes.filter(x => x === 'append').length, 2);
    f.pages['a:'] = batch([block('a1')]);
    f.calls.length = 0;
    const out = await f.reader().read('root', f.options);
    assert.deepEqual(f.calls, ['a:']);
    assert.deepEqual(out.map(b => b.id), ['a', 'a1', 'b', 'c']);
    assert.equal(out[1].depth, 1);
    assert.equal(out[1].parentBlockId, 'a');
    assert.equal(out[0].fromReadCheckpoint, true);
    assert.ok(f.logs.some(l => l.message.includes('复用断点')));
    assert.ok(f.progress.some(m => m.includes('复用 2 批')));
});

test('failure on the next cursor never re-fetches earlier successful pagination', async () => {
    const f = fixture({ 'root:': batch([block('a')], 'next'), 'root:next': new Error('quota wait cancelled') });
    await assert.rejects(f.reader().read('root', f.options));
    f.pages['root:next'] = batch([block('b')]);
    f.calls.length = 0;
    assert.equal((await f.reader().read('root', f.options)).length, 2);
    assert.deepEqual(f.calls, ['root:next']);
});

test('torn trailing journal record does not swallow future completed batches', async () => {
    const f = fixture({ 'root:': batch([block('a')], 'next'), 'root:next': new Error('offline') });
    await assert.rejects(f.reader().read('root', f.options));
    f.files.set('root', f.files.get('root') + '{"kind":"batch"');
    f.pages['root:next'] = batch([block('b')]);
    await f.reader().read('root', f.options);
    f.calls.length = 0;
    await f.reader().read('root', f.options);
    assert.deepEqual(f.calls, []);
});

for (const reason of ['version', 'expired', 'account']) {
    test(`stale read snapshot is not reused: ${reason}`, async () => {
        const f = fixture({ 'root:': batch([block('a')]) });
        await f.reader().read('root', f.options);
        const lines = f.files.get('root').split('\n');
        const header = JSON.parse(lines[0]);
        if (reason === 'version') header.version--;
        if (reason === 'expired') header.startedAt -= 25 * 60 * 60 * 1000;
        lines[0] = JSON.stringify(header); f.files.set('root', lines.join('\n'));
        f.calls.length = 0;
        await f.reader(reason === 'account' ? 'other-account' : 'account').read('root', f.options);
        assert.deepEqual(f.calls, ['root:']);
    });
}

test('normal/outbound read never uses a persisted inbound snapshot', async () => {
    const f = fixture({ 'root:': batch([block('old')]) });
    await f.reader().read('root', f.options);
    f.pages['root:'] = batch([block('new')]);
    f.calls.length = 0;
    assert.deepEqual((await f.reader().read('root')).map(b => b.id), ['new']);
    assert.deepEqual(f.calls, ['root:']);
});

test('shared references and overlapping pages are de-duplicated without flattening child pages', async () => {
    const f = fixture({ 'root:': batch([block('a', ['shared']), block('b', ['shared']),
        { id: 'childpage', type: 'page', children: { ids: ['never-read'] } }], 'next'),
    'root:next': batch([block('b', ['shared'])]),
    'a:': batch([block('shared', ['leaf'])]), 'b:': batch([block('shared', ['leaf'])]),
    'shared:': batch([block('leaf')]) });
    const out = await f.reader().read('root', f.options);
    assert.equal(out.filter(b => b.id === 'shared').length, 1);
    assert.equal(f.calls.filter(c => c === 'shared:').length, 1);
    assert.ok(!f.calls.some(c => c.startsWith('childpage:')));
    assert.ok(f.logs.some(l => l.message.includes('去重')));
});

test('cycle is reported before a second request to the same ancestor', async () => {
    const f = fixture({ 'root:': batch([block('a', ['b'])]),
        'a:': batch([block('b', ['a'])]), 'b:': batch([block('a', ['b'])]) });
    await assert.rejects(f.reader().read('root', f.options), /PAGE_BLOCK_CYCLE/);
    assert.deepEqual(f.calls, ['root:', 'a:', 'b:']);
    assert.equal(f.files.has('root'), false);
});

for (const reason of ['same-cursor', 'no-new-ids', 'missing-cursor']) {
    test(`malformed pagination is bounded and not marked complete: ${reason}`, async () => {
        const pages = { 'root:': batch([block('a')], 'next'), 'root:next': batch([block('b')]) };
        if (reason === 'same-cursor') pages['root:next'] = batch([block('b')], 'next');
        if (reason === 'no-new-ids') pages['root:next'] = batch([block('a')], 'another');
        if (reason === 'missing-cursor') pages['root:'] = { blocks: [block('a')], hasMore: true };
        const f = fixture(pages);
        await assert.rejects(f.reader().read('root', f.options), /cursor|NO_PROGRESS/);
        assert.ok(f.calls.length <= 2);
    });
}

test('full batch can safely use final block ID when next_cursor is omitted', async () => {
    const f = fixture({ 'root:': { blocks: Array.from({length:200},(_,i)=>block(`b${i}`)), hasMore:true },
        'root:b199': batch([block('last')]) });
    assert.equal((await f.reader().read('root', f.options)).length, 201);
});

test('changed root during resumed read invalidates snapshot instead of returning mixed data', async () => {
    const f = fixture({ 'root:': batch([block('a')]) });
    await f.reader().read('root', f.options);
    const r = f.reader();
    r.verifyRevision = async () => ({ version: 4, edited_at: 400 });
    await assert.rejects(r.read('root', f.options), /PAGE_CHANGED_DURING_READ/);
    assert.equal(f.files.has('root'), false);
});

test('cancellation stops reading cached branches too', async () => {
    const f = fixture({ 'root:': batch([block('a')]) });
    await f.reader().read('root', f.options);
    f.calls.length = 0; f.cancel();
    await assert.rejects(f.reader().read('root', f.options), /CANCELLED/);
    assert.deepEqual(f.calls, []);
});

test('depth and batch bounds stop malformed ever-growing graphs', async () => {
    const f = fixture({ 'root:': batch([block('a', ['b'])]),
        'a:': batch([block('b', ['c'])]), 'b:': batch([block('c')]) });
    const r = f.reader(); r.maxDepth = 1;
    await assert.rejects(r.read('root', f.options), /PAGE_DEPTH_LIMIT/);
    const f2 = fixture({ 'root:': batch([block('a')], 'n'), 'root:n': batch([block('b')], 'm') });
    const r2 = f2.reader(); r2.maxBatches = 2;
    await assert.rejects(r2.read('root', f2.options), /PAGE_READ_LIMIT/);
});

test('hundreds of already-read nested branches survive an interrupted large page', async () => {
    const parents=Array.from({length:420},(_,i)=>block(`parent-${i}`,[`leaf-${i}`]));
    const pages={'root:':batch(parents.slice(0,200),'p2'),'root:p2':batch(parents.slice(200,400),'p3'),
        'root:p3':batch(parents.slice(400))};
    for(let i=0;i<420;i++)pages[`parent-${i}:`]=batch([block(`leaf-${i}`)]);
    pages['parent-413:']=new Error('interrupted');
    const f=fixture(pages);
    await assert.rejects(f.reader().read('root',f.options),/interrupted/);
    pages['parent-413:']=batch([block('leaf-413')]);
    f.calls.length=0;
    const blocks=await f.reader().read('root',f.options);
    assert.equal(blocks.length,840);
    assert.equal(f.calls.length,7);
    assert.ok(f.calls.every(c=>Number(c.match(/parent-(\d+)/)[1])>=413));
});
