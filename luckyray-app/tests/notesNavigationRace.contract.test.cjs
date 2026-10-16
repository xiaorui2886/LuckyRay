const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = process.env.LUCKYRAY_NAVIGATION_BASELINE
  ? execFileSync('git', ['show', 'a825a93:luckyray-app/src/features/notes/NotesPage.tsx'], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(root + '/src/features/notes/NotesPage.tsx', 'utf8');
const ast = ts.createSourceFile('NotesPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(result, name); return result;
}
function harness() {
  const pending = new Map(), revealed = [], synced = [];
  let session = 1;
  const c = {
    useCallback: fn => fn, activeNotesSplitPane: 'pane', activeNotesSplitPaneRef: {current:'pane'},
    notesPaneLoadRequestRef: {current:new Map()}, selectedNoteIdRef:{current:null},
    notesPaneActiveTabs: {pane:'real-vault:B.md'}, notesPaneDocuments:{pane:{'real-vault:B.md':{title:'B',contentText:'B draft',loaded:true}}},
    setNotesPaneTabs:()=>{},setNotesPaneActiveTabs:()=>{},setActiveNotesSplitPane:()=>{},setNotesPaneActivationVersion:()=>{},
    setNotes:()=>{},setNotesPaneDocument:()=>{},setStatus:()=>{},t:x=>x,
    vaultSessionRef:{current:{latest:()=>session,isCurrent:s=>s===session}},
    realVaultDocumentSource:{openDocument:p=>new Promise(resolve=>pending.set(p,resolve))},
    isRealVaultNoteId:id=>id.startsWith('real-vault:'), realVaultRelativePathFromNoteId:id=>id.slice('real-vault:'.length),
    noteFromKnowledgeDocument:d=>d,noteTitle:d=>d.title,
    syncActiveNotesPaneDocument:(_pane,tab,doc)=>{c.selectedNoteIdRef.current=tab.id;synced.push({id:tab.id,content:doc.contentText});},
    revealDocumentInFolderTree:id=>revealed.push(id),
  };
  vm.createContext(c);
  vm.runInContext(ts.transpileModule(`${extract('loadNotesPaneDocument')}\n${extract('openNotesSplitPaneNote')}\nthis.open=openNotesSplitPaneNote;`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
  return {c,pending,revealed,synced,switchVault(){session++;}};
}
test('late uncached A cannot overwrite or reveal after cached B opens',async()=>{
  const h=harness();
  const openingA=h.c.open('pane','real-vault:A.md',{scrollList:true});
  assert.equal(await h.c.open('pane','real-vault:B.md',{scrollList:true}),true);
  h.pending.get('A.md')({id:'real-vault:A.md',title:'A',contentText:'late A'});
  assert.equal(await openingA,false);
  assert.equal(h.c.selectedNoteIdRef.current,'real-vault:B.md');
  assert.deepEqual(h.synced,[{id:'real-vault:B.md',content:'B draft'}]);
  assert.deepEqual(h.revealed,['real-vault:B.md']);
});
test('late source response after vault session change cannot sync or reveal',async()=>{
  const h=harness();const opening=h.c.open('pane','real-vault:A.md',{scrollList:true});
  h.switchVault();h.pending.get('A.md')({id:'real-vault:A.md',title:'A',contentText:'old source'});
  assert.equal(await opening,false);assert.deepEqual(h.synced,[]);assert.deepEqual(h.revealed,[]);
});
