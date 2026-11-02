import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const app=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
const fixture=JSON.parse(fs.readFileSync(path.resolve(process.argv[4]),'utf8'));
const require=createRequire(path.join(fs.realpathSync(path.join(app,'node_modules/vite')),'package.json'));
const esbuild=require('esbuild');
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'./src/core/i18n/index';
import{NoteMedia}from'./src/features/notes/media/NoteMedia';import{LiveMarkdownEditor}from'./src/features/notes/editor/LiveMarkdownEditor';
import './src/features/notes/notes.css';import './src/features/notes/editor/liveMarkdown.css';import './src/features/notes/media/noteMedia.css';
const input=${JSON.stringify(fixture)},cases=[['read-small','read','tiny',32,24],['read-regular','read','regular',320,240],['live-small','live','tiny',32,24],['live-regular','live','regular',320,240]];
window.fixtureSource=input.source;window.fixtureEvents=[];window.fixtureCases=cases.map(([id,mode,kind,width,height])=>({id,mode,width,height}));
window.readMediaCase=selector=>{const button=document.querySelector(selector),media=button?.closest('.note-media');return {...(new Function(input.probe))(selector),focusWithin:!!media?.matches(':focus-within'),controlFocused:!!media?.contains(document.activeElement)&&document.activeElement?.tagName==='BUTTON'};};
function Case({value}){const[id,mode,kind]=value,asset={id:kind+'.png',name:kind+'.png',kind:'image',previewUrl:input[kind],thumbnailUrl:input[kind]};
const opened=()=>window.fixtureEvents.push(id);return <section id={id} className='fixture-case'><h2>{id}</h2><div className='note-editor-area'><div className='note-content-area'>
{mode==='read'?<div className='note-preview'><p><NoteMedia asset={asset} alt={kind} onOpenAsset={opened}/></p></div>:<LiveMarkdownEditor currentNoteId={id} value={'![[val]]'.replace('val',asset.name)} assets={[asset]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={[{targetName:asset.name,assetId:asset.id,isMissing:0}]} onChange={()=>{}} onContextMenu={()=>{}} onOpenAsset={opened}/>}
</div></div><button type='button' data-fixture-focus-end={id}>Keyboard boundary</button></section>};createRoot(document.getElementById('root')).render(<I18nProvider locale='zh-CN'><main className='fixture-grid'>{cases.map(value=><Case key={value[0]} value={value}/>)}</main></I18nProvider>);`;
const built=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:app},define:{'import.meta.env.DEV':'false'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl'}});
const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text;
const css=built.outputFiles.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
const shell=fs.readFileSync(path.join(app,'src/app/appShell.css'),'utf8');
const reset=shell.slice(0,shell.indexOf('}')+1);
const layout=`body{margin:16px;font-family:sans-serif}.fixture-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.fixture-case{width:min(360px,100%)}.fixture-case h2{font-size:12px}.fixture-case>.note-editor-area{height:260px;border:1px solid #777}.fixture-case .note-content-area{height:100%;min-height:0}.fixture-case .lr-live-editor{height:100%}`;
const html='<!doctype html><html><meta charset="utf-8"><title>Owned media toolbar component fixture</title><style>'+reset+css+layout+'</style><body class="react-nav-shell"><div id="root"></div><script>'+js.replaceAll('</script','<\\/script')+'</script></body></html>';
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.html'),html);
console.log(JSON.stringify({status:'FIXTURE_BUILT_NOT_RENDERED',cases:4,htmlBytes:Buffer.byteLength(html),source:'actual NoteMedia and LiveMarkdownEditor, actual production CSS; not Main product acceptance'}));
