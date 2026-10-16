import {readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const explicit=new Set([
 'integratedToolbarCapture.contract.test.ts','integratedShell.contract.test.ts','controlPointerDrag.contract.test.ts','pointerActivation.contract.test.ts',
 'nativeTabDrag.contract.test.ts','notesLayoutReopen.contract.test.ts','notesDocumentSource.contract.test.ts',
 'noteRuntime.contract.test.ts','nativeNoteRuntime.contract.test.ts','noteViewActionGuard.contract.test.ts',
 'sourceNoteEditor.contract.test.ts','graphSessionStore.contract.test.ts','graphTabPointerDrag.contract.test.ts',
 'scopedGraphRuntime.contract.test.ts',
]);
const files=readdirSync(resolve(root,'tests')).filter(name=>explicit.has(name)||/^workspace.*\.contract\.test\.ts$/.test(name)||/^notesPane.*\.contract\.test\.ts$/.test(name)).sort().map(name=>`tests/${name}`);
function run(label,args){
 console.log(`\n=== ${label} ===`);
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
console.log('Focused checkpoint checks. These do NOT execute Rust, real Windows gestures, or browser/native resource enforcement.');
run('TypeScript/pure contracts',['--experimental-strip-types','--import','./tests/ts-extension-loader.mjs','--test',...files]);
run('Production Notes source/parity',['--test','tests/notesProductionSafety.contract.cjs','tests/noteSurfaceParity.contract.cjs']);
for(const path of ['node_modules/typescript/bin/tsc','node_modules/vite/bin/vite.js'])if(!existsSync(resolve(root,path)))throw Error(`Missing installed local tool: ${path}. No package installation attempted.`);
run('Typecheck',['node_modules/typescript/bin/tsc','--noEmit','--pretty','false']);
if(!process.argv.includes('--no-build'))run('Production build',['node_modules/vite/bin/vite.js','build']);
