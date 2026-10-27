const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const source=fs.readFileSync(root+'/src/features/notes/NotesPage.tsx','utf8');
const createItems=source.slice(source.indexOf('<div role="menuitem" className="note-ctx-item-react"'),source.indexOf('<div className="note-ctx-sep-react" />',source.indexOf('<div role="menuitem" className="note-ctx-item-react"')));
(async()=>{
const result=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React,{useState,useMemo,useCallback}from'react';import{createRoot}from'react-dom/client';
import{FolderTree}from'./src/features/folders/FolderTree';
import{I18nProvider,useI18n}from'./src/core/i18n';
import{isNoteMargin,useNoteDisplayMenu}from'./src/features/notes/editor/noteDisplay';
import{InlineFilename}from'./src/features/notes/editor/noteFilename';
import{parseNotePreviewBlocks,parseNoteFrontmatter}from'./src/core/services/noteRenderer';
const normalizeNoteLinkKey=s=>s.toLowerCase(),noteTitle=n=>n.title;
const IconPlus=()=>null;
import{NotePreview}from'./src/features/notes/NotePreview';
window.actions=[];
function Fixture(){const[noteCtx,setNoteCtx]=useState(null);const[text,setText]=useState('# Parent\\nparent body\\n## Child\\nchild body\\n# Next\\nnext body');
window.previewText=setText;window.docMenu=parent=>setNoteCtx({note:{folderId:parent}});
const openCreateDocumentDialog=parent=>window.actions.push(['note',parent]);const setDialog=dialog=>window.actions.push(['folder',dialog.parentId]);
return <><div id='tree'><FolderTree scope='notes' folders={[{id:'folder',name:'Target folder',parentId:null,open:true,children:[]}]} selectedId={null} onSelect={()=>{}}
onCreate={p=>window.actions.push(['folder',p])} onCreateNote={p=>window.actions.push(['note',p])}/></div>
{noteCtx&&<div role='menu' aria-label='document-create'>${createItems}</div>}
<div id='preview'><NotePreview text={text} currentNoteId='fixture' notes={[{id:'fixture',title:'Fixture title'}]} assets={[]} tags={[]} noteLinks={[]} noteEmbeds={[]} onOpenNote={()=>{}} onCreateNote={()=>{}} onOpenAsset={()=>{}}/></div></>}
createRoot(document.getElementById('root')).render(<I18nProvider locale='zh-CN'><Fixture/></I18nProvider>);
`},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'}});
const css=['src/features/notes/notes.css','src/features/folders/folders.css','src/features/notes/editor/noteDisplay.css'].map(f=>fs.readFileSync(root+'/'+f,'utf8')).join('\n');
const server=http.createServer((q,r)=>{
if(q.url==='/__close'){r.end('closed');server.close();return}
if(q.url==='/app.js'){r.setHeader('content-type','text/javascript');r.end(result.outputFiles[0].text);return}
if(q.url==='/style.css'){r.setHeader('content-type','text/css');r.end(css);return}
r.setHeader('content-type','text/html');r.end('<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{background:#141417;color:#eee;--text-primary:#eee;--text-tertiary:#aaa;--accent:#8785ff;font:14px sans-serif}#root{display:flex;height:650px}#tree{width:270px}#preview{width:1000px}.folder-list{min-height:300px}</style><div id="root"></div><script src="/app.js"></script>');
}).listen(18764,'127.0.0.1',()=>console.log('menus fixture ready'));
})();
