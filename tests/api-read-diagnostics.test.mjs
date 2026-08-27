import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = buildSync({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['src/WolaiAPI.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian']
}).outputFiles[0].text;
function harness(fetch) {
    const compiled = { exports: {} };
    new Function('module', 'exports', 'require', 'window', 'fetch', source)(compiled, compiled.exports,
        () => ({ Notice: class {} }), { setTimeout, clearTimeout }, fetch);
    const logs = [];
    const api = new compiled.exports.WolaiAPI('private-app-id', 'private-secret', (l,m)=>logs.push(m));
    api.requestTimeoutMs = 5;
    api.maxRateLimitRetries = 1;
    api.waitForRequestSlot = async () => {};
    api.waitCancellable = async () => {};
    return { api, logs };
}
function stalledBody(signal) {
    return { status: 200, statusText: 'OK', headers: new Headers(),
        arrayBuffer: () => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }) };
}

test('request logs include endpoint, status and duration but omit credentials, queries and body', async () => {
    const {api,logs} = harness(async () => new Response('{"data":42}'));
    const response = await api.fetchWithRateLimit('https://openapi.wolai.com/v1/blocks/test/children?start_cursor=private-cursor', {
        headers: {Authorization:'private-token'}, body:'private-body'
    });
    assert.equal((await response.json()).data,42);
    assert.ok(logs.some(l => /API #1 GET \/v1\/blocks\/test\/children 开始/.test(l)));
    assert.ok(logs.some(l => /HTTP 200，\d+ms/.test(l)));
    assert.ok(!logs.join('\n').includes('private-'));
});

test('GET deadline covers a stalled body after headers and retries boundedly', async () => {
    let calls=0;
    const {api,logs}=harness(async (url,init)=>++calls===1?stalledBody(init.signal):new Response('{"ok":true}'));
    assert.deepEqual(await (await api.fetchWithRateLimit('https://openapi.wolai.com/v1/blocks/test')).json(),{ok:true});
    assert.equal(calls,2);
    assert.ok(logs.some(l=>l.includes('超时')));
    assert.equal(api.activeControllers.size,0);
});

test('uncertain mutation response body is not replayed', async () => {
    let calls=0;
    const {api,logs}=harness(async (url,init)=>{calls++;return stalledBody(init.signal);});
    await assert.rejects(api.fetchWithRateLimit('https://openapi.wolai.com/v1/blocks/test',{method:'PUT'}));
    assert.equal(calls,1);
    assert.ok(logs.some(l=>l.includes('不自动重放')));
});

test('stop aborts a stalled body without treating cancellation as a retryable timeout', async () => {
    let calls=0;
    const h=harness(async (url,init)=>{calls++;setTimeout(()=>h.api.cancelPendingRequests(),1);return stalledBody(init.signal);});
    h.api.requestTimeoutMs=1000;
    await assert.rejects(h.api.fetchWithRateLimit('https://openapi.wolai.com/v1/blocks/test'),/WOLAI_SYNC_CANCELLED/);
    assert.equal(calls,1);
    assert.equal(h.api.activeControllers.size,0);
});

test('API integration restores a read journal in a new instance and rechecks root revision',async()=>{
    const files=new Map(),calls=[];
    const store={read:async id=>files.get(id)||null,reset:async(id,t)=>files.set(id,t),
        append:async(id,t)=>files.set(id,files.get(id)+t),remove:async id=>files.delete(id)};
    let offline=true;
    const fetch=async url=>{
        const path=new URL(url).pathname;calls.push(path);
        if(path==='/v1/blocks/branch/children'&&offline)throw new TypeError('offline');
        const data=path==='/v1/blocks/root/children'
            ?[{id:'branch',type:'text',version:2,edited_at:200,children:{ids:['leaf']}}]
            :path==='/v1/blocks/branch/children'?[{id:'leaf',type:'text',content:'hello'}]
                :{id:'root',version:3,edited_at:300};
        return new Response(JSON.stringify({data,has_more:false}));
    };
    const first=harness(fetch).api;
    first.pageReadStore=store;first.getValidToken=async()=>'test-token';
    const options={resume:true,metadata:{version:3,edited_at:300}};
    await assert.rejects(first.getAllPageBlocks('root',options),/offline/);
    assert.ok(files.has('root'));
    offline=false;calls.length=0;
    const second=harness(fetch).api;
    second.pageReadStore=store;second.getValidToken=async()=>'test-token';
    assert.deepEqual((await second.getAllPageBlocks('root',options)).map(b=>b.id),['branch','leaf']);
    assert.deepEqual(calls,['/v1/blocks/branch/children','/v1/blocks/root']);
    await second.clearPageReadCheckpoint('root');
    assert.equal(files.has('root'),false);
});

test('whole-table integration counts actual HTTP attempts including retries and never fetches cells',async()=>{
    for(const retry of [false,true]){
        const calls=[];let attempts=0,quota=0;
        const shallow={id:'table',type:'table',version:2,edited_at:200,children:{ids:['cell1','cell2']}};
        const detail={...shallow,table_setting:{has_header:false,column_widths:[100,100]},
            table_content:[[{content:'001'},{content:[{title:'|x|',type:'equation'}]}]]};
        const {api}=harness(async url=>{
            const path=new URL(url).pathname;calls.push(path);
            if(path==='/v1/blocks/root/children')return new Response(JSON.stringify({data:[shallow],has_more:false}));
            assert.equal(path,'/v1/blocks/table');
            if(retry&&++attempts===1)return new Response('',{status:503});
            return new Response(JSON.stringify({data:detail}));
        });
        api.getValidToken=async()=>'test-token';api.beforeRequest=async()=>{quota++;};
        assert.deepEqual(await api.getAllPageBlocks('root'),[detail]);
        assert.equal(quota,retry?3:2);assert.equal(quota,calls.length);
        assert.deepEqual(calls,['/v1/blocks/root/children',...Array(retry?2:1).fill('/v1/blocks/table')]);
    }
});
