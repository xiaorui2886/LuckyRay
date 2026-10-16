import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinWorkflows, captureWorkflow, instantiateWorkflow, parseWorkflow, validateWorkflow, WorkflowError, WORKFLOW_LIMITS, type CaptureNode} from '../src/core/canvas/workflowTemplates';
import {sanitizeCanvasNodesForPersistence} from '../src/features/canvas/canvasPersistence';

const template = () => validateWorkflow({format:'luckyray-canvas-workflow',version:1,name:'legacy reference draft',description:'',nodes:[
 {id:'ref',kind:'image',label:'reference',position:{x:0,y:0}},
 {id:'brief',kind:'text',label:'brief',position:{x:0,y:320}},
 {id:'hero',kind:'generator',label:'output',generationKind:'image',prompt:'prompt',position:{x:440,y:0}}
],edges:[{source:'ref',target:'hero',role:'reference',order:0},{source:'brief',target:'hero',role:'promptContext',order:1}]});
const rejects = (code:string, fn:()=>unknown) => assert.throws(fn, (e:unknown) => e instanceof WorkflowError && e.code === code);
test('all eight localized builtins use current editable media cards', () => {
 for(const english of [true,false]) for(const t of builtinWorkflows(english)) {
  assert.deepEqual(parseWorkflow(JSON.stringify(t)),t);
  assert.ok(t.nodes.some(n=>n.kind==='generator')); assert.ok(!t.nodes.some(n=>n.kind==='image'||n.kind==='video'));
  assert.ok(t.nodes.filter(n=>n.kind==='generator').every(n=>['image','video'].includes(n.generationKind!)));
 }
});
test('every insertion allocates new node and edge IDs; never shares object data', () => {
 let id=0; const next=()=>`generated${++id}`;
 const a=instantiateWorkflow(template(),{x:50,y:80},next), b=instantiateWorkflow(template(),{x:50,y:80},next);
 assert.equal(new Set([...a.nodes,...a.edges,...b.nodes,...b.edges].map(n=>n.id)).size,10);
 assert.equal(a.nodes[0].position.x,50); assert.equal(a.nodes[0].position.y,80);
 assert.equal(a.nodes[0].data.kind,'generator');assert.equal(a.nodes[0].data.generationKind,'image');assert.equal(a.nodes[0].data._emptyMedia,undefined);
 assert.ok(a.edges.every(e=>a.nodes.some(n=>n.id===e.source)&&a.nodes.some(n=>n.id===e.target)));
 a.nodes[0].data.label='changed'; assert.notEqual(a.nodes[0].data.label,b.nodes[0].data.label);
});
test('runtime task/profile/media fields cannot enter imported template',()=>{
 for(const [key,value] of Object.entries({generationTask:{id:'old'},mediaProfileId:'private',generationModel:'private',refMediaUrl:'https://signed.invalid',payload:'asset',result:'old',generationReferences:[]})) {
  const t:any=template();t.nodes[0][key]=value;rejects('unsupported-field',()=>validateWorkflow(t));
 }
 const t:any=template();t.apiKey='not-a-key';rejects('unsupported-field',()=>validateWorkflow(t));
});
test('unknown versions, malformed JSON and nonobjects fail before insertion',()=>{
 rejects('invalid-file',()=>parseWorkflow('{'));
 rejects('invalid-file',()=>validateWorkflow(null));
 rejects('unsupported-version',()=>validateWorkflow({...template(),version:2}));
});
test('bytes, node count, numeric bounds and text bounds are enforced',()=>{
 rejects('too-large',()=>parseWorkflow(' '.repeat(WORKFLOW_LIMITS.bytes+1)));
 const t=template();t.nodes=Array(65).fill(t.nodes[0]);rejects('too-large',()=>validateWorkflow(t));
 for(const x of [NaN,Infinity,100001]){const t=template();t.nodes[0].position.x=x;rejects('invalid-number',()=>validateWorkflow(t));}
 const n=template();n.name='x'.repeat(61);rejects('invalid-text',()=>validateWorkflow(n));
});
test('duplicate IDs, missing endpoints, duplicate edges and self edges fail',()=>{
 const a=template();a.nodes.push({...a.nodes[0]});rejects('duplicate-id',()=>validateWorkflow(a));
 const b=template();b.edges[0].source='missing';rejects('invalid-edge',()=>validateWorkflow(b));
 const c=template();c.edges.push({...c.edges[0]});rejects('duplicate-edge',()=>validateWorkflow(c));
 const d=template();d.edges[0].source=d.edges[0].target;rejects('invalid-edge',()=>validateWorkflow(d));
});
test('role mismatch, excess input count and graph cycles reject atomically',()=>{
 const a=template();a.edges[0].role='firstFrame';rejects('invalid-edge',()=>validateWorkflow(a));
 const b=template();for(let i=0;i<4;i++){b.nodes.push({...b.nodes[1],id:`extra${i}`});b.edges.push({source:`extra${i}`,target:'hero',role:'promptContext',order:i+2});}rejects('too-many-inputs',()=>validateWorkflow(b));
 const c=template();c.nodes.push({...c.nodes[2],id:'other'});c.edges.push({source:'hero',target:'other',role:'reference',order:0},{source:'other',target:'hero',role:'reference',order:2});rejects('edge-cycle',()=>validateWorkflow(c));
});
test('group ancestry rejects invalid parents, cycles and excessive depth',()=>{
 const a=template();a.nodes[0].parentId='brief';rejects('invalid-parent',()=>validateWorkflow(a));
 const b=template();b.nodes.push({id:'g',kind:'group',label:'group',position:{x:0,y:0},parentId:'g'});rejects('group-cycle',()=>validateWorkflow(b));
});
test('allocator collisions reject without changing input template',()=>{
 const t=template(),before=JSON.stringify(t);rejects('id-collision',()=>instantiateWorkflow(t,{x:0,y:0},()=> 'same'));
 assert.equal(JSON.stringify(t),before);rejects('id-collision',()=>instantiateWorkflow(t,{x:0,y:0},()=> 'existing',['existing']));
});
test('missing legacy roles inferred in target order and duplicate video frames rejected',()=>{
 const nodes:CaptureNode[]=[{id:'a',position:{x:0,y:0},data:{kind:'image'}},{id:'b',position:{x:0,y:300},data:{kind:'image'}},{id:'v',position:{x:500,y:0},data:{kind:'generator',generationKind:'video'}}];
 const t=captureWorkflow(nodes,[{source:'a',target:'v'},{source:'b',target:'v'}],['a','b','v'],'frames').template;
 assert.deepEqual(t.edges.map(e=>e.role),['firstFrame','lastFrame']);
 t.edges[1].role='firstFrame';rejects('invalid-edge',()=>validateWorkflow(t));
});
test('nontext source cannot claim prompt context and ninth ancestry level is rejected',()=>{
 const t=template();t.edges[0].role='promptContext';rejects('invalid-edge',()=>validateWorkflow(t));
 const deep=template();for(let i=0;i<9;i++)deep.nodes.push({id:`g${i}`,kind:'group',label:'g',position:{x:0,y:0},...(i?{parentId:`g${i-1}`}:{})});
 deep.nodes[0].parentId='g8';rejects('group-cycle',()=>validateWorkflow(deep));
});
const nodes:CaptureNode[]=[
 {id:'group',position:{x:100,y:200},style:{width:700,height:600},data:{kind:'group',label:'角色',referencePack:{version:1,kind:'character'}}},
 {id:'image',parentId:'group',position:{x:20,y:40},data:{kind:'image',label:'sensitive-file-name',payload:'secret-asset-id',refMediaUrl:'https://signed.invalid/?token=x'}},
 {id:'note',parentId:'group',position:{x:350,y:40},data:{kind:'noteRef',label:'private-note-title',payload:'note-id',refSummary:'private note'}},
 {id:'gen',position:{x:1000,y:200},data:{kind:'generator',generationKind:'image',label:'Make',generationPrompt:'visible prompt',generationModel:'secret profile',generationTask:{id:'task-old'},resultMediaUrl:'asset://old',generationCount:2}},
];
const edges=[{source:'image',target:'gen',data:{role:'reference',order:0}},{source:'note',target:'gen',data:{role:'promptContext',order:1}}];
test('selected group captures descendants, retains grouping and pack metadata',()=>{
 const r=captureWorkflow(nodes,edges,['group'],'pack');assert.equal(r.template.nodes.length,3);assert.equal(r.omittedEdges,2);assert.equal(r.placeholders,1);
 const t=r.template;assert.deepEqual(t.nodes[0].position,{x:0,y:0});assert.equal(t.nodes[1].parentId,t.nodes[0].id);assert.deepEqual(t.nodes[1].position,{x:20,y:40});
 assert.deepEqual(t.nodes[0].referencePack,{version:1,kind:'character'});
});
test('capture preserves visible prompt but strips runtime/profile and linked note content',()=>{
 const r=captureWorkflow(nodes,edges,['group','gen'],'workflow'),json=JSON.stringify(r);
 for(const forbidden of ['sensitive-file-name','secret-asset-id','signed.invalid','private-note-title','private note','note-id','task-old','secret profile','asset://old'])assert.ok(!json.includes(forbidden),forbidden);
 assert.ok(json.includes('visible prompt'));assert.equal(r.template.edges.length,2);assert.equal(r.template.nodes[3].count,2);
 assert.equal(r.template.nodes[2].kind,'text');
});
test('single child export rebases absolute position without exporting its parent',()=>{
 const r=captureWorkflow(nodes,edges,['image'],'image');assert.deepEqual(r.template.nodes[0].position,{x:0,y:0});assert.equal(r.template.nodes[0].parentId,undefined);
});
test('stored direct references refuse export rather than silently dropping inputs',()=>{
 const n=structuredClone(nodes);n[3].data.generationReferences=[{id:'resource'}];rejects('stored-references',()=>captureWorkflow(n,edges,['gen'],'x'));
});
test('generation snapshots represented by internal edges export without carrying their media bytes',()=>{
 const n=structuredClone(nodes);n[3].data.generationReferences=[{id:'node:image:reference',role:'reference',mediaUrl:'secret-url'},{id:'node:note:promptContext',role:'promptContext',text:'private note'}];
 const result=captureWorkflow(n,edges,['group','gen'],'generated workflow');
 assert.equal(result.template.edges.length,2);assert.ok(!JSON.stringify(result).includes('secret-url'));assert.ok(!JSON.stringify(result).includes('private note'));
 rejects('stored-references',()=>captureWorkflow(n,edges,['gen'],'incomplete selection'));
});
test('empty, stale selection and missing parent refuse capture without mutation',()=>{
 const before=JSON.stringify(nodes);rejects('empty-selection',()=>captureWorkflow(nodes,[],[],'x'));rejects('empty-selection',()=>captureWorkflow(nodes,[],['gone'],'x'));
 const n=structuredClone(nodes);n[1].parentId='gone';rejects('invalid-parent',()=>captureWorkflow(n,[],['image'],'x'));assert.equal(JSON.stringify(nodes),before);
});
test('imported group parent sorted first, durable pack tag and placeholder survive save sanitization',()=>{
 const t=captureWorkflow(nodes,edges,['group','gen'],'x').template;t.nodes.reverse();let id=0;
 const result=instantiateWorkflow(t,{x:40,y:90},()=>`fresh${++id}`);
 const group=result.nodes.find(n=>n.data.kind==='group')!;
 for(const n of result.nodes.filter(n=>n.parentId))assert.ok(result.nodes.indexOf(group)<result.nodes.indexOf(n));
 const saved=sanitizeCanvasNodesForPersistence(result.nodes);
 assert.equal(saved.find(n=>n.parentId&&n.data.generationKind==='image')?.data.kind,'generator');assert.ok(saved.every(n=>!n.data._emptyMedia));
 assert.deepEqual(saved.find(n=>n.data.kind==='group')?.data.referencePack,{version:1,kind:'character'});
});
