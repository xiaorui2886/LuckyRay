// Offline/synthetic checks only: never logs in or sends a generation request.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const run=args=>execFileSync(process.execPath,args,{cwd,stdio:'inherit',env:process.env});
run(['node_modules/typescript/bin/tsc','--noEmit']);
run(['--experimental-strip-types','--import','./tests/ts-extension-loader.mjs','--test',...["tests/canvasArkProtocols.contract.test.ts", "tests/canvasEasyCliAutoProtocol.test.ts", "tests/canvasGenerationConnectionUi.test.ts", "tests/canvasGenerationDraftRestore.test.ts", "tests/canvasGenerationEditorSnapshot.test.ts", "tests/canvasGenerationErrors.test.ts", "tests/canvasGenerationIteration.test.ts", "tests/canvasGenerationSave.test.ts", "tests/canvasGenerationScheduler.test.ts", "tests/canvasGenerationSubmit.test.ts", "tests/canvasMediaGenerationReadiness.test.ts", "tests/canvasMediaDiagnosticsR10.test.ts", "tests/canvasMediaFollowup.test.ts", "tests/canvasMediaOptionsPresentation.test.ts", "tests/canvasMediaProfiles.contract.test.ts", "tests/canvasMediaProfilesR10.test.ts", "tests/canvasMediaWireChain.test.ts", "tests/canvasNativeImageCapabilities.test.ts", "tests/canvasVideoRecoveryR10.test.ts", "tests/noteMediaFirstOpen.contract.test.ts", "tests/noteMediaReadiness.contract.test.ts", "tests/canvasIntegration.contract.test.ts", "tests/canvasGenerationPresentation.contract.test.mjs"]]);
run(['--test','tests/doubaoRemoval.contract.test.mjs']);
if(process.argv.includes('--with-dom')){
 if(!process.env.LR_TEST_TOOLS)throw Error('Set LR_TEST_TOOLS to an existing test tools directory containing node_modules/jsdom. DOM NOT_RUN.');
 run(['--test','tests/canvasGenerationConnectionUi.dom.test.cjs','tests/canvasGenerationConnectionUi.render.test.cjs','tests/canvasSettingsDialog.dom.test.cjs','tests/canvasSettingsModelPicker.dom.test.cjs','src/features/canvas/CanvasSettingsDialog.contract.test.mjs']);
}else console.log('React DOM NOT_RUN; use --with-dom and LR_TEST_TOOLS.');
console.log('Windows native build, live provider generation/billing and live concurrency: NOT_RUN.');
