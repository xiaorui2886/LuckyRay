import test from 'node:test';
import assert from 'node:assert/strict';
import {agentContextNodes,agentGraphRevision} from '../src/core/canvas/agent/context.ts';
import {validateCanvasAgentContext} from '../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs';
const text='开头'+('字🙂'.repeat(23000))+'结尾';
const node={id:'long',data:{kind:'text',label:text}};
test('long arbitrary text is exactly recoverable beyond 24000 chars with UTF-16-safe explicit ranges',()=>{
 let offset=0,joined='',pages=0;const total=text.length;
 while(offset<total){const [value]=agentContextNodes([node],['long'],offset);assert.ok(value.textRange);assert.equal(value.textRange.start,offset);assert.equal(value.textRange.total,total);assert.ok(value.textRange.end>offset);assert.ok(!/[\ud800-\udbff]$/.test(value.text));joined+=value.text;offset=value.textRange.end;pages++;}
 assert.equal(joined,text);assert.ok(pages>2);
});
test('range and snippet metadata stay honest and invalid offsets reject',()=>{
 const [value]=agentContextNodes([node],['long']);assert.equal(value.textTruncated,true);assert.equal(value.textRange?.end,value.text.length);
 for(const offset of [-1,1.1,Infinity,100000001])assert.throws(()=>agentContextNodes([node],['long'],offset));
 const context={version:1,canvasId:'canvas',canvasName:'Test',snapshotRevision:agentGraphRevision([node],[]),nodes:[value],connections:[],generation:{imageModels:[],videoModels:[],imageReady:false,videoReady:false},coverage:{mode:'full',totalNodes:1,returnedNodes:1,offset:0,textComplete:false}};
 assert.doesNotThrow(()=>validateCanvasAgentContext(context,'canvas'));
 assert.throws(()=>validateCanvasAgentContext({...context,nodes:[{...value,textRange:{start:0,end:1,total:text.length}}]},'canvas'));
});
