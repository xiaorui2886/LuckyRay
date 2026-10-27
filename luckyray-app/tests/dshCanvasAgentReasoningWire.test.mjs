import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Official installed adapter, entirely synthetic auth and intercepted transport.
// No endpoint is contacted; capture the body just before the actual fetch boundary.
test('official DeepSeek adapter serializes selected effort and omits output_config when off', {
  skip: !process.env.DSH_CANVAS_TEST_NODE_MODULES,
}, async t => {
  const {DeepSeekAdapter,resolveAdapterOptions}=await import(pathToFileURL(join(process.env.DSH_CANVAS_TEST_NODE_MODULES,'@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href);
  const config=resolveAdapterOptions({baseURL:'https://synthetic.invalid',models:[{id:'synthetic-model'}]});
  const adapter=new DeepSeekAdapter({options:()=>config,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-test',prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  const original=globalThis.fetch;const bodies=[];
  globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(init.body));throw Error('synthetic transport capture');};
  t.after(()=>{globalThis.fetch=original;});
  const info=await adapter.resolveModel('synthetic','synthetic-model');
  assert.deepEqual(info.reasoning.efforts.map(e=>e.id),['off','low','high','max']);
  for(const reasoningEffort of ['low','high','max','off']){
    await assert.rejects(async()=>{for await(const _chunk of adapter.stream({provider:'synthetic',model:'synthetic-model',reasoningEffort,messages:[{role:'user',content:[{type:'text',text:'Synthetic prompt'}]}]})){};});
    const body=bodies.at(-1);assert.ok(body,'must reach intercepted HTTP payload boundary');
    assert.equal(body.model,'synthetic-model');
    assert.deepEqual(body.thinking,{type:reasoningEffort==='off'?'disabled':'enabled'});
    if(reasoningEffort==='off')assert.equal(Object.hasOwn(body,'output_config'),false);
    else assert.deepEqual(body.output_config,{effort:reasoningEffort});
  }
  assert.equal(bodies.length,4);
});
