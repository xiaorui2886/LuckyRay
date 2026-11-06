const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const fs=require('node:fs');
const root=process.env.SOURCE_ROOT||path.resolve(__dirname,'..');const deps=process.env.TEST_DEPS_ROOT||path.join(root,'node_modules');const esbuild=require(path.join(deps,'esbuild'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'comfy-revision-'));
for(const file of ['context','creationEngine'])esbuild.buildSync({entryPoints:[path.join(root,'src/core/canvas/agent',file+'.ts')],outfile:path.join(dir,file+'.cjs'),bundle:true,platform:'node',format:'cjs',nodePaths:[deps],logLevel:'silent'});
const {agentNodeRevision}=require(path.join(dir,'context.cjs'));const {creationRevision}=require(path.join(dir,'creationEngine.cjs'));
const node=()=>({id:'test-1',position:{x:0,y:0},data:{kind:'generator',generationKind:'video',generationPrompt:'synthetic'}});
for(const [key,value] of Object.entries({generationSource:'comfyui',generationComfy:{seed:123,duration:10},generationComfyWorkflow:{baseUrl:'http://127.0.0.1:8188',workflow:{}}}))test('Agent stale protection includes '+key,()=>{const before=node(),after={...before,data:{...before.data,[key]:value}};assert.notEqual(agentNodeRevision(before),agentNodeRevision(after));const state=n=>({canvasId:'c',nodes:[n],edges:[],history:[]});assert.notEqual(creationRevision(state(before)),creationRevision(state(after)));});
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
