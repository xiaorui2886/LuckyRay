import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SlotCore } from './fixtures/dsh-ui-slots-0.2.1-rc.2/index.mjs';
const require=createRequire(import.meta.url);
const ui=require('../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js');
function setup() {
 const core=new SlotCore(), effects=[];
 core.register({name:'root',children:{'shell.overlay':{kind:'list',scope:'root'},'main.conversation':{kind:'single',scope:'session-maybe'},'conversation.hero.brand.mark':{kind:'single',scope:'root'}}},()=>null);
 const main=()=>null,header=()=>null;
 core.register({name:'main.conversation',children:{'conversation.header':{kind:'single',scope:'session-maybe'}}},main);
 core.register({name:'conversation.header',children:{'conversation.header.leading':{kind:'single',scope:'root'},'conversation.session.header':{kind:'single',scope:'session'}}},header);
 const baseline={main:core.entries('main.conversation')[0],header:core.entries('conversation.header')[0]};
 const ctx={layout:{toggleSidebar(){},selectPanel(){}},effect(fn){const d=fn();effects.push(d);return d;},slots:{inject(name,fn){if(!core.spec(name))return()=>{};return fn();},register:(...args)=>core.register(...args)}};
 const install=()=>ui.registerMobileConversation(ctx,()=>({}),()=>null);
 return {core,ctx,effects,baseline,install};
}
test('actual official SlotCore rejects the old duplicate-child shape',()=>{
 const {core}=setup();
 assert.throws(()=>core.register({name:'main.conversation',priority:-20,children:{'conversation.header':{kind:'single',scope:'session-maybe'}}},()=>null),/already declared/);
 assert.throws(()=>core.register({name:'conversation.header',priority:-20,children:{'conversation.header.leading':{kind:'single',scope:'root'}}},()=>null),/already declared/);
});
test('mobile retains exact official main/header registrations and their ownership',()=>{
 const {core,baseline,install}=setup();const dispose=install();
 assert.equal(core.entries('main.conversation')[0],baseline.main);assert.equal(core.entries('conversation.header')[0],baseline.header);
 assert.equal(core.entries('main.conversation').length,1);assert.equal(core.entries('conversation.header').length,1);
 assert.equal(core.entries('shell.overlay').length,1);assert.equal(core.entries('conversation.hero.brand.mark')[0].options.priority,-20);
 dispose();assert.equal(core.entries('shell.overlay').length,0);assert.equal(core.entries('main.conversation')[0],baseline.main);assert(core.spec('conversation.header.leading'));
});
test('duplicate apply is idempotent, unload cleans only mobile, and reapply succeeds',()=>{
 const {core,effects,install,baseline}=setup();const d=install();assert.equal(install(),d);assert.equal(effects.length,1);assert.equal(core.entries('shell.overlay').length,1);
 effects[0]();d();assert.equal(core.entries('shell.overlay').length,0);assert.equal(core.entries('conversation.header')[0],baseline.header);
 const next=install();assert.notEqual(next,d);assert.equal(core.entries('shell.overlay').length,1);next();
});
test('registration or lifecycle failure rolls back and does not poison retry',()=>{
 for(const stage of ['register','effect']) {
  const {core,ctx,install}=setup();const original=ctx.slots.register, effect=ctx.effect;
  if(stage==='register')ctx.slots.register=(o,c)=>{if(o.name==='conversation.hero.brand.mark')throw Error('controlled');return original(o,c);};
  else ctx.effect=()=>{throw Error('controlled');};
  assert.throws(install,/controlled/);assert.equal(core.entries('shell.overlay').length,0);assert.equal(core.entries('conversation.hero.brand.mark').length,0);
  ctx.slots.register=original;ctx.effect=effect;install()();assert.equal(core.entries('shell.overlay').length,0);
 }
});
test('non-mobile apply leaves official registration tree alone',()=>{
 const {core,ctx,baseline}=setup();const old=global.document;
 global.document={defaultView:{location:{search:''}}};ctx.theme={overrideTokens(){}};
 try {ui.createClientModule(name=>name==='react/jsx-runtime'?{jsx:()=>null}:{}).apply(ctx);} finally {global.document=old;}
 assert.equal(core.entries('main.conversation')[0],baseline.main);assert.equal(core.entries('conversation.header')[0],baseline.header);assert.equal(core.entries('shell.overlay').length,0);
});
