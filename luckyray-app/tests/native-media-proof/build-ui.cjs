// Generated test page only. Production components/styles, engineering IPC bridge.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const rawSvg={name:'raw-svg',setup(build){build.onResolve({filter:/\.svg\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.replace(/\?raw$/,'')),namespace:'raw-svg'}));build.onLoad({filter:/.*/,namespace:'raw-svg'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'text'}))}};
(async()=>{
 const src=fs.readFileSync(root+'/src/features/materials/MaterialsPage.tsx','utf8');
 const viewer=src.slice(src.indexOf('function MaterialViewer('),src.indexOf('\nfunction ImportProgressOverlay('));
 const controls=src.slice(src.indexOf('function AssetHoverControls('),src.indexOf('\nfunction AssetCard('));
 const checkbox=src.slice(src.indexOf('function BatchCheckbox('),src.indexOf('// ========== 详情面板'));
 const out=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
 import{NativeVideoInline}from'./src/features/materials/NativeVideoInline';
 import{matchesShortcut,isTextEntry}from'./src/app/shortcuts';
 import{useMaterialViewerHost}from'./src/features/materials/useMaterialViewerHost';
 import{useMaterialViewScope}from'./src/features/materials/MaterialViewContext';
 import{NativeVideoHover}from'./src/features/materials/NativeVideoHover';
 import{cachedNativeVideoCover}from'./src/features/materials/nativeVideoCoverCache';
 import{FavoriteGlyph}from'./src/components/FavoriteGlyph';
 import{MaterialFilmViewer}from'./src/features/materials/MaterialFilmViewer';
 import{resolveMaterialViewerBounds}from'./src/features/materials/materialViewerGeometry';
 import{resolveContainedMaterialMediaRect,resolveMaterialMediaDimensions,resolveMaterialVideoPlaybackPath,resolveMaterialVideoSource,shouldDismissMaterialViewerFromBlank}from'./src/features/materials/materialViewerInteraction';
 const useI18n=()=>({t:key=>key}),FileIcon=()=>null,ImagePreview=()=>null,isVideoAsset=()=>true,isImageAsset=()=>false,getAdjacentAsset=()=>null,resolveVideoPreviewUrl=async()=>'';
 ${viewer}
 const getAssetKindLabel=()=> '视频',getStorageModeShortLabel=()=> '链接';
 ${controls}
 ${checkbox}
 const pending=[],waiters=new Map();let sequence=0;window.nativePending=pending;
 window.nativeReply=(id,result,error)=>{const q=waiters.get(id);waiters.delete(id);error?q.reject(Error(error)):q.resolve(result)};
 window.__TAURI_INTERNALS__={invoke:(command,{request})=>new Promise((resolve,reject)=>{const id=++sequence;waiters.set(id,{resolve,reject});pending.push({id,command,request})})};
 // Reproduce retained library DOM behind the portaled viewer. In the previous
 // selector-only implementation these hidden descendants erased native pixels.
 const retained=document.createElement('div');retained.className='masonry-item video-card-react';retained.style.cssText='position:fixed;inset:0;opacity:0';retained.innerHTML='<div class="card-name" style="position:absolute;inset:0">retained card</div><button class="asset-favorite-fab-react" style="position:absolute;inset:0;width:100%;height:100%;opacity:1">hidden action</button>';document.body.append(retained);
 const host=createRoot(document.getElementById('fixture-host')),asset={id:'owned-fixture',name:'Synthetic H264.mp4',mimeType:'video/mp4',originalPath:'synthetic:owned'};
 const close=()=>host.render(<p>closed</p>);window.closeViewer=close;
 window.showFilm=()=>{document.querySelector('.materials-layout').inert=true;host.render(<MaterialFilmViewer asset={asset} libraryId="fixture" resolveSource={async()=>''} onClose={close} onFrame={()=>{}}/>)};
 window.showHover=(ratio=.2,serial=0)=>{document.querySelector('.materials-layout').inert=false;host.render(<div className="masonry-item video-card-react" style={{position:'fixed',left:120,top:40,width:360,height:280}}><BatchCheckbox checked={false} onClick={()=>{}}/><AssetHoverControls asset={asset} onPreview={()=>{}} isFavorite={false} onToggleFavorite={()=>{}}/><div className="hover-video-wrap-react" style={{height:'100%'}}><img alt="poster must disappear" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='red'/%3E%3C/svg%3E"/><NativeVideoHover libraryId="fixture" assetId="owned-fixture" metadata={{width:640,height:360,duration:8,codec:'hevc',sourceRevision:'owned-revision'}} position={{ratio,serial}} onProgress={()=>window.hoverReady=true}/><div className="hover-video-progress-react"><span style={{width:'50%'}}/></div></div></div>)};
 host.render(<MaterialViewer asset={asset} libraryId="fixture" assets={[asset]} mode="detail" onClose={close} onChange={()=>{}} onOpenOriginal={()=>{}}/>);
 `},bundle:true,write:false,outfile:'fixture.js',minify:true,jsx:'automatic',plugins:[rawSvg],define:{'process.env.NODE_ENV':'"production"'}});
 const css=fs.readFileSync(root+'/src/features/materials/materials.css','utf8')+'\n'+out.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const html='<meta charset="utf-8"><style>'+css+'html,body{margin:0;background:#151515;color:white;width:100%;height:100%;--bg-primary:#151515;--theme-canvas-workspace:#151515;--bg-elevated:#19191a;--radius-md:10px}#root,.proof-shell,#page-materials{position:fixed;inset:0;background:#151515}.materials-layout{position:absolute;inset:0;background:red}.proof-overlay{position:fixed;z-index:999999;left:16px;top:16px;width:100px;height:70px;background:red;border:0}.video-card-react :is(.batch-checkbox-react,.asset-hover-badges-react,.asset-preview-fab-react,.asset-favorite-fab-react,.hover-video-progress-react){opacity:1;transform:none}</style><div id="root"><div class="proof-shell"><div id="page-materials"><div class="materials-layout" inert><div id="fixture-host"></div></div></div></div></div><button class="proof-overlay" data-native-video-overlay>Overlay</button><script>'+out.outputFiles.find(f=>f.path.endsWith('.js')).text.replaceAll('</script','<\\/script')+'</script>';
 fs.mkdirSync(__dirname+'/generated',{recursive:true});fs.writeFileSync(__dirname+'/generated/ui.html',html);
 console.log('Generated production preview/film composition page, bytes='+Buffer.byteLength(html));
})().catch(e=>{console.error(e);process.exitCode=1});
