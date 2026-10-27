const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const notesSource=process.env.KNOWLEDGE_R8_BASELINE === '1' ? require('node:child_process').execFileSync('git',['show','055c47e:luckyray-app/src/features/notes/NotesPage.tsx'],{cwd:root,encoding:'utf8'}) : fs.readFileSync(root+'/src/features/notes/NotesPage.tsx','utf8');
const extract=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const remember=extract(notesSource,'const rememberPublishedAttachment = useCallback(', 'const insertPickedReference = useCallback(');
const replace=extract(notesSource,'const replaceEditorRange = useCallback(', 'const applyAutocompleteItem = useCallback(');
const createNote=extract(notesSource,'const createNote = useCallback(', 'const openCreateDocumentDialog = useCallback(');
const renameNote=extract(notesSource,'const commitFilename = useCallback(', 'const renameDocumentFromTree = useCallback(');
const applyTree=extract(notesSource,'const applyRealVaultStoreSnapshot = useCallback(', 'const loadRealVaultTree = useCallback(');
const prepareSource=fs.readFileSync(root+'/src/features/notes/media/preparePublishedAttachment.ts','utf8');
const prepare=prepareSource.slice(prepareSource.indexOf('export async function')).replace('export async function','async function');
(async()=>{
// Reproduce the R2 end-of-document arrow defect without editing the worktree.
const baseline = process.env.KNOWLEDGE_R2_BASELINE === '1' ? [{name:'r2-editor',setup(build){build.onLoad({filter:/(LiveMarkdownEditor\.tsx|liveMarkdownExtensions\.ts|assetEmbedWidgets\.ts)$/},args=>{const file=path.relative(root,args.path).replaceAll('\\','/');return {contents:require('node:child_process').execFileSync('git',['show','21221c3:./'+file],{cwd:root,encoding:'utf8'}),loader:file.endsWith('.tsx')?'tsx':'ts'}})}}] : [];
if(process.env.KNOWLEDGE_R8_BASELINE === '1')baseline.push({name:'r8-baseline',setup(build){build.onLoad({filter:/(LiveMarkdownEditor\.tsx|noteDisplay\.tsx|noteFilename\.tsx|retainedEditorViews\.ts)$/},args=>{const file=path.relative(root,args.path).replaceAll('\\','/');return {contents:require('node:child_process').execFileSync('git',['show','055c47e:luckyray-app/'+file],{cwd:root,encoding:'utf8'}),loader:file.endsWith('.tsx')?'tsx':'ts'}})}});
const built=await esbuild.build({plugins:baseline,stdin:{resolveDir:root,loader:'tsx',contents:`
import React,{useState,useRef,useCallback}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{LiveMarkdownEditor}from'./src/features/notes/editor/LiveMarkdownEditor';
import{EditorView}from'@codemirror/view';
import{materialBlockInsertion,materialBlockSelection}from'./src/core/markdown/materialBlockInsertion';
import{warmRecentImage}from'./src/features/notes/media/noteImageResources';
import{mergeAttachmentBatch,attachmentResolutionMatches}from'./src/core/services/vaultAttachmentResolution';
import{standardMarkdownReferences}from'./src/core/markdown/realVaultEmbeds';
import{resolveMaterialPreviewTarget}from'./src/core/services/materialCatalog';
import{replaceEditorContent}from'./src/core/services/editor';
import{applyEditorCommand}from'./src/core/services/editor';
import{NoteFilenameContext,filenameDOM,updateFilenameDOM}from'./src/features/notes/editor/noteFilename';
window.checkPendingFilenameNavigation=async()=>{
 const calls=[],finished=[];let resolve;const actions=()=>({namingId:null,busyId:'real-vault:A.md',finish:id=>finished.push(id),rename:(id,name)=>{calls.push([id,name]);return new Promise(r=>resolve=r)}});
 const host=filenameDOM('real-vault:A.md','A',actions,false);document.body.append(host);
 const input=host.querySelector('input');input.value='A renamed';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
 const reused=updateFilenameDOM(host,'real-vault:B.md','B',actions,false);host.remove();resolve('real-vault:A renamed.md');await new Promise(r=>setTimeout(r,0));
 return {reused,calls,finished};
};
const realVaultRelativePathFromNoteId=id=>id+'.md';
const resolveVaultAttachment=async()=>({status:'resolved',absolutePath:'/cold.svg',relativePath:'cold.svg',candidates:['cold.svg'],version:String(++window.version)});
const convertFileSrc=path=>path;
window.version=0;
window.treeProjection=options=>{
 const calls=[],useCallback=fn=>fn,locale='zh',t=x=>x;
 const buildRealVaultUiTree=tree=>({folders:[],notes:tree.map(id=>({id}))});
 const selectedNoteIdRef={current:'new'},renamingNoteRef={current:options.renaming?'old':null};
 const openTabsRef={current:[{id:'new',kind:'note'}]};
 const filterSavedNoteTabs=()=>null,readSavedNoteTabsState=()=>null,isEmptyNoteTab=t=>t.kind==='empty',createEmptyNoteTab=()=>({id:'empty',kind:'empty'});
 const setRealVaultTree=x=>calls.push('tree'),setRealVaultMarkdownIndex=x=>calls.push('index'),setNotes=x=>calls.push('notes'),setSelectedFolderId=x=>{},setActiveEmptyTabId=x=>calls.push(['empty',x]),setSelectedNoteId=x=>calls.push(['id',x]),setSelectedNote=x=>calls.push(['note',x]),setEditTitle=x=>calls.push(['title',x]),setEditContent=x=>calls.push(['content',x]),setSourceContentDraft=x=>{},setOpenTabs=x=>calls.push(['tabs',x]);
 ${applyTree}
 applyRealVaultStoreSnapshot(options.fresh?['new']:['old'],null,'vault');
 return calls;
};
window.workflow=async(options={})=>{
 const useCallback=fn=>fn;
 const renamingNoteRef={current:null},setRenamingNoteId=()=>{},commitCurrentEditorDraftRef={current:()=>{}};
 const saveAffectedAttachmentNotes=async()=>{};
 const calls=[],source={},selectedFolderId='folder',selectedNoteIdRef={current:'real-vault:folder/old.md'};
 const readActiveKnowledgeWriteSource=()=>source,t=k=>k,setStatus=s=>calls.push(['status',s]);
 const loadRealVaultTree=async options=>calls.push(['tree',options]);const realVaultNoteId=p=>'real-vault:'+p;
 const selectNote=async(id,opts)=>calls.push(['select',id,opts]),setEditorMode=m=>calls.push(['mode',m]),setNamingNoteId=id=>calls.push(['naming',id]);
 let attempt=0;
 const createKnowledgeDocument=async input=>{calls.push(['create',input]);if(options.fail)throw Error('disk failure');if(attempt++<(options.conflicts||0))throw Object.assign(Error('conflict'),{code:'knowledge-name-conflict'});return {relativePath:input.parentRelativePath+'/'+input.title+'.md',content:input.content}};
 const flushPendingSave=async()=>calls.push(['flush']);const blockRealVaultDocumentOperationIfDirty=()=>Boolean(options.dirty);
 const isRealVaultNoteId=id=>id.startsWith('real-vault:'),realVaultRelativePathFromNoteId=id=>id.slice(11);
 const realVaultDocumentSource={renameDocument:async(path,name)=>{calls.push(['rename',path,name]);if(options.fail)throw Error('name conflict');return {id:'new'}}};
 const applyRealVaultDocumentPathChange=(id,doc)=>{calls.push(['remap',id,doc]);selectedNoteIdRef.current='real-vault:folder/new.md';return selectedNoteIdRef.current};
 ${createNote}
 ${renameNote}
 try{if(options.rename)await commitFilename('real-vault:folder/old.md','new');else await createNote(options.parent)}catch(e){calls.push(['error',e.message])}
 return calls;
};
${prepare}
window.warm=warmRecentImage;
window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));
window.command=async command=>{const h=window.handle,s=h.getSelection();const r=await applyEditorCommand(command,{content:h.getValue(),selectionStart:s.start,selectionEnd:s.end});h.replaceRange(r.content,{start:0,end:h.getValue().length});h.setSelection(r.selection)};
const assets=[{id:'a',name:'a.svg',kind:'image',previewUrl:'/image.svg?vault=fixture&v=0'}];
const embeds=[{targetName:'a.svg',assetId:'a',isMissing:0}];
function Fixture(){const[value,setValue]=useState('before\\n\\n![[a.svg]]\\n\\nafter');const[tick,setTick]=useState(0);
const [fixtureId,setFixtureId]=useState('fixture');
window.openNamingNote=async()=>{setNaming(false);setFixtureId('real-vault:未命名.md');setValue('');await new Promise(r=>setTimeout(r,60));setNaming(true)};
const [naming,setNaming]=useState(false);window.beginNaming=()=>setNaming(true);
const [publishedDraftEmbeds,setPublishedDraftEmbeds]=useState([]),[realVaultAssetMatches,setRealVaultAssetMatches]=useState({});
const currentVault={id:'fixture',rootPath:'fixture'},selectedNoteIdRef=useRef('fixture');
const liveEditorRef=useRef(null),textareaRef=useRef(null),editorMode='live';
const readActiveEditorValue=()=>window.handle.getValue(),readActiveEditorSelection=()=>window.handle.getSelection();
const handleContentChange=setValue,publishActiveNoteContext=()=>{},setSourceContentDraft=()=>{},setActiveEditorSelection=s=>window.handle.setSelection(s);
${remember}
${replace}
window.publish=async()=>{const prepared=await preparePublishedAttachment({documentRef:{vaultId:'fixture'}},{markdown:'![[cold.svg]]'},{id:'new',name:'cold.svg',kind:'image'});const s=readActiveEditorSelection();replaceEditorRange(materialBlockInsertion(readActiveEditorValue(),prepared.markdown,s),s,prepared)};
window.reset=v=>setValue(v);window.refresh=()=>setTick(t=>t+1);window.value=value;
window.reconfigure=()=>{window.rename=(window.rename||0)+1;setTick(t=>t+1)};
window.invalidateSource=()=>{window.revision=(window.revision||0)+1;setTick(t=>t+1)};
window.insert=()=>{const h=window.handle,s=h.getSelection();h.replaceRange(materialBlockInsertion(h.getValue(),'![[a.svg]]',s),s,{markdown:'![[a.svg]]',asset:assets[0],embed:embeds[0]})};
window.insertCold=(url='/cold.svg')=>{const h=window.handle,s=h.getSelection();h.replaceRange(materialBlockInsertion(h.getValue(),'![[cold.svg]]',s),s,{markdown:'![[cold.svg]]',asset:{id:'cold',name:'cold.svg',kind:'image',previewUrl:url},embed:{targetName:'cold.svg',assetId:'cold',isMissing:0}})};
return <NoteFilenameContext.Provider value={{namingId:naming?fixtureId:null,finish:()=>setNaming(false),rename:async(id,name)=>{window.renameCalls=(window.renameCalls||[]).concat([[id,name]]);if(window.renameFailure)throw Error('名称已存在');if(id.startsWith('real-vault:')){await new Promise(r=>setTimeout(r,120));const next='real-vault:'+name+'.md';window.handle.renameDocument?.(id,next);setFixtureId(next);window.fixtureId=next;return next}window.rename=name;setTick(t=>t+1)}}}><LiveMarkdownEditor ref={h=>{window.handle=h;liveEditorRef.current=h}} currentNoteId={fixtureId} value={value} assets={[...assets.map(a=>({...a,previewUrl:window.revision?'/image.svg?vault=fixture&v='+window.revision:a.previewUrl})),...publishedDraftEmbeds.map(i=>i.prepared.asset)]} notes={[{id:fixtureId,title:'fixture'+(window.rename||0),contentText:value}]} tags={[]} noteLinks={[]} noteEmbeds={[...embeds.map(e=>({...e})),...publishedDraftEmbeds.map(i=>i.prepared.embed)]} onChange={setValue}/></NoteFilenameContext.Provider>}
createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'}});
const styles=['src/features/notes/editor/liveMarkdown.css','src/features/notes/editor/noteDisplay.css','src/features/notes/media/noteMedia.css','src/features/notes/media/imageViewer.css','src/features/notes/media/noteContent.css'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n');
const server=http.createServer((q,r)=>{
 if(q.url==='/__close'){r.end('closed');server.close();return}
 if(q.url==='/app.js'){r.setHeader('content-type','text/javascript');return r.end(built.outputFiles[0].text)}
 if(q.url==='/style.css'){r.setHeader('content-type','text/css');return r.end(styles)}
 if(q.url.startsWith('/image.svg')){r.setHeader('content-type','image/svg+xml');const send=()=>{if(q.url.endsWith('v=98')){r.statusCode=404;r.end();return}r.end('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440"><rect width="720" height="440" fill="'+(q.url.endsWith('v=0')?'#527a95':'#697a88')+'"/></svg>')};if(q.url.includes('vault=')&&!q.url.endsWith('v=0'))setTimeout(send,500);else send();return}
 if(q.url.startsWith('/cold.svg')){r.setHeader('content-type','image/svg+xml');setTimeout(()=>r.end('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="980"><rect width="720" height="980" fill="#697a88"/></svg>'),500);return}
 r.setHeader('content-type','text/html');r.end('<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:#111;color:#eee;--text-primary:#eee;--accent:#8785ff;font:16px sans-serif}#root{width:820px;height:650px}.cm-scroller{height:650px}</style><div id="root"></div><script src="/app.js"></script>');
}).listen(18763,'127.0.0.1',()=>console.log('knowledge fixture ready'));
})();
