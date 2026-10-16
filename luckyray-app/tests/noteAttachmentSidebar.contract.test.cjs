const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const sidebar = fs.readFileSync(root+'/src/features/notes/NoteAttachmentSidebar.tsx','utf8');
const grouping = sidebar.slice(sidebar.indexOf('export function groupNoteAttachments'), sidebar.indexOf('\nfunction Thumbnail')).replace('export function','function');
const group = new Function(esbuild.transformSync(grouping,{loader:'ts'}).code+';return groupNoteAttachments;')();
test('groups project many-to-many catalog references without copying entities or crossing Vaults',()=>{
  const asset={id:'image',name:'same.png'};
  const references=[{vaultId:'V',notePath:'Z.md'},{vaultId:'V',notePath:'A.md'},{vaultId:'V',notePath:'A.md'},{vaultId:'OTHER',notePath:'private.md'}];
  const result=group([{asset,references}],'V','Z.md');
  assert.deepEqual(result.map(([name])=>name),['Z.md','A.md']);
  assert.equal(result[0][1][0],asset);assert.equal(result[1][1][0],asset);assert.equal(result[1][1].length,1);
});
const notes = fs.readFileSync(root+'/src/features/notes/NotesPage.tsx','utf8');
const marker='const publishExistingAssetMarkdown = useCallback(';
const start=notes.indexOf(marker)+marker.length;
const callback=esbuild.transformSync('const publish = '+notes.slice(start,notes.indexOf('\n  }, [',start)+4),{loader:'ts'}).code;
function fixture(){
  let resolve;const state={source:{},note:'A',content:'before cursor after',selection:{start:7,end:13},pane:'p',mode:'live'};
  const context={selectedNote:{id:'A'},isRealVaultNoteId:()=>true,readActiveKnowledgeWriteSource:()=>state.source,
    readActiveEditorValue:()=>state.content,readActiveEditorSelection:()=>state.selection,
    editorMode:'live',
    captureAttachmentInsertSession:expectedMode=>({source:state.source,noteId:state.note,noteRequest:1,pane:state.pane,paneEpoch:0,mode:expectedMode,modeEpoch:0}),
    attachmentInsertSessionIsCurrent:session=>session.source===state.source&&session.noteId===state.note&&session.pane===state.pane&&session.mode===state.mode,
    sameAttachmentSelection:(a,b)=>a.start===b.start&&a.end===b.end,
    selectedNoteIdRef:{get current(){return state.note;}},realVaultRelativePathFromNoteId:id=>id,
    captureAttachmentContext:async()=>({}),attachmentContextIsCurrent:()=>true,
    allAssets:[],preparePublishedAttachment:async(_context,result)=>({markdown:result.markdown}),
    publishVaultAttachment:()=>new Promise(done=>resolve=done)};
  return {state,publish:new Function('context',`with(context){${callback};return publish;}`)(context),waitForPublish:async()=>{while(!resolve)await Promise.resolve()},complete:()=>resolve({markdown:'![asset](attachments/asset.png)'})};
}
test('attachment publication keeps a blurred editor selection and returns the unified link',async()=>{
  const f=fixture();const pending=f.publish({id:'asset',name:'asset.png'});await f.waitForPublish();
  f.complete();assert.equal((await pending).markdown,'![asset](attachments/asset.png)');assert.deepEqual(f.state.selection,{start:7,end:13});
});
test('late attachment publication cannot insert into a replaced note, pane, selection or source',async()=>{
  for(const change of ['note','pane','mode','content','selection','source']){
    const f=fixture();const pending=f.publish({id:'asset',name:'asset.png'});await f.waitForPublish();
    f.state[change]=change==='selection'?{start:0,end:0}:change==='source'?{}:'changed';
    f.complete();await assert.rejects(pending,/重新插入|重试/);
  }
});
