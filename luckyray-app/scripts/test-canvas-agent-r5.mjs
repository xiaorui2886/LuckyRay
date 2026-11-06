import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,process.env.LR_R5_TEST_OUTPUT||'output/canvas-agent-r5-verification');mkdirSync(output,{recursive:true});
const groups=[
 ['types',['node_modules/typescript/bin/tsc','--noEmit']],
 ['asset-pins',['--test','tests/dshHostAssetBindings.contract.test.mjs']],
 ['runtime-carrier',['--test','tests/dshCanvasAgent.test.mjs','tests/dshCanvasAgentR5.test.mjs','tests/dshCanvasAgentHost.contract.test.mjs','tests/dshCanvasAgentR5Transport.test.mjs','tests/dshCanvasAgentCarrier.integration.test.mjs','tests/dshCanvasAgentServices.test.mjs','tests/dshCanvasAgentReasoningWire.test.mjs','tests/canvasAgentR5EndToEnd.test.mjs']],
 ['core',['--experimental-strip-types','--import','./tests/ts-extension-loader.mjs','--test','tests/canvasAgentClient.test.ts','tests/canvasAgentPlan.test.ts','tests/canvasAgentReferences.test.ts','tests/canvasAgentActionLedger.test.ts','tests/canvasAgentNavigation.test.ts','tests/canvasAgentWorkspaceExecution.test.ts','tests/canvasAgentGraphEdit.test.ts']],
 ['react',['--test','src/features/canvas/useCanvasAgent.test.cjs','src/features/canvas/CanvasAgentPanel.test.cjs']],
];
let failed=false;const results=[];
for(const [name,args] of groups){const run=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',maxBuffer:16*1024*1024});const log=(run.stdout||'')+(run.stderr||'');writeFileSync(join(output,`${name}.log`),log);const result={name,status:run.status===0?'PASS':'FAIL',exitCode:run.status,signal:run.signal};results.push(result);console.log(`${name}: ${result.status}`);if(run.status!==0){failed=true;console.error(log.slice(-7000));}}
writeFileSync(join(output,'summary.json'),JSON.stringify({node:process.version,results,notRun:['Windows native compile/WebView2','real provider/model/media calls','browser screenshot (run separate fixture)']},null,2)+'\n');
process.exitCode=failed?1:0;
