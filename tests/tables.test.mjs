import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import parse from 'remark-parse';
import gfm from 'remark-gfm';
import math from 'remark-math';
import matter from 'gray-matter';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { createHarness, legacyState, syncPage } from './helpers/sync-harness.mjs';

function compile(path) {
    const source = buildSync({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),
        entryPoints:[path],bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian']}).outputFiles[0].text;
    const mod={exports:{}};
    new Function('module','exports','require',source)(mod,mod.exports,()=>({Notice:class{}}));
    return mod.exports;
}
const {PageBlockReader}=compile('src/PageBlockReader.ts');
const {isCompleteTextTable,renderWolaiTable}=compile('src/WolaiTable.ts');
const {WolaiAPI}=compile('src/WolaiAPI.ts');
const {MarkdownParser}=compile('src/MarkdownParser.ts');
const rev={version:2,edited_at:200};
const cell=content=>({content});
const full=(id='table',rows=[[cell('A'),cell('B')],[cell('0.0100'),cell('001')]])=>({id,type:'table',...rev,
    children:{ids:rows.flat().map((_,i)=>`${id}-cell-${i}`)},
    table_content:rows,table_setting:{has_header:true,column_widths:rows[0].map(()=>100)}});
const shallow=t=>{const {table_content,table_setting,...b}=t;return b;};
function fixture(table=full()) {
    const files=new Map(),calls=[],logs=[];
    let fail=false,detail=table;
    const store={read:async id=>files.get(id)||null,reset:async(id,t)=>files.set(id,t),
        append:async(id,t)=>files.set(id,(files.get(id)||'')+t),remove:async id=>files.delete(id)};
    const reader=()=>new PageBlockReader(async(id)=>{
        calls.push('children:'+id);
        if(id==='root')return {blocks:[shallow(table)],hasMore:false};
        if(id===table.id)return {blocks:[{id:'leaf',type:'text',content:'fallback'}],hasMore:false};
        throw Error('Unexpected child fetch');
    },(l,m)=>logs.push(m),()=>{},store,'account',async()=>{calls.push('verify:root');return rev;},async id=>{
        calls.push('table:'+id);if(fail)throw Error('offline');return structuredClone(detail);
    });
    return {reader,calls,files,logs,options:{metadata:rev,resume:true},setFail:x=>fail=x,setDetail:x=>detail=x};
}
const ast=md=>unified().use(parse).use(gfm).use(math).parse(md);
const tableNode=md=>ast(md).children.find(n=>n.type==='table');
function value(n){return n.type==='html'&&n.value==='<br>'?'\n':n.value??(n.children||[]).map(value).join('');}

test('one complete table detail replaces all cell requests',async()=>{
    const f=fixture();const out=await f.reader().read('root',f.options);
    assert.deepEqual(f.calls,['children:root','table:table']);
    assert.deepEqual(out,[full()]);
    assert.ok(f.logs.some(x=>x.includes('跳过 4 个单元格')));
});
test('an already-complete table in the child listing needs no detail request',async()=>{
    let calls=0;
    const reader=new PageBlockReader(async()=>{calls++;return {blocks:[full()],hasMore:false};},()=>{},()=>{},
        undefined,'',undefined,async()=>{throw Error('Unexpected detail request');});
    assert.deepEqual(await reader.read('root'),[full()]);assert.equal(calls,1);
});
test('cancellation after table response cannot journal the matrix',async()=>{
    let cancelled=false;const writes=[];
    const reader=new PageBlockReader(async()=>({blocks:[shallow(full())],hasMore:false}),()=>{},
        ()=>{if(cancelled)throw Error('WOLAI_SYNC_CANCELLED');},
        {read:async()=>null,reset:async()=>{},append:async(id,text)=>writes.push(text),remove:async()=>{}},
        'account',undefined,async()=>{cancelled=true;return full();});
    await assert.rejects(reader.read('root',{resume:true,metadata:rev}),/WOLAI_SYNC_CANCELLED/);
    assert.equal(writes.length,1);assert.ok(!writes[0].includes('"kind":"table"'));
});
test('table checkpoint resumes without re-reading the matrix',async()=>{
    const f=fixture();await f.reader().read('root',f.options);f.calls.length=0;
    const out=await f.reader().read('root',f.options);
    assert.deepEqual(f.calls,['verify:root']);assert.deepEqual(out[0].table_content,full().table_content);
});
test('failed table detail preserves root batch, not a partial matrix',async()=>{
    const f=fixture();f.setFail(true);await assert.rejects(f.reader().read('root',f.options),/offline/);
    assert.ok(!f.files.get('root').includes('"kind":"table"'));
    f.setFail(false);f.calls.length=0;await f.reader().read('root',f.options);
    assert.deepEqual(f.calls,['table:table','verify:root']);
});
for(const invalid of ['missing','ragged','missing-cell','unknown-cell','media','multiline-math']){
    test('unsupported matrix falls back without dropping descendants: '+invalid,async()=>{
        const f=fixture();const t=full();
        if(invalid==='missing')delete t.table_content;
        if(invalid==='ragged')t.table_content[1].pop();
        if(invalid==='missing-cell')t.children.ids.push('another');
        if(invalid==='unknown-cell')t.table_content[1][0].row_span=2;
        if(invalid==='media')t.table_content[1][0].content=[{type:'image',title:'image'}];
        if(invalid==='multiline-math')t.table_content[1][0].content=[{type:'equation',title:'a\nb'}];
        f.setDetail(t);const out=await f.reader().read('root',f.options);
        assert.deepEqual(f.calls,['children:root','table:table','children:table']);
        assert.equal(out[1].content,'fallback');assert.ok(f.logs.some(x=>x.includes('保留逐块读取')));
    });
}
test('changing table revision fails closed and invalidates snapshot',async()=>{
    const f=fixture();f.setDetail({...full(),version:3});
    await assert.rejects(f.reader().read('root',f.options),/PAGE_CHANGED_DURING_READ/);
    assert.equal(f.files.size,0);
});
test('matrix rendering preserves cells, numerical strings, literal markup, newlines and math',()=>{
    const raw=['0.0100','001','-1.20e-08','98.00%','','a|b','a_b','[x] *literal*',' a ', 'line1\nline2', '$5', '<x>&y'];
    const latex=['\\frac{1}{N}\\sum_{i=1}^N x_i','|x|','\\|x\\|','P(A|B)'];
    const rows=[raw.map(x=>cell(x)),latex.map(x=>cell([{title:x,type:'equation'}])).concat(raw.slice(4).map(cell))];
    const t=full('math',rows);const md=renderWolaiTable(t);const parsed=tableNode(md);
    assert.ok(parsed);assert.equal(parsed.children.length,2);
    assert.deepEqual(parsed.children[0].children.map(value),raw);
    assert.deepEqual(parsed.children[1].children.slice(0,4).map(c=>c.children[0].value),
        [latex[0],'\\vert{}x\\vert{}','\\Vert{}x\\Vert{}','P(A\\vert{}B)']);
    assert.ok(parsed.children[1].children.slice(0,4).every(c=>c.children[0].type==='inlineMath'));
});
test('headerless first row and empty cells are retained, no accidental data header',()=>{
    const t=full();t.table_setting.has_header=false;
    const rows=tableNode(renderWolaiTable(t)).children;
    assert.equal(rows.length,3);assert.deepEqual(rows[0].children.map(value),['','']);
    assert.deepEqual(rows[1].children.map(value),['A','B']);
});
test('nested table remains a rendered table rather than an indented code block',()=>{
    const parser=new MarkdownParser();
    const md=parser.convertWolaiPageToMarkdown([
        {id:'parent',type:'text',content:'Parent'},
        {...full(),isChildBlock:true,depth:3,parentBlockId:'parent'}
    ]);
    assert.ok(tableNode(md));assert.ok(!ast(md).children.some(x=>x.type==='code'));
    assert.deepEqual(tableNode(md).children[1].children.map(value),['0.0100','001']);
});
test('table-safe formulas render the same MathJax glyphs and dimensions',()=>{
    const adaptor=liteAdaptor();RegisterHTMLHandler(adaptor);
    const doc=mathjax.document('',{InputJax:new TeX(),OutputJax:new SVG({fontCache:'none'})});
    const signature=tex=>{
        const svg=adaptor.outerHTML(doc.convert(tex,{display:false}));
        assert.ok(!svg.includes('merror'));
        return {bounds:svg.match(/viewBox="([^"]+)"/)?.[1],
            glyphs:[...svg.matchAll(/data-c="([^"]+)"/g)].map(x=>x[1])};
    };
    for(const latex of ['|x|','\\|x\\|','P(A|B)','\\left|\\frac{a}{b}\\right|','\\sum_{n=1}^{N} x_n']){
        const t=full('math',[[cell([{type:'equation',title:latex}])]]);
        const converted=tableNode(renderWolaiTable(t)).children[0].children[0].children[0].value;
        assert.deepEqual(signature(converted),signature(latex));
    }
});
test('backup failure or concurrent edit prevents table migration overwrites',async()=>{
    for(const mode of ['error','edit']){
        const h=await createHarness({pages:{root:{blocks:[full()]}}});
        const original=matter.stringify('# Root\n\n*[表格内容]*',{wolai_id:'root',sync_status:'Synced'});
        const state={root:legacyState({converterVersion:2,remoteVersion:2,remoteEditedAt:200,
            localHash:h.manager.markdownParser.createHash(original)})};
        h.vault.seed('Wolai/Root.md',original);const write=h.vault.adapter.write;
        h.vault.adapter.write=async(path,text)=>{
            if(path.includes('table-migration-backups')){
                if(mode==='error')throw Error('disk full');
                h.vault.seed('Wolai/Root.md',original+'\nlocal edit');
            }
            return write(path,text);
        };
        const result=await syncPage(h,state);assert.equal(result.success,false);
        assert.equal(h.vault.readPath('Wolai/Root.md'),original+(mode==='edit'?'\nlocal edit':''));
    }
});
test('style and inline code remain structured markup; caption survives',()=>{
    const t=full('styled',[[cell([{title:'bold',bold:true}]),cell([{title:'x|y`z',inline_code:true}])]]);
    t.caption='caption';const md=renderWolaiTable(t);const row=tableNode(md).children[0];
    assert.equal(row.children[0].children[0].type,'strong');
    assert.equal(row.children[1].children[0].type,'inlineCode');
    assert.equal(row.children[1].children[0].value,'x|y`z');assert.match(md,/caption/);
});
test('outbound replacement cannot overwrite a remote table',async()=>{
    const api=new WolaiAPI('test','test');api.getPageContent=async()=>[shallow(full())];
    const writes=[];api.updateBlock=api.deleteBlock=api.createBlocks=async()=>writes.push('write');
    await assert.rejects(api.replacePageContent('root',[{type:'text',content:'changed'}]),/TABLE_UPLOAD_UNSUPPORTED/);
    assert.deepEqual(writes,[]);
});
test('safe legacy table migration is targeted, backed up and then fast-skipped',async()=>{
    const t=full();const original=matter.stringify('# Root\n\n*[表格内容]*\n\n\t\tA',{
        wolai_id:'root',sync_status:'Synced',custom:'keep'});
    const h=await createHarness({pages:{root:{blocks:[t]}}});
    const state={root:legacyState({converterVersion:2,...rev,remoteVersion:2,remoteEditedAt:200,
        localHash:h.manager.markdownParser.createHash(original)})};
    h.vault.seed('Wolai/Root.md',original);
    const result=await syncPage(h,state,{verifiedPageIds:{root:Date.now()}});
    assert.equal(result.success,true);const backups=[...h.vault.contents.keys()].filter(x=>x.includes('table-migration-backups'));
    assert.equal(backups.length,1);assert.equal(h.vault.readPath(backups[0]),original);
    assert.equal(matter(h.vault.readPath('Wolai/Root.md')).data.custom,'keep');
    assert.ok(tableNode(matter(h.vault.readPath('Wolai/Root.md')).content));
    assert.equal(result.nextState.root.hasTables,true);h.requests.length=0;
    const again=await syncPage(h,result.nextState);
    assert.equal(again.changes.size,0);assert.deepEqual(h.requests,['metadata:root']);
});
test('no baseline or concurrent local edits cannot be overwritten by table upgrade',async()=>{
    for(const unknown of [true,false]){
        const h=await createHarness({pages:{root:{blocks:[full()]}}});
        const original=matter.stringify('# Root\n\n*[表格内容]*\n\nMy edit',{wolai_id:'root',sync_status:'Synced'});
        h.vault.seed('Wolai/Root.md',original);
        const state=unknown?{}:{root:legacyState({converterVersion:2,localHash:'old-hash'})};
        const result=await syncPage(h,state);assert.equal(result.success,false);
        assert.equal(h.vault.readPath('Wolai/Root.md'),original);
    }
});
test('first-read request benchmark: same 22 tables / 564 cells, 592 becomes 28',async()=>{
    const sizes=[42,15,15,12,12,12,40,40,15,15,18,18,42,42,15,15,21,21,35,35,42,42];
    const graph=new Map(),details=new Map(),root=[];const expected=[];
    let index=0;
    for(let i=0;i<sizes.length;i++){
        const width=sizes[i]%6===0?6:sizes[i]%5===0?5:3;
        const rows=Array.from({length:sizes[i]/width},()=>[]);
        for(let j=0;j<sizes[i];j++)rows[Math.floor(j/width)].push(cell([{title:String(index++).padStart(5,'0'),type:'text'}]));
        const t=full('t'+i,rows);details.set(t.id,t);root.push(shallow(t));expected.push(t.table_content);
        graph.set(t.id,t.children.ids.map((id,j)=>({id,type:'table_cell',...rev,children:{ids:[id+'-text']}})));
        t.children.ids.forEach((id,j)=>graph.set(id,[{id:id+'-text',type:'text',content:t.table_content.flat()[j].content}]));
    }
    for(let i=0;i<4;i++){const id='nested'+i;root.push({id,type:'text',...rev,children:{ids:[id+'-leaf']}});graph.set(id,[{id:id+'-leaf',type:'text',content:'leaf'}]);}
    while(root.length<477)root.push({id:'p'+root.length,type:'text',content:'paragraph'});
    const results=[];
    for(const optimized of [false,true]){
        let count=0;
        const reader=new PageBlockReader(async(id,cursor)=>{count++;return {blocks:structuredClone(id==='root'?(cursor?root.slice(200):root.slice(0,200)):graph.get(id)),hasMore:id==='root'&&!cursor,nextCursor:id==='root'&&!cursor?'next':undefined}},()=>{},()=>{},undefined,'',undefined,
            optimized?async id=>{count++;return structuredClone(details.get(id));}:undefined);
        const blocks=await reader.read('root');
        if(optimized)assert.deepEqual(blocks.filter(x=>x.type==='table').map(x=>x.table_content),expected);
        else assert.deepEqual(blocks.filter(x=>x.id.endsWith('-text')).map(x=>x.content),expected.flat(2).map(c=>c.content));
        results.push(count);
    }
    assert.deepEqual(results,[592,28]);
});
