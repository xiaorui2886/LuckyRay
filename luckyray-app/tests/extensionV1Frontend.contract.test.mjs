import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require=createRequire(import.meta.url);
const esbuild=createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle=await esbuild.build({entryPoints:[fileURLToPath(new URL("../src/core/extensions/runtime.ts",import.meta.url))],bundle:true,format:"esm",write:false,plugins:[{name:"controlled-transport",setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:"transport",namespace:"fixture"}));b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export const invoke=(...a)=>globalThis.fixtureInvoke(...a)"}));}}]});
const {runPlugin,validatePluginUi}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
test("abort while awaiting poll must never dispatch the returned write",async()=>{
 const operations=[];let reply;let polled;const ready=new Promise(r=>polled=r);
 globalThis.fixtureInvoke=async(_,{request})=>{const req=JSON.parse(request);operations.push(req.op);if(req.op==="start")return {token:"t"};if(req.op==="poll"){polled();return new Promise(r=>reply=r)}if(req.op==="dispatch")throw Error("dispatch after abort");};
 const controller=new AbortController();const running=runPlugin("fixture",{materialIds:[],canvasIds:[],knowledge:null,writes:true,theme:{}},{},controller.signal,()=>{});await ready;controller.abort();reply({kind:"call",request:{method:"materials.tags",params:{id:"a",revision:"1",tags:["x"]}}});await assert.rejects(running,/plugin-cancelled/);assert.equal(operations.includes("dispatch"),false);assert.ok(operations.includes("close"));
});
test("UI accepts bounded text and discards executable/HTML properties",()=>{
 const ui=validatePluginUi({title:"<script>x</script>",html:"<img onerror=x>",actions:[{id:"a",label:"<b>Run</b>",onclick:"evil()"}]});assert.deepEqual(ui,{title:"<script>x</script>",actions:[{id:"a",label:"<b>Run</b>"}]});assert.throws(()=>validatePluginUi({title:"x",fields:Array(9).fill({id:"x",label:"x",value:"x"})}));assert.throws(()=>validatePluginUi({title:"x",text:"x".repeat(16001)}));
});
