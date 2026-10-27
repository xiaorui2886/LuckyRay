import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {CREATION_SCHEMAS,validCreationPayload} from '../../src/core/canvas/agent/creationContract.ts';
import {validCreationPayload as hostCreation,validateCanvasAgentContext,validateCanvasAgentRequest} from '../../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
const cases=[];
const add=(name,mode,value,expected,extra={})=>cases.push({name,mode,value,expected,...extra});
const clone=structuredClone;
const revision='0123456789abcdef';
function sample(s,all=false) {
 if(s.oneOf)return sample(s.oneOf[0],all);
 if('const'in s)return s.const;if(s.enum)return s.enum[0];
 if(s.type==='null')return null;if(s.type==='boolean')return false;
 if(s.type==='number'||s.type==='integer')return s.minimum;
 if(s.type==='string'){if(s.pattern?.includes('a-f0-9'))return revision;if(s.pattern?.startsWith('^#'))return '#Ab12fF';return 'a'.repeat(Math.max(1,s.minLength??0));}
 if(s.type==='array')return Array.from({length:s.minItems??0},(_,i)=>sample(s.items,all));
 if(s.type==='object'){const keys=all?Object.keys(s.properties):[...(s.required??[])];if(keys.length<(s.minProperties??0))for(const key of Object.keys(s.properties))if(!keys.includes(key)){keys.push(key);if(keys.length>=s.minProperties)break;}return Object.fromEntries(keys.map(k=>[k,sample(s.properties[k],all)]));}
 throw Error('Unsupported schema '+JSON.stringify(s));
}
function creation(name,kind,value,required){const expected=validCreationPayload(value,kind);assert.equal(hostCreation(value,kind),expected,'Host/frontend parity '+name);if(required!==undefined)assert.equal(expected,required,'Fixture '+name);add(name,'creation',value,expected,{kind});}
const edits=CREATION_SCHEMAS.edit.oneOf??[CREATION_SCHEMAS.edit];
const single=edits.find(s=>s.properties.operation);
const operations=single.properties.operation.oneOf;
for(const s of operations){const op=s.properties.op.const;let value=sample(s);if(op==='referencePack.update')value.name='updated';creation(`operation ${op}`,'edit',{expectedRevision:revision,operation:value},true);creation(`operation ${op} unknown field`,'edit',{expectedRevision:revision,operation:{...value,unknown:true}},false);
 for(const key of s.required){const bad=clone(value);delete bad[key];creation(`${op} missing ${key}`,'edit',{expectedRevision:revision,operation:bad},false);}
 if(op!=='director.capture')creation(`batch ${op}`,'edit',{expectedRevision:revision,operations:[value]},true);
}
for(const scope of CREATION_SCHEMAS.read.properties.scope.enum)creation('read '+scope,'read',{scope,...(scope==='scriptText'?{objectId:'board-1'}:{})},true);
creation('read offset revision missing','read',{scope:'shots',offset:1},false);
creation('read offset revision valid','read',{scope:'shots',offset:1,expectedRevision:revision},true);
creation('empty batch','edit',{expectedRevision:revision,operations:[]},false);
const op={op:'storyboard.create',name:'New'};
for(const n of [32,64,65])creation('batch count '+n,'edit',{expectedRevision:revision,operations:Array.from({length:n},()=>op)});
creation('mixed operation/batch','edit',{expectedRevision:revision,operation:op,operations:[op]},false);
creation('capture in batch','edit',{expectedRevision:revision,operations:[{op:'director.capture'}]},false);
creation('UTF16 name boundary valid','edit',{expectedRevision:revision,operation:{...op,name:'😀'.repeat(30)}},true);
creation('UTF16 name boundary invalid','edit',{expectedRevision:revision,operation:{...op,name:'😀'.repeat(31)}},false);
// Exercise every schema node against exact native recursive matcher, including optional fields.
const visited=new Set();
function walk(s,path){const key=JSON.stringify(s);if(visited.has(key))return;visited.add(key);
 if(s.oneOf){s.oneOf.forEach((x,i)=>walk(x,path+'.'+i));return;}
 const good=sample(s);add('schema '+path,'schema',good,true,{schema:s});
 if(s.enum)for(const v of s.enum)add('enum '+path+' '+v,'schema',v,true,{schema:s});
 if(s.type==='string'){
  add('string overrun '+path,'schema','a'.repeat(s.maxLength+1),false,{schema:s});
  add('string control '+path,'schema','a\u0001',false,{schema:s});
  if(s.pattern)for(const v of ['', '../secret','file:/secret','☃','a'.repeat(121),'#12345g','#123456','#ABCDEF'])add('pattern '+path+' '+v.slice(0,20),'schema',v,v.length>=(s.minLength??0)&&v.length<=s.maxLength&&new RegExp(s.pattern,'u').test(v),{schema:s});
 }
 if(s.type==='number'||s.type==='integer'){for(const [v,e]of [[s.minimum,true],[s.maximum,true],[s.minimum-1,false],[s.maximum+1,false]])add('number boundary '+path+' '+v,'schema',v,e,{schema:s});if(s.type==='integer')add('fraction '+path,'schema',s.minimum+0.5,false,{schema:s});}
 if(s.type==='object'){for(const[k,v]of Object.entries(s.properties))walk(v,path+'.'+k);add('unknown field '+path,'schema',{...good,__unknown:true},false,{schema:s});}
 if(s.type==='array'){walk(s.items,path+'[]');if(s.uniqueItems)add('duplicate '+path,'schema',[sample(s.items),sample(s.items)],false,{schema:s});}
}
Object.entries(CREATION_SCHEMAS).forEach(([k,s])=>walk(s,k));
add('unknown regex denies','schema','valid',false,{schema:{type:'string',minLength:0,maxLength:160,pattern:'.*'}});
const context={version:1,canvasId:'canvas-1',canvasName:'Canvas',snapshotRevision:revision,nodes:[],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false}};
const node={id:'node-1',title:'Node',kind:'text',text:'abc',editable:true,revision,textTruncated:true,textRange:{start:0,end:3,total:10}};
const covered={...context,nodes:[node],coverage:{mode:'target',totalNodes:3,returnedNodes:1,offset:0,textComplete:false}};
const safe=(fn,...args)=>{try{fn(...args);return true;}catch{return false;}};
function ctx(name,value,expected){assert.equal(safe(validateCanvasAgentContext,value,'canvas-1'),expected,'Host '+name);add(name,'context',value,expected);}
ctx('context base',context,true);ctx('context coverage and textRange',covered,true);
for(const mode of ['overview','target','full'])ctx('coverage mode '+mode,{...covered,coverage:{...covered.coverage,mode}},true);
for(const[k,v]of [['mode','anything'],['returnedNodes',2],['offset',-1],['textComplete','yes']])ctx('coverage invalid '+k,{...covered,coverage:{...covered.coverage,[k]:v}},false);
ctx('textRange reversed',{...covered,nodes:[{...node,textRange:{start:4,end:3,total:10}}]},false);
ctx('textRange over total',{...covered,nodes:[{...node,textRange:{start:0,end:11,total:10}}]},false);
const snapshot=(a)=>({canvasId:'canvas-1',conversationId:'conversation-1',sessionId:null,runId:'run-1',status:'running',messages:[],pendingAction:{actionId:'action-1',runId:'run-1',...a}});
const autonomous={mode:'autonomous',allowGeneration:false,maxMediaJobs:0};
for(const mode of ['overview','target','full'])add('readContext '+mode,'snapshot',snapshot({kind:'readContext',readMode:mode,nodeIds:['node-1'],context}),true);
add('readContext text pagination','snapshot',snapshot({kind:'readContext',readMode:'target',nodeIds:['node-1'],textOffset:24000,expectedRevision:revision,context}),true);
for(const patch of [{textOffset:-1},{textOffset:100000001},{nodeIds:[]},{nodeIds:['a','b']},{expectedRevision:null},{readMode:'invalid'}])add('invalid read selector '+JSON.stringify(patch),'snapshot',snapshot({kind:'readContext',readMode:'target',nodeIds:['node-1'],textOffset:24000,expectedRevision:revision,context,...patch}),false);
for(const s of operations){let operation=sample(s);if(operation.op==='referencePack.update')operation.name='a';add('snapshot operation '+operation.op,'snapshot',snapshot({kind:'editCreation',context,execution:autonomous,creationEdit:{expectedRevision:revision,operation}}),true);}
add('snapshot batch','snapshot',snapshot({kind:'editCreation',context,execution:autonomous,creationEdit:{expectedRevision:revision,operations:[op]}}),true);
add('snapshot batch plan denied','snapshot',snapshot({kind:'editCreation',context,execution:{...autonomous,mode:'plan'},creationEdit:{expectedRevision:revision,operations:[op]}}),false);
add('edit read flags denied','snapshot',snapshot({kind:'editCreation',readMode:'full',context,execution:autonomous,creationEdit:{expectedRevision:revision,operation:op}}),false);
const request={op:'actionResult',canvasId:'canvas-1',runId:'run-1',actionId:'action-1',result:{status:'completed',summary:'Done',generatedJobs:0,operationReceipts:[{index:0,summary:'Created'}],context:covered}};
add('operation receipt request','request',request,true);
add('operation receipt negative index','request',{...request,result:{...request.result,operationReceipts:[{index:-1,summary:'x'}]}},false);
add('operation receipt unknown data','request',{...request,result:{...request.result,operationReceipts:[{index:0,summary:'x',path:'/private'}]}},false);
// Task-state is host-only bounded read: a tool display entry is allowed, no new native command authority.
const taskSnapshot={...snapshot({kind:'readContext',context}),tools:[{callId:'call-1',name:'canvas_read_task_state',status:'completed',startedAt:1,endedAt:2}]};
add('task-state tool display','snapshot',taskSnapshot,true);
add('task-state unauthorized pending kind','snapshot',snapshot({kind:'readTaskState',context}),false);
add('taskContext cannot enter native snapshot','snapshot',{...taskSnapshot,taskContext:{goal:'injected'}},false);
add('taskState cannot enter native request','request',{op:'readTaskState',canvasId:'canvas-1'},false);
add('unknown context field denies','context',{...covered,authority:'all'},false);
add('unknown coverage field denies','context',{...covered,coverage:{...covered.coverage,authority:'all'}},false);
add('unknown textRange field denies','context',{...covered,nodes:[{...node,textRange:{...node.textRange,path:'/private'}}]},false);
add('UTF16 textRange supplementary character','context',{...covered,nodes:[{...node,text:'😀',textRange:{start:2,end:4,total:10}}]},true);
add('wrong UTF16 textRange supplementary character','context',{...covered,nodes:[{...node,text:'😀',textRange:{start:2,end:3,total:10}}]},false);
add('receipt cannot claim failed completion','request',{...request,result:{...request.result,status:'failed'}},false);
add('receipt index must be sequential','request',{...request,result:{...request.result,operationReceipts:[{index:1,summary:'wrong'}]}},false);
add('receipt duplicate index denied','request',{...request,result:{...request.result,operationReceipts:[{index:0,summary:'a'},{index:0,summary:'b'}]}},false);
add('creation unknown selector denied','snapshot',snapshot({kind:'readCreation',context,creationQuery:{scope:'overview'},readMode:'full'}),false);
add('unknown read selector denied','snapshot',snapshot({kind:'readContext',context,selector:'all'}),false);
// Every Director change variant passes both single and atomic-batch native transport.
const changes=operations.find(s=>s.properties.op.const==='director.edit').properties.change.oneOf;
for(const schema of changes){for(const all of [false,true]){const change=sample(schema,all);const operation={op:'director.edit',boardId:'board-1',change};const name=change.action+(all?' all fields':' required');creation('Director '+name,'edit',{expectedRevision:revision,operation},true);creation('Director batch '+name,'edit',{expectedRevision:revision,operations:[operation]},true);add('Director snapshot '+name,'snapshot',snapshot({kind:'editCreation',context,execution:autonomous,creationEdit:{expectedRevision:revision,operation}}),true);}}
const captures={op:'director.capture',boardId:'board-1',shotId:'shot-1',name:'Frame'};
creation('valid capture rejected inside batch','edit',{expectedRevision:revision,operations:[captures]},false);
for(const n of [64,65]){const value={...request,result:{...request.result,operationReceipts:Array.from({length:n},(_,index)=>({index,summary:'done'}))}};add('receipt count '+n,'request',value,n===64);}
const script={op:'storyboard.importScript',boardId:'board-1',sourceText:'a'.repeat(100000)};
creation('byte limit below','edit',{expectedRevision:revision,operations:[script,script]},true);
creation('byte limit above','edit',{expectedRevision:revision,operations:[script,script,script]},false);
const rustSource=fs.readFileSync(new URL('../../src-tauri/src/dsh_host.rs',import.meta.url),'utf8');
const nativeSchema=JSON.parse(rustSource.match(/const CANVAS_CREATION_SCHEMAS_JSON: &str = r###"(.*?)"###;/s)[1]);
const schemaParity=JSON.stringify(nativeSchema)===JSON.stringify(CREATION_SCHEMAS);
const sourceProof=JSON.parse(fs.readFileSync(process.env.NATIVE_CANVAS_SOURCE_PROOF??'/tmp/luckyray-native-canvas-contracts/source-proof.json','utf8'));
assert.equal(createHash('sha256').update(rustSource).digest('hex'),sourceProof.sha256,'Production source changed: rerun prepare and cargo build');
const bin=process.env.NATIVE_CANVAS_BIN??'/tmp/luckyray-native-canvas-contracts/target/debug/luckyray-native-canvas-contracts';
const run=spawnSync(bin,[],{input:cases.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',maxBuffer:64*1024*1024});
assert.equal(run.status,0,run.stderr);
const actual=run.stdout.trim().split('\n').map(JSON.parse);assert.equal(actual.length,cases.length);
const failed=cases.flatMap((v,i)=>actual[i]===v.expected?[]:[{name:v.name,expected:v.expected,actual:actual[i],mode:v.mode,kind:v.kind,value:v.value}]);
const report={schemaParity,total:cases.length,passed:cases.length-failed.length,failed:failed.length,operations:operations.map(s=>s.properties.op.const),source:sourceProof,failures:failed};
fs.writeFileSync(process.env.NATIVE_CANVAS_REPORT??'/tmp/luckyray-native-canvas-contracts/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,failures:failed.slice(0,30)},null,2));process.exitCode=failed.length||!schemaParity?1:0;
