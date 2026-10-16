import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { createServer } from "vite";
import { mergeRecentAttachmentResolutions } from "../src/core/markdown/realVaultEmbeds.ts";
import { resolveAssetEmbed } from "../src/features/notes/editor/noteAssetResolver.ts";
import { parseNoteInline } from "../src/core/services/noteRenderer.ts";
import { readFileSync } from "node:fs";

async function modules() {
  const server=await createServer({root:fileURLToPath(new URL("..",import.meta.url)),server:{middlewareMode:true,hmr:false},appType:"custom"});
  return {server, widgets:await server.ssrLoadModule("/src/features/notes/editor/assetEmbedWidgets.ts"), extensions:await server.ssrLoadModule("/src/features/notes/editor/liveMarkdownExtensions.ts")};
}
test("Markdown image at insertion/click boundary stays one complete replacement; interior remains editable",async()=>{
  const {server,extensions}=await modules();
  try {
    const token=`![authored alt](./attachments/${"a".repeat(64)}.png)`;const text=`Intro\n\n${token}\n\nAfter`;const from=7,to=from+token.length;
    for(const cursor of [0,from,to,to-2]){
      const field=extensions.liveMarkdownPreview({assets:[{id:"image",name:"image.png",kind:"image",previewUrl:"fixture://image"}],notes:[],tags:[],noteLinks:[],noteEmbeds:[{targetName:`md:./attachments/${"a".repeat(64)}.png`,assetId:"image",isMissing:0}]});
      const state=EditorState.create({doc:text,selection:{anchor:cursor},extensions:[field]});const ranges:any[]=[];
      state.field(field).between(from,to,(start:number,end:number,decoration:any)=>{if(decoration.spec.widget?.constructor.name==="AssetEmbedWidget" || decoration.spec.class==="lr-live-asset-source")ranges.push({start,end,decoration});});
      const widget=ranges.find(r=>r.decoration.spec.widget);
      assert.ok(widget);
      if(cursor===to-2) assert.ok(ranges.some(r=>r.decoration.spec.class==="lr-live-asset-source"));
      else {assert.equal(widget.start,from);assert.equal(widget.end,to);assert.equal(text.slice(widget.start,widget.end),token);assert.ok(!ranges.some(r=>r.decoration.spec.class==="lr-live-asset-source"));}
    }
  } finally {await server.close();}
});

class Element {
  tagName:string;children:Element[]=[];dataset:Record<string,string>={};className="";textContent="";contentEditable="";innerHTML="";
  style={setProperty:(_key:string,_value:string)=>{},width:"",maxWidth:""};classList={add:()=>{},remove:()=>{}};
  parentNode:Element|null=null;src="";alt="";complete=false;naturalWidth=0;naturalHeight=0;onload:Function|null=null;onerror:Function|null=null;
  constructor(tag:string){this.tagName=tag.toUpperCase();}
  append(...nodes:Element[]){for(const node of nodes)this.appendChild(node);}
  appendChild(node:Element){node.remove();node.parentNode=this;this.children.push(node);return node;}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
  removeAttribute(name:string){if(name==="src")this.src="";}
  playCount=0; pauseCount=0; currentTime=0;
  duration=2; readyState=4; seeking=false;
  listeners=new Map<string,Function>();
  addEventListener(name:string, callback:Function){this.listeners.set(name,callback);}
  removeEventListener(name:string, _callback:Function){this.listeners.delete(name);}
  play(){this.playCount++;return Promise.resolve();}
  pause(){this.pauseCount++;}
  load(){}
  setAttribute(_name:string,_value:string){}
  getBoundingClientRect(){return {top:0,bottom:100,height:100,width:360};}
  querySelector(selector:string):Element|null {for(const child of this.children){if(child.tagName===selector.toUpperCase())return child;const found=child.querySelector(selector);if(found)return found;}return null;}
}
test("returning to an unchanged image reuses its decoded element; changed URL uses a new resource",async()=>{
  const {server,widgets}=await modules();const previous=globalThis.document;
  try {
    Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
    const make=(url:string)=>new widgets.AssetEmbedWidget({embed:{asset:{id:"image",name:"image.png",kind:"image",previewUrl:url},target:"a.png",display:"authored alt",width:null,missing:false},from:0,to:10,block:true,expanded:true,selected:false});
    const first=make("fixture://image?vault=fixture&v=1");const root=first.toDOM({});const image=root.querySelector("img")!;
    image.complete=true;image.naturalWidth=800;image.naturalHeight=400;image.onload?.();first.destroy(root);
    const second=make("fixture://image?vault=fixture&v=1");const next=second.toDOM({});assert.equal(next.querySelector("img"),image);second.destroy(next);
    const changed=make("fixture://image?vault=fixture&v=2");const changedRoot=changed.toDOM({});assert.notEqual(changedRoot.querySelector("img"),image);changed.destroy(changedRoot);
  } finally {Object.assign(globalThis,{document:previous});await server.close();}
});

test("concurrent widgets have separate images; detached cache evicts old resources",async()=>{
  const {server,widgets}=await modules();const previous=globalThis.document;
  try {
    Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
    const make=(url:string)=>new widgets.AssetEmbedWidget({embed:{asset:{id:"image",name:"image.png",kind:"image",previewUrl:url},target:"a.png",display:"alt",width:null,missing:false},from:0,to:10,block:true,expanded:true,selected:false});
    const first=make("fixture://image?vault=concurrent&v=1"), second=make("fixture://image?vault=concurrent&v=1");
    const a=first.toDOM({}),b=second.toDOM({});assert.notEqual(a.querySelector("img"),b.querySelector("img"));assert.ok(a.querySelector("img"));
    first.destroy(a);second.destroy(b);
    let oldest:Element|null=null;
    for(let i=0;i<14;i++) { const widget=make(`fixture://image?vault=eviction&v=${i}`),root=widget.toDOM({}),image=root.querySelector("img")!;image.complete=true;image.naturalWidth=100;image.naturalHeight=100;image.onload?.();if(i===0)oldest=image;widget.destroy(root); }
    assert.equal(oldest?.src,"");
  } finally {Object.assign(globalThis,{document:previous});await server.close();}
});

test("card clicks land outside source; explicit edit enters source; resizing preserves standard Markdown",async()=>{
  const {server,widgets}=await modules();const previous=globalThis.document;
  try {
    Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
    const token='![authored alt](./attachments/a.png "title")';let position=-1;
    const widget=new widgets.AssetEmbedWidget({embed:{asset:null,target:"a.png",display:"alt",width:null,missing:true,resolutionStatus:"missing"},from:0,to:token.length,block:true,expanded:false,selected:false});
    const root=widget.toDOM({state:EditorState.create({doc:token}),dispatch:(tr:any)=>{position=tr.selection.anchor;},focus:()=>{}});
    root.onmousedown({button:0,clientY:99,preventDefault(){},stopPropagation(){}});assert.equal(position,token.length);
    const edit=root.children.flatMap((node:Element)=>node.children).find((node:any)=>node.title==="编辑引用源码");
    assert.match(edit.innerHTML, /<svg viewBox="0 0 16 16"/);assert.equal(edit.textContent, "");
    edit.onclick({preventDefault(){},stopPropagation(){}});assert.equal(position,token.length-1);
    assert.equal(widgets.resizeAssetReference(token,"a.png",320),'![authored alt|320](./attachments/a.png "title")');
    assert.equal(widgets.resizeAssetReference('![[a.png|200]]',"a.png",320),'![[a.png|320]]');
    widget.destroy(root);
  } finally {Object.assign(globalThis,{document:previous});await server.close();}
});

test("published standalone Vault video links reach the existing hover card in live and reading preview",async()=>{
  const {server,extensions}=await modules();const previous=globalThis.document;
  try {
    Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
    const token='[movie.mp4](./attachments/movie.mp4)';
    const assets=[{id:"video",name:"movie.mp4",kind:"video",previewUrl:"fixture://movie.mp4?vault=v&v=1",thumbnailUrl:"fixture://movie.mp4?vault=v&v=1"}];
    const field=extensions.liveMarkdownPreview({assets,notes:[],tags:[],noteLinks:[],noteEmbeds:[{targetName:"md:./attachments/movie.mp4",assetId:"video",isMissing:0}]});
    const state=EditorState.create({doc:token,selection:{anchor:token.length},extensions:[field]});let widget:any;
    state.field(field).between(0,token.length,(_from:number,_to:number,decoration:any)=>{if(decoration.spec.widget?.constructor.name==="AssetEmbedWidget")widget=decoration.spec.widget;});
    assert.ok(widget,"publication produces a portable link, which must retain the old video presentation");
    const root=widget.toDOM({state,dispatch:()=>{},focus:()=>{}}),video=root.querySelector("video");
    assert.ok(video);assert.equal(root.querySelector("img"),null);assert.equal(video.poster,undefined);
    assert.equal(video.muted,true);assert.equal(video.loop,true);assert.equal(video.playsInline,true);
    root.onmouseenter();assert.equal(video.playCount,1);video.currentTime=1;root.onmouseleave();assert.equal(video.pauseCount,1);assert.equal(video.currentTime,0.25);
    const other=widget.toDOM({state,dispatch:()=>{},focus:()=>{}});assert.notEqual(other.querySelector("video"),video);
    widget.destroy(root);assert.equal(video.src,"");widget.destroy(other);
    assert.equal(parseNoteInline(token)[0].type,"asset");
    for(const ordinary of ['See [movie](./attachments/movie.mp4)', '[remote](https://example.com/movie.mp4)', '[file](./attachments/report.pdf)']) {
      assert.ok(!parseNoteInline(ordinary).some(token=>token.type==="asset"));
    }
  } finally {Object.assign(globalThis,{document:previous});await server.close();}
});

test("external video file URI with Chinese name and parentheses resolves as a standalone card, while inline links remain authored",async()=>{
  const {server,extensions}=await modules();
  try {
    const target='file:///C:/Downloads/%E7%94%9F%E6%88%90%20(1).mp4';
    const token=`[生成 (1).mp4](${target})`;
    const assets=[{id:'registered-video',name:'生成 (1).mp4',kind:'video',previewUrl:'fixture://registered.mp4'}];
    for(const [text,expected] of [[token,1],[`See ${token} for details`,0],[`[remote](https://example.com/movie.mp4)`,0]] as const){
      const field=extensions.liveMarkdownPreview({assets,notes:[],tags:[],noteLinks:[],noteEmbeds:[{targetName:`md:${target}`,assetId:'registered-video',isMissing:0}]});
      const state=EditorState.create({doc:text,selection:{anchor:text.length},extensions:[field]});const widgets:any[]=[];
      state.field(field).between(0,text.length,(_from:number,_to:number,decoration:any)=>{if(decoration.spec.widget?.constructor.name==='AssetEmbedWidget')widgets.push(decoration.spec.widget);});
      assert.equal(widgets.length,expected);
      if(expected)assert.equal(widgets[0].options.embed.asset.id,'registered-video');
      assert.equal(parseNoteInline(text).filter(token=>token.type==='asset').length,expected);
    }
  } finally {await server.close();}
});

test("image loading overrides preserve established card margins, padding, sizing and resize bounds",()=>{
  const css=readFileSync(new URL('../src/features/notes/editor/liveMarkdown.css',import.meta.url),'utf8');
  const overrides=css.slice(css.indexOf('/* Keep the established card geometry.'));
  assert.doesNotMatch(overrides,/margin|padding:6px|max-height:680px|width:100%/);
  assert.match(css,/margin: 8px 0;/);assert.match(css,/padding: 12px 14px 13px;/);
  assert.match(css,/width: min\(360px, 100%\);/);
  assert.match(overrides,/data-image-state="loading"/);
});

test("bounded resolution entries keep returning notes, isolate Vaults, and replace changed or missing results",()=>{
  let cache=mergeRecentAttachmentResolutions({},[["vault-a/root/note/image",{version:"1",status:"resolved"}]],2);
  cache=mergeRecentAttachmentResolutions(cache,[["vault-b/root/note/image",{version:"1",status:"resolved"}]],2);
  assert.equal(Object.keys(cache).length,2);
  cache=mergeRecentAttachmentResolutions(cache,[["vault-a/root/note/image",{version:"2",status:"resolved"}]],2);
  assert.equal(cache["vault-a/root/note/image"].version,"2");
  cache=mergeRecentAttachmentResolutions(cache,[["vault-a/root/note/image",{version:"",status:"missing"}]],2);
  assert.equal(cache["vault-a/root/note/image"].status,"missing");
  cache=mergeRecentAttachmentResolutions(cache,[["vault-c/root/note/image",{version:"1",status:"resolved"}]],2);
  assert.equal(Object.keys(cache).length,2);assert.equal(cache["vault-b/root/note/image"],undefined);
  for(const status of ["pending","missing","ambiguous","unavailable"]){assert.equal(resolveAssetEmbed("a.png",[{targetName:"a.png",assetId:null,isMissing:1,resolutionStatus:status}],[]).resolutionStatus,status);}
});

test("a current note larger than the history limit retains every resolution, then trims on leaving",()=>{
  const entries=Array.from({length:129},(_,index)=>[`vault/root/current/${index}`,{status:"resolved"}] as const);
  let cache=mergeRecentAttachmentResolutions({},entries);
  assert.equal(Object.keys(cache).length,129);assert.equal(cache[entries[0][0]].status,"resolved");
  cache=mergeRecentAttachmentResolutions(cache,[["vault/root/next/one",{status:"resolved"}]]);
  assert.equal(Object.keys(cache).length,128);assert.equal(cache["vault/root/next/one"].status,"resolved");
});

test("a video poster without a playback source stays an image, never a video source", async () => {
  const {server,widgets}=await modules(); const previous=globalThis.document;
  try {
    Object.assign(globalThis,{document:{createElement:(tag:string)=>new Element(tag)}});
    const widget=new widgets.AssetEmbedWidget({embed:{asset:{id:'linked',name:'video.mp4',kind:'video',thumbnailUrl:'http://asset.localhost/poster.jpg'},target:'video.mp4',display:'video',width:null,missing:false},from:0,to:1,block:true,expanded:true,selected:false});
    const root=widget.toDOM({});
    assert.equal(root.querySelector('video'),null);
    assert.equal(root.querySelector('img')?.src,'http://asset.localhost/poster.jpg');
    widget.destroy(root);
  } finally {Object.assign(globalThis,{document:previous});await server.close();}
});

test("reading media renders a poster-only video as an image without inventing a video URL", async () => {
  const {server}=await modules();
  try {
    const {NoteMedia}=await server.ssrLoadModule('/src/features/notes/media/NoteMedia.tsx');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {createElement}=await import('react');
    const html=renderToStaticMarkup(createElement(NoteMedia,{asset:{kind:'video',thumbnailUrl:'http://asset.localhost/poster.jpg'},alt:'Poster'}));
    assert.match(html,/<img/);assert.match(html,/poster\.jpg/);assert.doesNotMatch(html,/<video/);
    const missing=renderToStaticMarkup(createElement(NoteMedia,{asset:{kind:'video'},alt:'Missing'}));
    assert.doesNotMatch(missing,/<video|src=""/);
  } finally {await server.close();}
});

test("native video controls retain playback when an earlier hover play promise settles", async () => {
  const {server}=await modules();
  try {
    const {attachVideoPreview}=await server.ssrLoadModule('/src/features/notes/editor/videoPreview.ts');
    const video=new Element('video');let release!:()=>void;
    Object.assign(video,{play:()=>new Promise<void>(resolve=>{release=resolve;})});
    const controller=attachVideoPreview(video,{source:'fixture.mp4',controls:true,onState:()=>{}});
    controller.enter();
    video.listeners.get('pointerdown')?.();
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(video.pauseCount,0,'late hover completion must not pause native control playback');
    controller.leave();assert.equal(video.pauseCount,0);
    controller.destroy();assert.equal(video.pauseCount,1);
    assert.equal(video.listeners.has('pointerdown'),false);
  } finally {await server.close();}
});

test("play rejection retains a decoded frame and does not diagnose a codec without MEDIA_ERR_DECODE", async () => {
  const {server}=await modules();
  try {
    const {attachVideoPreview}=await server.ssrLoadModule('/src/features/notes/editor/videoPreview.ts');
    for(const [name,code,expected] of [['NotAllowedError',null,'浏览器阻止'],['NotSupportedError',4,'视频源不可用'],['Error',3,'视频解码失败'],['Error',2,'视频预览读取失败']] as const){
      const video=new Element('video');
      Object.assign(video,{error:code?{code}:null,play:()=>Promise.reject(Object.assign(new Error('fixture'),{name}))});
      let last:any;
      const controller=attachVideoPreview(video,{source:'fixture.mp4',onState:(state:string,message:string)=>{last={state,message};}});
      controller.enter();await new Promise(resolve=>setImmediate(resolve));
      assert.ok(last.message.includes(expected));
      if(!code){assert.equal(last.state,'ready');assert.ok(!last.message.includes('编码'));}
      controller.destroy();
    }
    for(const poster of ['', 'fixture.jpg']){
      const pending=new Element('video');Object.assign(pending,{readyState:0,play:()=>Promise.reject(Object.assign(new Error(),{name:'NotAllowedError'}))});
      let state='';const session=attachVideoPreview(pending,{source:'fixture.mp4',thumbnail:poster,onState:(value:string)=>{state=value;}});
      session.enter();await new Promise(resolve=>setImmediate(resolve));assert.equal(state,poster?'ready':'error');session.destroy();
    }
    const alive=new Element('video');let aliveState='';Object.assign(alive,{play:()=>Promise.reject(Object.assign(new Error(),{name:'AbortError'}))});
    const aliveSession=attachVideoPreview(alive,{source:'fixture.mp4',onState:(state:string)=>{aliveState=state;}});
    aliveSession.enter();await new Promise(resolve=>setImmediate(resolve));assert.notEqual(aliveState,'error');aliveSession.destroy();
    const video=new Element('video');let last:any;
    Object.assign(video,{play:()=>Promise.reject(Object.assign(new Error(),{name:'AbortError'}))});
    const controller=attachVideoPreview(video,{source:'fixture.mp4',onState:(state:string,message:string)=>{last={state,message};}});
    controller.enter();controller.destroy();await new Promise(resolve=>setImmediate(resolve));
    assert.notEqual(last.state,'error');
  }finally{await server.close();}
});

test("external Markdown dimension title reaches the existing live widget and reading token", async () => {
  const {server,extensions}=await modules();
  try {
    const token='![picture.png](file:///C:/images/picture.png "width=300 height=200")';
    const field=extensions.liveMarkdownPreview({assets:[{id:"image",name:"picture.png",kind:"image",previewUrl:"fixture://image"}],notes:[],tags:[],noteLinks:[],noteEmbeds:[{targetName:"md:file:///C:/images/picture.png",assetId:"image",isMissing:0}]});
    const state=EditorState.create({doc:token,selection:{anchor:0},extensions:[field]});
    let widget:any;state.field(field).between(0,token.length,(_a:number,_b:number,d:any)=>{if(d.spec.widget?.constructor.name==="AssetEmbedWidget")widget=d.spec.widget;});
    assert.ok(widget);assert.equal(widget.options.embed.width,300);assert.equal(widget.options.embed.height,200);assert.equal(widget.options.embed.display,"picture.png");
    const reading=parseNoteInline(token).find(item=>item.type==="asset");assert.ok(reading?.type==="asset");assert.equal(reading.width,300);assert.equal(reading.height,200);
    for(const bad of ['width=0','width=100001','width=300 height=-1','width=300 onclick=evil']) {
      const result=parseNoteInline(`![picture](./picture.png "${bad}")`).find(item=>item.type==="asset");assert.ok(result?.type==="asset");assert.equal(result.width,null);
    }
  } finally {await server.close();}
});

test("unregistered external widget shows localized connection guidance without changing resolution",async()=>{
 const {server,widgets}=await modules();const previous=globalThis.document;
 try {
  for(const locale of ["zh-CN","en-US"]) {
   Object.assign(globalThis,{document:{documentElement:{lang:locale},createElement:(tag:string)=>new Element(tag)}});
   const widget=new widgets.AssetEmbedWidget({embed:{asset:null,target:"file:///C:/outside.png",display:"outside.png",width:null,missing:true,resolutionStatus:"external-unregistered"},from:0,to:10,block:true,expanded:true,selected:false});
   const root=widget.toDOM({});const text=(node:Element):string=>node.textContent+node.children.map(text).join(" ");
   assert.match(text(root),locale==="zh-CN"?/外部文件尚未连接，请重新选择原文件/:/External file is not connected/);
   assert.doesNotMatch(text(root),/external-unregistered/);assert.equal(root.dataset.lrTokenMissing,"1");
  }
 }finally{Object.assign(globalThis,{document:previous});await server.close();}
});
