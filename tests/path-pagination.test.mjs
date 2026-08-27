import test from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness, legacyState, syncPage, runtimeDir } from './helpers/sync-harness.mjs';

const compile = file => {
    const source = buildSync({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
        entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text;
    const mod = { exports: {} }; new Function('module','exports',source)(mod,mod.exports); return mod.exports;
};
const {PageBlockReader} = compile('src/PageBlockReader.ts');
const {PagePaths} = compile('src/PagePaths.ts');
const note = (body,id='root',data={}) => matter.stringify(body,{sync_status:'Synced',wolai_id:id,last_sync:'2026-01-01',...data});
const text = (id,content=id) => ({id,type:'text',version:1,edited_at:100,content});
const page = (id,title) => ({id,type:'page',content:title});

test('same titles keep existing owner, persist other path, and route links, descendants and pictures separately',async()=>{
    const pages={root:{blocks:[page('second0002','Same'),page('first0001','Same')]},
        first0001:{blocks:[text('a','First')]},second0002:{blocks:[text('b','Second'),page('child','Child')]},
        child:{blocks:[text('c','Child body')]}};
    const h=await createHarness({pages});
    const existing=note('# Same\n\nFirst','first0001');h.vault.seed('Wolai/Root/Same.md',existing);
    const first=await syncPage(h,{});
    assert.equal(first.success,true);
    const alternate='Wolai/Root/Same--second00.md';
    assert.equal(h.vault.readPath('Wolai/Root/Same.md'),existing);
    assert.equal(first.nextState.second0002.filePath,alternate);
    assert.equal(first.nextState.child.filePath,'Wolai/Root/Same--second00/Child.md');
    const root=h.vault.readPath('Wolai/Root.md');
    assert.ok(root.includes('[[Wolai/Root/Same--second00|Same]]'));
    assert.ok(root.includes('[[Wolai/Root/Same|Same]]'));
    const rendered=h.manager.renderPageMarkdown([{id:'img',type:'image',url:'https://example.invalid/i.png'}],'Same','second0002','Root');
    assert.ok(rendered.includes('Wolai/Root/Same--second00/pictures/img.png'));
    const saved=JSON.parse(h.vault.readPath(`${runtimeDir}/wolai-page-paths.json`));
    assert.equal(saved.pages.second0002,alternate);
    // Reload persisted mapping and reverse traversal order. It must not swap.
    h.manager.pagePaths=undefined;pages.root.blocks.reverse();
    const again=await syncPage(h,first.nextState);
    assert.equal(again.success,true);assert.equal(again.nextState.second0002.filePath,alternate);
    assert.equal(again.changes.size,0);
});

test('cached parent with colliding child titles refreshes links once, then fast-skips',async()=>{
    const pages={root:{blocks:[page('first0001','Same'),page('second0002','Same')]},
        first0001:{blocks:[text('one')]},second0002:{blocks:[text('two')]}};
    const h=await createHarness({pages});
    const original=note('# Root\n\n[[Same]]\n\n[[Same]]');h.vault.seed('Wolai/Root.md',original);
    h.vault.seed('Wolai/Root/Same.md',note('# Same\n\none','first0001'));
    const previous={root:legacyState({converterVersion:2,remoteVersion:2,remoteEditedAt:200,
        localHash:h.manager.markdownParser.createHash(original),
        fingerprint:h.manager.createPageFingerprint(pages.root.blocks),children:[
            {pageId:'first0001',title:'Same',relativeDir:'Root'},
            {pageId:'second0002',title:'Same',relativeDir:'Root'}]})};
    const first=await syncPage(h,previous,{startedAt:Date.now(),verifiedPageIds:{root:Date.now()}});
    assert.equal(first.success,true);assert.ok(h.requests.includes('blocks:root'));
    assert.ok(h.vault.readPath('Wolai/Root.md').includes('Same--second00|Same'));
    h.requests.length=0;await syncPage(h,first.nextState);
    assert.ok(!h.requests.includes('blocks:root'));
});

test('path registry extends colliding ID prefixes, handles sanitized names, persists before use and rejects traversal',async()=>{
    let saved={schema:1,scope:'test',pages:{}};
    const disk=new Map([['Wolai/Same.md',{path:'Wolai/Same.md',owner:'old'}]]);
    const mapper=()=>new PagePaths('Wolai',structuredClone(saved),async p=>disk.get(p)||null,async s=>{saved=structuredClone(s);});
    const m=mapper();
    assert.equal(await m.resolve('abcdefgh1','Same',''),'Wolai/Same--abcdefgh.md');
    assert.equal(await m.resolve('abcdefgh2','Same',''),'Wolai/Same--abcdefgh2.md');
    assert.equal(await mapper().resolve('abcdefgh2','Same',''),'Wolai/Same--abcdefgh2.md');
    assert.equal(await mapper().resolve('abcdefgh2','Same','AnotherParent'),'Wolai/Same--abcdefgh2.md');
    assert.equal(await m.resolve('a','A/B',''),'Wolai/A_B.md');
    assert.equal(await m.resolve('b','A:B',''),'Wolai/A_B--b.md');
    assert.equal(await m.resolve('c','pictures',''),'Wolai/pictures--c.md');
    await assert.rejects(m.resolve('d','X','../escape'),/UNSAFE_PAGE_PATH/);
    const failure=new PagePaths('Wolai',{schema:1,scope:'test',pages:{}},async()=>null,async()=>{throw Error('disk full');});
    await assert.rejects(failure.resolve('e','X',''),/disk full/);assert.deepEqual(failure.state.pages,{});
});

test('case-equivalent filenames do not overwrite another page',async()=>{
    const h=await createHarness();h.vault.seed('Wolai/NCL.md',note('Keep','one'));
    const paths=await h.manager.getPagePaths();
    assert.equal(await paths.resolve('two','ncl',''),'Wolai/ncl--two.md');
    assert.equal(h.vault.readPath('Wolai/NCL.md'),note('Keep','one'));
});

test('one page referenced by different parents retains one canonical file and explicit cross-parent link',async()=>{
    const pages={root:{blocks:[page('left','Left'),page('right','Right')]},
        left:{blocks:[page('shared','Shared')]},right:{blocks:[page('shared','Shared')]},shared:{blocks:[text('body')]}};
    const h=await createHarness({pages});
    const first=await syncPage(h,{});assert.equal(first.success,true);
    assert.equal(first.nextState.shared.filePath,'Wolai/Root/Left/Shared.md');
    assert.ok(!h.vault.files.has('Wolai/Root/Right/Shared.md'));
    assert.ok(h.vault.readPath('Wolai/Root/Right.md').includes('[[Wolai/Root/Left/Shared|Shared]]'));
    const again=await syncPage(h,first.nextState);assert.equal(again.success,true);
    assert.equal(again.nextState.shared.filePath,first.nextState.shared.filePath);
});

test('reader supplies exact pagination evidence from network and resumed cache, not duplicate output',async()=>{
    const first=Array.from({length:200},(_,i)=>text('b'+i));const second=[first[199],text('last')];
    let evidence,requests=0;const files=new Map();
    const store={read:async id=>files.get(id)||null,reset:async(id,s)=>files.set(id,s),
        append:async(id,s)=>files.set(id,files.get(id)+s),remove:async id=>files.delete(id)};
    const reader=()=>new PageBlockReader(async(id,cursor)=>{requests++;return {blocks:cursor?second:first,hasMore:!cursor,nextCursor:cursor?undefined:'next'};},()=>{},()=>{},store,'scope',async()=>({version:2,edited_at:200}));
    const options={resume:true,metadata:{version:2,edited_at:200},onLegacyPagination:b=>{evidence=b;}};
    const result=await reader().read('root',options);assert.equal(result.length,201);assert.equal(evidence.length,202);
    assert.equal(evidence[199].id,evidence[200].id);assert.equal(requests,2);
    evidence=undefined;await reader().read('root',options);assert.equal(evidence.length,202);assert.equal(requests,2);
});

for(const type of ['different-id','different-content','nested','same-batch']){
    test('reader rejects unproven legacy repetition: '+type,async()=>{
        let evidence;
        const a=text('same','Repeated'),b=type==='different-id'?text('other','Repeated'):{...a};
        if(type==='different-content')b.content='Changed';
        if(type==='nested'){a.children={ids:['leaf']};b.children={ids:['leaf']};}
        const reader=new PageBlockReader(async id=>({blocks:id==='root'?[a,b]:[text('leaf')],hasMore:false}),()=>{},()=>{});
        await reader.read('root',{onLegacyPagination:b=>{evidence=b;}});assert.equal(evidence,undefined);
    });
}

async function paginationFixture({edit=false,remoteChanged=false,noBaseline=false,backupFailure=false,concurrent=false}={}){
    const a=text('a','Keep'),repeated=text('dup','Repeated boundary'),last=text('z','End');
    const blocks=[a,repeated,last],legacyBlocks=[a,repeated,repeated,last];
    const h=await createHarness({pages:{root:{blocks,legacyBlocks}}});
    const original=note(h.manager.renderPageMarkdown(legacyBlocks,'Root','root','')+(edit?'\nMy edit':''),'root',{sync_status:'Conflict',custom:'keep'});
    h.vault.seed('Wolai/Root.md',original);
    const state=noBaseline?{}:{root:legacyState({converterVersion:2,remoteVersion:remoteChanged?1:2,remoteEditedAt:200,
        fingerprint:h.manager.createPageFingerprint(legacyBlocks),localHash:'previous-hash',localDirty:true})};
    const write=h.vault.adapter.write;
    h.vault.adapter.write=async(p,s)=>{
        if(p.includes('pagination-migration-backups')){
            if(backupFailure)throw Error('disk full');
            if(concurrent)h.vault.seed('Wolai/Root.md',original+'\nUser edit during backup');
        }
        return write(p,s);
    };
    return {h,state,original};
}
test('proven old pagination migrates despite stale Conflict flag and preserves original backup and properties',async()=>{
    const {h,state,original}=await paginationFixture();
    const first=await syncPage(h,state);
    assert.equal(first.success,true);assert.equal(first.changes.size,1);
    const backup=[...h.vault.contents.keys()].find(p=>p.includes('pagination-migration-backups'));
    assert.equal(h.vault.readPath(backup),original);
    const after=matter(h.vault.readPath('Wolai/Root.md'));
    assert.equal(after.content.split('Repeated boundary').length-1,1);assert.equal(after.data.custom,'keep');
    assert.equal(after.data.sync_status,'Synced');assert.equal(first.nextState.root.localDirty,false);
    assert.equal(h.requests.filter(x=>x==='metadata:root').length,2);
    h.requests.length=0;const again=await syncPage(h,first.nextState);
    assert.equal(again.changes.size,0);assert.deepEqual(h.requests,['metadata:root']);
});
for(const option of ['edit','remoteChanged','noBaseline','backupFailure','concurrent']){
    test('pagination migration refuses unsafe case: '+option,async()=>{
        const {h,state,original}=await paginationFixture({[option]:true});
        const result=await syncPage(h,state);assert.equal(result.success,false);
        assert.equal(h.vault.readPath('Wolai/Root.md'),original+(option==='concurrent'?'\nUser edit during backup':''));
        assert.equal(result.nextState.root,undefined);
    });
}
test('a remote edit at final migration check prevents overwrite',async()=>{
    const {h,state,original}=await paginationFixture();const get=h.manager.wolaiAPI.getBlockMetadata;let calls=0;
    h.manager.wolaiAPI.getBlockMetadata=async id=>({...await get(id),version:++calls===2?3:2});
    assert.equal((await syncPage(h,state)).success,false);assert.equal(h.vault.readPath('Wolai/Root.md'),original);
});
test('upload phase defers proven pagination repair without writing Wolai',async()=>{
    const {h,state,original}=await paginationFixture();
    h.vault.seed(`${runtimeDir}/wolai-incremental-state.json`,JSON.stringify(state));
    h.vault.seed('Wolai/Root.md',original.replace('sync_status: Conflict','sync_status: Modified'));
    assert.equal(await h.manager.syncObsidianToWolai('Wolai/Root.md'),true);
    assert.ok(h.manager.outboundUnchangedFiles.has('Wolai/Root.md'));
    assert.ok(h.logs.some(l=>l.message.includes('旧分页重复，未上传')));
});
test('same page failing both directions is counted once; baseline reconciliation is not an upload',async()=>{
    const h=await createHarness();h.vault.seed('Wolai/Root.md',note('Body'));
    h.manager.validateSync=async()=>true;h.manager.getAllFilesInFolder=async()=>['Wolai/Root.md'];
    h.manager.prepareLocalFileForSync=async()=>true;
    h.manager.syncObsidianToWolai=async()=>false;
    h.manager.syncWolaiToObsidian=async()=>{h.manager.inboundFailures.set('root',{path:'Wolai/Root.md',error:'conflict'});return 0;};
    const failed=await h.manager.executeSync('incremental');assert.equal(failed.failedPages,1);
    h.manager.syncObsidianToWolai=async p=>{h.manager.outboundUnchangedFiles.add(p);return true;};
    h.manager.syncWolaiToObsidian=async()=>{h.manager.inboundFailures.clear();return 0;};
    const result=await h.manager.executeSync('incremental');assert.equal(result.obsidianToWolai,0);assert.equal(result.status,'no_changes');
});

test('real outbound body reconciliation is flagged as unchanged rather than uploaded',async()=>{
    const blocks=[text('body','Body')],h=await createHarness({pages:{root:{blocks}}});
    const local=note('# Root\n\nBody','root',{sync_status:'Modified'});
    h.vault.seed('Wolai/Root.md',local);
    h.vault.seed(`${runtimeDir}/wolai-incremental-state.json`,JSON.stringify({root:legacyState({converterVersion:2,
        remoteVersion:2,remoteEditedAt:200,fingerprint:h.manager.createPageFingerprint(blocks),localHash:'old'})}));
    assert.equal(await h.manager.syncObsidianToWolai('Wolai/Root.md'),true);
    assert.ok(h.manager.outboundUnchangedFiles.has('Wolai/Root.md'));
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.sync_status,'Synced');
});

test('corrupt or duplicate registry fails closed on every attempt, never memoizes invalid data',async()=>{
    for(const pages of [{a:'../outside.md'},{a:'Wolai/Same.md',b:'Wolai/same.md'}]){
        const h=await createHarness();const scope=JSON.stringify(['Wolai','']);
        h.vault.seed(`${runtimeDir}/wolai-page-paths.json`,JSON.stringify({schema:1,scope,pages}));
        await assert.rejects(h.manager.getPagePaths(),/INVALID_PAGE_PATH_REGISTRY/);
        await assert.rejects(h.manager.getPagePaths(),/INVALID_PAGE_PATH_REGISTRY/);
        assert.equal(h.manager.pagePaths,undefined);
    }
});

test('link-only legacy Conflict migrates with backup; a genuine parent edit remains protected',async()=>{
    for(const edit of [false,true]){
        const blocks=[page('one','Same'),page('two','Same')];
        const h=await createHarness({pages:{root:{blocks},one:{blocks:[text('first')]},two:{blocks:[text('second')]}}});
        const original=note('# Root\n\n[[Same]]\n\n[[Same]]'+(edit?'\nMy edit':''),'root',{sync_status:'Conflict',custom:'keep'});
        h.vault.seed('Wolai/Root.md',original);
        const state={root:legacyState({converterVersion:2,remoteVersion:2,remoteEditedAt:200,
            fingerprint:h.manager.createPageFingerprint(blocks),localHash:'old',localDirty:true,children:[
                {pageId:'one',title:'Same',relativeDir:'Root'},{pageId:'two',title:'Same',relativeDir:'Root'}]})};
        const result=await syncPage(h,state);
        const backups=[...h.vault.contents.keys()].filter(p=>p.includes('path-migration-backups'));
        if(edit){
            assert.equal(backups.length,0);assert.ok(matter(h.vault.readPath('Wolai/Root.md')).content.includes('My edit'));
            assert.ok(!matter(h.vault.readPath('Wolai/Root.md')).content.includes('Same--two'));
        }else{
            assert.equal(result.success,true);assert.equal(backups.length,1);assert.equal(h.vault.readPath(backups[0]),original);
            assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.custom,'keep');
            assert.ok(h.vault.readPath('Wolai/Root.md').includes('Same--two|Same'));
        }
    }
});

test('outbound reloads stored path mapping before comparing disambiguated page links',async()=>{
    const blocks=[page('one','Same'),page('two','Same')],h=await createHarness({pages:{root:{blocks}}});
    const scope=JSON.stringify(['Wolai','']);
    h.vault.seed(`${runtimeDir}/wolai-page-paths.json`,JSON.stringify({schema:1,scope,pages:{
        root:'Wolai/Root.md',one:'Wolai/Root/Same.md',two:'Wolai/Root/Same--two.md'}}));
    const local=note('# Root\n\n[[Wolai/Root/Same|Same]]\n\n[[Wolai/Root/Same--two|Same]]','root',{sync_status:'Modified'});
    h.vault.seed('Wolai/Root.md',local);
    const state={root:legacyState({converterVersion:2,remoteVersion:2,remoteEditedAt:200,
        fingerprint:h.manager.createPageFingerprint(blocks),localHash:'old',children:[
            {pageId:'one',title:'Same',relativeDir:'Root'},{pageId:'two',title:'Same',relativeDir:'Root'}]})};
    h.vault.seed(`${runtimeDir}/wolai-incremental-state.json`,JSON.stringify(state));
    assert.equal(await h.manager.syncObsidianToWolai('Wolai/Root.md'),true);
    assert.ok(h.manager.outboundUnchangedFiles.has('Wolai/Root.md'));
    assert.ok(h.logs.some(l=>l.message.includes('正文一致，已更新基线')));
});
