const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const postcss=require('postcss');
const dir=path.join(__dirname,'../src/features/materials');
const css=fs.readFileSync(path.join(dir,'materialLibraryDialogPolish.css'),'utf8');
const root=postcss.parse(css);
function value(selector,prop){let result;root.walkRules(r=>{if(r.selectors.includes(selector))r.walkDecls(prop,d=>result=d.value)});return result;}
test('management has one scroll owner; task details do not create nested scrollbars',()=>{
 assert.equal(value('.material-library-management-body','overflow'),'auto');
 assert.equal(value('.material-library-management .material-library-list','overflow'),'visible');
 assert.equal(value('.material-library-management .material-library-legacy-watch','overflow'),'visible');
 assert.equal(value('.material-library-tasks-dialog .material-transfer-task ul','overflow'),'visible');
 assert.equal(value('.material-library-management-body','scrollbar-width'),'none');
 assert.match(fs.readFileSync(path.join(dir,'MaterialLibrarySwitcher.tsx'),'utf8'),/material-library-management-body" tabIndex=\{0\}/);
});
test('appearance uses semantic surfaces and shared 10% divider without global overrides',()=>{
 assert.match(css,/--library-dialog-divider:color-mix\(in srgb,var\(--text-primary\) 10%,transparent\)/);
 root.walkRules(r=>assert.ok(r.selectors.every(s=>/material-library|material-transfer/.test(s)),r.selector));
 assert.match(css,/var\(--theme-surface-panel,var\(--bg-surface\)\)/);
 assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/data-animations=off/);
 assert.match(css,/:focus-visible\{outline:2px solid var\(--accent\)/);
});
test('JSX presentation compiles and keeps existing actions, errors and task branches',()=>{
 const ts=require('typescript');
 for(const name of ['MaterialLibrarySwitcher.tsx','MaterialLibraryAutoImport.tsx','MaterialLibraryTransferUI.tsx']){
 const result=ts.transpileModule(fs.readFileSync(path.join(dir,name),'utf8'),{fileName:name,compilerOptions:{jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});
 assert.equal(result.diagnostics.filter(x=>x.category===ts.DiagnosticCategory.Error).length,0);
 }
 const auto=fs.readFileSync(path.join(dir,'MaterialLibraryAutoImport.tsx'),'utf8');
 assert.match(auto,/<summary tabIndex=\{0\}>导入规则与目录/);
 assert.match(auto,/<\/details>\s*\{changedRoot/);assert.match(auto,/role="alert"/);
 const transfer=fs.readFileSync(path.join(dir,'MaterialLibraryTransferUI.tsx'),'utf8');
 assert.match(transfer,/dialog\?\.kind === "tasks" \? " material-library-tasks-dialog" : ""/);
 assert.match(transfer,/materialLibraryTransfers\.cancel\(task\)/);assert.match(transfer,/materialLibraryTransfers\.retry\(task\)/);
});
