// Real production panel JSX, filters and disclosure hook, with synthetic data/callbacks.
// DOM behavior only: this suite does not make pixel/browser/native-provider claims.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {createRequire, Module} = require('node:module');
const root = path.resolve(__dirname, '..');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(process.env.LR_TEST_TOOLS + '/package.json') : require;
const {JSDOM} = requireTool('jsdom');
const esbuild = require(require.resolve('esbuild', {paths:[fs.realpathSync(root + '/node_modules/vite')]}));
const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', {url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator']) Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
// Git uses CRLF in Windows worktrees. Extraction operates on normalized text,
// while the fixture still executes the unchanged production JSX and filters.
const source = fs.readFileSync(path.join(root,'src/CanvasSpike.tsx'),'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('          <div\n            className="canvas-generation-history-anchor"');
const end = source.indexOf('          <span className="canvas-editor-divider"',start);
assert(start >= 0 && end > start, 'production history panel extraction boundary');
const filterStart = source.indexOf('  const filteredGenerationHistory = useMemo(');
const filterEnd = source.indexOf('\n\n',filterStart);
const fixture = `
import React,{Fragment,useState,useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasHistoryDisclosure} from './src/features/canvas/CanvasHistoryDisclosure';
import {useCanvasHistoryPopover} from './src/features/canvas/useCanvasHistoryPopover';
import {historyHasResult} from './src/core/canvas/generationIteration';
import {matchesGenerationHistory} from './src/core/canvas/workflowHelpers';
const data=['image','video','text','failed','running'].map((kind,index)=>({version:4,id:'h'+index,taskId:'t'+index,kind:['failed','running'].includes(kind)?'image':kind,status:['failed','running'].includes(kind)?kind:'succeeded',prompt:'Prompt '+kind,model:'test-model',createdAt:index<3?'2026-10-18T01:00:00Z':'2026-10-17T01:00:00Z',request:{kind,prompt:'Prompt '+kind,model:'test-model',references:[]},...(['failed','running'].includes(kind)?{}:kind==='text'?{outputText:'Text result sample'}:{outputMediaUrl:'fixture://'+kind,outputThumbnailUrl:'fixture://thumb'})}));
function freeze(v){Object.freeze(v);Object.values(v).forEach(x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x))freeze(x)});return v;}freeze(data);
window.historyFixture={events:[],data,before:JSON.stringify(data)};
const record=(action,entry)=>window.historyFixture.events.push([action,entry.id]);
function CanvasToolButton({label,onClick,children}){return <button aria-label={label} onClick={onClick}>{children}</button>}
const ToolIcon=({type})=><span data-icon={type}/>;
const t=key=>key.split('.').pop(),locale='en-US',currentCanvasId='qa',generationHistorySignal=0,activeGenerationCount=0;
const generationQueuePositions=new Map(),visibleHistorySavingIds=new Set(),resolveCanvasMediaUrl=url=>url,generationHistoryStatusLabel=entry=>entry.status;
function App(){
const generationHistory=data;
const [generationHistoryOpen,setGenerationHistoryOpen]=useState(true),[generationHistoryNotice,setGenerationHistoryNotice]=useState(''),[generationHistoryView,setGenerationHistoryView]=useState('grid'),[generationHistoryQuery,setGenerationHistoryQuery]=useState(''),[generationHistoryStatusFilter,setGenerationHistoryStatusFilter]=useState('all'),[generationHistoryKindFilter,setGenerationHistoryKindFilter]=useState('all'),[generationHistoryDeleteConfirmId,setGenerationHistoryDeleteConfirmId]=useState(null),[generationHistoryClearConfirm]=useState(false),[generationHistoryPreviewId,setGenerationHistoryPreviewId]=useState(null);
const generationHistoryPreviewEntry=generationHistory.find(e=>e.id===generationHistoryPreviewId)||null;
const generationHistoryAnchorRef=useCanvasHistoryPopover(generationHistoryOpen,generationHistoryNotice,()=>setGenerationHistoryOpen(false),()=>setGenerationHistoryNotice(''));
const restoreGenerationHistoryResult=e=>record('restore',e),cancelGenerationHistoryEntry=e=>record('cancel',e),rerunGenerationHistoryEntry=e=>record('rerun',e),createGenerationDraft=e=>record('draft',e),saveHistoryEntryToLibrary=e=>record('save',e),deleteGenerationHistoryEntry=e=>{record('delete',e);setGenerationHistoryDeleteConfirmId(e.id);},clearFailedGenerationHistory=()=>{},setCreativePanel=()=>{};
${source.slice(filterStart,filterEnd)}
return (${source.slice(start,end)});
}
createRoot(document.getElementById('root')).render(<App/>);`;
const built=esbuild.buildSync({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic'});
const compiled=new Module(path.join(root,'history-dom-fixture.cjs'),module);compiled.filename=path.join(root,'history-dom-fixture.cjs');compiled.paths=module.paths;compiled._compile(built.outputFiles[0].text,compiled.filename);
const tick=()=>new Promise(r=>setTimeout(r,30));let checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};const ok=(a,msg)=>{assert.ok(a,msg);checks++;};
const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
const click=async n=>{assert(n);n.click();await tick();};
const pointer=n=>n.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));
const edit=async value=>{const el=q('.canvas-generation-history-search');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await tick();};
(async()=>{
await tick();eq(qa('.is-grid article').length,5);eq(qa('details[open]').length,0);eq(qa('.canvas-history-date-label').length,2);eq(q('.canvas-history-text-thumbnail').textContent,'Text result sample');
eq(qa('article.is-succeeded .canvas-generation-history-copy > div > span').length,0,'no repetitive completed status');
await click(qa('.canvas-history-view-toggle button')[1]);eq(qa('.is-list article').length,5);eq(qa('.canvas-history-view-toggle button')[1].getAttribute('aria-pressed'),'true');
await click(qa('.canvas-history-kind-tabs button')[1]);eq(qa('article').length,3);await click(qa('.canvas-history-kind-tabs button')[2]);eq(qa('article').length,1);ok(q('article.kind-video'));
await click(qa('.canvas-history-kind-tabs button')[3]);eq(qa('article').length,1);await click(q('.canvas-generation-history-preview'));eq(window.historyFixture.events.at(-1),['restore','h2']);
await click(qa('.canvas-history-kind-tabs button')[0]);await click(qa('.canvas-generation-history-filters button')[1]);eq(qa('article').length,1);ok(q('article.is-running'));ok(q('.canvas-generation-history-preview').disabled);
await click(qa('.canvas-generation-history-filters button')[0]);await edit('Prompt video');eq(qa('article').length,1);await edit('no match whatsoever');eq(qa('article').length,0);ok(q('.canvas-generation-history-empty'));await edit('');
const summary=q('summary');await click(summary);eq(qa('details[open]').length,1);eq(q('article .canvas-generation-history-actions').querySelectorAll('button').length,7);
q('details[open] button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();eq(qa('details[open]').length,0);ok(q('.canvas-generation-history-panel'),'disclosure Escape preserves panel');eq(document.activeElement,summary,'Escape restores summary focus');
await click(summary);
q('#outside').dispatchEvent(new MouseEvent('pointerup',{bubbles:true,button:0}));await tick();eq(qa('details[open]').length,1,'selection release outside does not dismiss');
q('#outside').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:2}));await tick();eq(qa('details[open]').length,1,'right click does not dismiss');
for(const [label,action] of [['generateAgain','rerun'],['New editable draft','draft'],['saveLibrary','save']]){await click(qa('article:first-of-type .canvas-generation-history-actions button').find(b=>b.textContent===label));eq(window.historyFixture.events.at(-1),[action,'h0']);}
pointer(q('.canvas-generation-history-search'));await tick();eq(qa('details[open]').length,0);ok(q('.canvas-generation-history-panel'));
await click(summary);await click(q('.canvas-generation-history-actions button.is-danger'));eq(window.historyFixture.events.at(-1),['delete','h0']);eq(q('.canvas-generation-history-actions button.is-danger').textContent,'confirmDelete','confirmation remains accessible');
pointer(q('#outside'));await tick();eq(q('.canvas-generation-history-panel'),null);await click(q('.canvas-generation-history-anchor > button'));eq(qa('details[open]').length,0,'reopen has no stale disclosure');
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();eq(q('.canvas-generation-history-panel'),null);
eq(JSON.stringify(window.historyFixture.data),window.historyFixture.before,'all UI operations preserve frozen snapshot data');
console.log(JSON.stringify({status:'passed',checks,scope:'production history JSX/filter/hook React DOM with mocked action callbacks; browser pixel/provider verification NOT_RUN'}));dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
