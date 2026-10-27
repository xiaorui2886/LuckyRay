import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { companionGrantEnabled } from "../src/core/services/companionAccess.ts";

// Execute the real manager callbacks, replacing only rendering/hooks and IPC.
function harness(configured = true) {
  const state: any = {status:{state:"running"},devices:[{deviceId:"fixture",label:"Synthetic phone"}],services:{fixture:{permissionRevision:7,authorizationConfigured:configured,authorizationMode:"manual",grants:[],savedLibraries:[{scopeKind:"vault",scopeId:"v1",label:"Synthetic vault",available:true}]}},grantBusy:{},grantLoading:{},grantErrors:{}};
  const calls:any[] = [], slots:any[] = []; let cursor=0;
  const jsx=(type:any,props:any)=>({type,props});
  const authSource=readFileSync(new URL("../src/features/settings/PhoneAuthorizationChoice.tsx",import.meta.url),"utf8");
  const source=readFileSync(new URL("../src/features/settings/PhoneAccessManager.tsx",import.meta.url),"utf8");
  const auth:any={}, target:any={};
  const requireMock=(id:string):any=>{
    if(id==="react")return {useId:()=>"fixture",useEffect:()=>{},useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(value:any)=>slots[i]=value];}};
    if(id==="react-dom")return {createPortal:(child:any)=>child};
    if(id==="react/jsx-runtime")return {jsx,jsxs:jsx};
    if(id.endsWith("i18n/index"))return {defineMessages:(v:any)=>v,useMessages:(copy:any)=>({t:(k:string)=>copy[k]["en-US"]})};
    if(id.endsWith("PhoneAuthorizationChoice"))return auth;
    if(id.endsWith("companionAccess"))return {companionGrantEnabled};
    if(id.endsWith("companionPresentationStore"))return {companionDeviceDisplayLabel:()=>"Synthetic phone"};
    if(id.endsWith("CompanionPresentation"))return {useCompanionSnapshot:()=>state};
    if(id.endsWith("applicationModalIsolation"))return {useApplicationModalSurface:()=>({})};
    if(id.endsWith(".css"))return {};
    throw Error(id);
  };
  for(const [code,result] of [[authSource,auth],[source,target]] as const)new Function("require","exports","document",ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(requireMock,result,{querySelector:()=>null,body:{}});
  const store={toggleService:async(...args:any[])=>calls.push(args),setAuthorizationMode:async(...args:any[])=>{calls.push(args);return true;}};
  const walk=(node:any):any[]=>!node||typeof node!=="object"?[]:Array.isArray(node)?node.flatMap(walk):[node,...walk(node.props?.children)];
  const render=()=>{cursor=0;return walk(target.default({store,deviceId:"fixture"}));};
  return {state,calls,render,button:(text:string)=>render().find(n=>n.type==="button"&&n.props.children===text)};
}
test("library permissions use accessible switches and preserve exact scoped toggle",()=>{
  const h=harness(); const switches=h.render().filter(n=>n.props?.role==="switch");
  assert.equal(switches.length,4);assert.ok(switches.every(n=>n.props["aria-checked"]===false));
  assert.equal(h.calls.length,0);switches[0].props.onClick();
  assert.deepEqual(h.calls,[["fixture",{grantClass:"content.read",scopeKind:"vault",scopeId:"v1"}]]);
});
test("legacy authorization and missing connection stay disabled despite visual restoration",()=>{
  const h=harness(false);assert.ok(h.render().filter(n=>n.props?.role==="switch").every(n=>n.props.disabled));
  assert.equal(h.calls.length,0);
  h.state.services.fixture.authorizationConfigured=true;h.state.status=null;
  assert.ok(h.render().filter(n=>n.props?.role==="switch").every(n=>n.props.disabled));
});
test("changing mode requires fresh explicit choice and version-checked confirmation",async()=>{
  const h=harness();h.button("Change mode…").props.onClick();
  const choice=h.render().find(n=>typeof n.type==="function");assert.equal(choice.props.value,null);
  assert.equal(h.calls.length,0);choice.props.onChange("trusted");
  assert.equal(h.calls.length,0);const confirm=h.button("Confirm trust and continue");assert.equal(confirm.props.disabled,false);
  await confirm.props.onClick();assert.equal(h.calls[0][0],"fixture");assert.equal(h.calls[0][1],"trusted");assert.equal(h.calls[0][2].permissionRevision,7);
});
test("scope revision changes prevent confirmation, cancellation makes no writes",()=>{
  const h=harness();h.button("Change mode…").props.onClick();h.render().find(n=>typeof n.type==="function").props.onChange("trusted");
  h.state.services.fixture.permissionRevision=8;assert.equal(h.button("Confirm trust and continue").props.disabled,true);
  h.button("Cancel").props.onClick();assert.equal(h.calls.length,0);assert.equal(h.render().some(n=>n.props?.role==="dialog"),false);
});
