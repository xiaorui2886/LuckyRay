import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkFisherImage} from '../src/core/canvas/workFisherPreset.ts';
import {createComfyVideoGenerator} from '../src/core/services/canvasComfyUi.ts';

const makeRequest=(preset,refs=[])=>({kind:'image',model:'local',prompt:'synthetic',references:refs,comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:'synthetic',workflow:buildWorkFisherImage({preset,prompt:'synthetic',referenceCount:refs.length})}});
const reference={id:'ref-a',kind:'image',role:'reference',mediaUrl:'data:image/png;base64,iVBORw0KGgo='};
test('image result uses the existing task and materializes its own image path',async()=>{
  const calls=[];const generate=createComfyVideoGenerator(async(command,args)=>{calls.push([command,args]);return command.endsWith('submit')?{clientTaskId:'a',promptId:'p',state:'succeeded'}:{clientTaskId:'a',state:'succeeded',imagePath:'C:/synthetic/result.png'};},async()=>{});
  const result=await generate(makeRequest('work-fisher-character'),'a');
  assert.equal(result.imageUrl,'C:/synthetic/result.png');assert.equal(result.videoUrl,undefined);
  assert.deepEqual(calls.map(([command])=>command),['canvas_comfyui_submit','canvas_comfyui_materialize']);
});
test('three-view uploads the selected image once and a resumed task never reopens it',async()=>{
  const calls=[];let accepted=false;
  const generate=createComfyVideoGenerator(async(command,args)=>{
    calls.push([command,args]);
    if(command.endsWith('submit')) {
      if(args.request.resumeOnly && !accepted)throw 'comfyui-task-not-found';
      if(!args.request.resumeOnly){accepted=true;assert.equal(args.request.images[0].nodeId,'9000');assert.equal(args.request.images[0].dataUrl,reference.mediaUrl);}
      return {clientTaskId:'b',promptId:'p',state:'succeeded'};
    }
    return {clientTaskId:'b',state:'succeeded',imagePath:'C:/synthetic/views.png'};
  },async()=>{});
  const request=makeRequest('work-fisher-three-view',[reference]);
  assert.equal((await generate(request,'b')).imageUrl,'C:/synthetic/views.png');
  const before=calls.length;assert.equal((await generate(request,'b')).imageUrl,'C:/synthetic/views.png');
  assert.equal(calls.filter(([name,args])=>name.endsWith('submit')&&!args.request.resumeOnly).length,1);
  assert.equal(calls[before][1].request.resumeOnly,true);assert.equal(calls[before][1].request.images,undefined);
});
