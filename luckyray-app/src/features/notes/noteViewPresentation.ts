import {history, historyField, undo, redo, undoSelection, redoSelection} from '@codemirror/commands';
import {codeFolding, foldState} from '@codemirror/language';
import {getSearchQuery, search, searchPanelOpen, SearchQuery, setSearchQuery} from '@codemirror/search';
import {EditorState, type Extension} from '@codemirror/state';
import {markdownLanguage} from '@codemirror/lang-markdown';
import {standardMarkdownReferences,isStandaloneVideoReference} from '../../core/markdown/realVaultEmbeds';
import type {NoteAuthority, NoteAttachmentReference, NoteMedia} from './NoteRuntime';

/** Transient handoff only. Never write this payload to layouts, drafts or storage. */
export const NOTE_PRESENTATION_MAX_BYTES = 4 * 1024 * 1024;
export type NoteViewMode = 'live'|'source'|'preview';
export type NoteViewBaseline = {authority:NoteAuthority;revision:string;content:string};
export function shouldReadNoteMetadata(input:{revision:string;dirty:boolean;actionsReady:boolean;readyRevision?:string;readyRuntimeMatches:boolean;invalidationRevision?:number;readyInvalidationRevision?:number}){
  return !!input.revision&&!input.dirty&&input.actionsReady&&(input.readyRevision!==input.revision||!input.readyRuntimeMatches||(input.invalidationRevision??0)!==(input.readyInvalidationRevision??0));
}
export type NoteScroll = {top:number;left:number};
export function captureNoteScroll(element:HTMLElement|null,previous?:NoteScroll):NoteScroll{
  if(!element)return previous||{top:0,left:0};
  if((element.clientHeight<=0||element.clientWidth<=0)&&previous)return {...previous};
  return {top:Math.max(0,element.scrollTop),left:Math.max(0,element.scrollLeft)};
}
export type PortableLiveEditorSnapshot = {
  version:1;
  // Only CodeMirror's explicitly registered field serializers produce this JSON.
  state: {doc:string;selection:unknown;history:unknown;folds:number[]};
  search:{search:string;replace:string;caseSensitive:boolean;literal:boolean;regexp:boolean;wholeWord:boolean;panelOpen:boolean};
  scroll:NoteScroll;
};
export type NoteMediaPlayback = {
  reference:NoteAttachmentReference;occurrence:number;kind:'audio'|'video';
  currentTime:number;volume:number;playbackRate:number;paused:boolean;muted:boolean;
};
export type NoteMediaRefreshPlan={playback:Array<{state:NoteMediaPlayback;version:string}>};
export type NoteViewPresentationSnapshot = NoteViewBaseline & {
  version:1;mode:NoteViewMode;live:PortableLiveEditorSnapshot|null;
  sourceSelection:{start:number;end:number;direction:'forward'|'backward'|'none'};
  sourceScroll:NoteScroll;contentScroll:NoteScroll;media:NoteMediaPlayback[];
};
export interface NotePresentationHandle {
  capture():Promise<NoteViewPresentationSnapshot>;
  restore(snapshot:NoteViewPresentationSnapshot):Promise<void>;
  freeze():void;
  /** Freeze editor input for its own pending action without retiring the
   * requesting surface's caret/generation. The release is synchronous. */
  freezeAction?():()=>void;
  activate():Promise<void>;
  abort():Promise<void>;
}
export type NoteSourcePresentation=Pick<NoteViewPresentationSnapshot,'sourceSelection'|'sourceScroll'>;
export function captureNoteSource(area:HTMLTextAreaElement|null,previous?:NoteSourcePresentation):NoteSourcePresentation{
  return area?{sourceSelection:{start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection},sourceScroll:captureNoteScroll(area,previous?.sourceScroll)}:previous||{sourceSelection:{start:0,end:0,direction:'none'},sourceScroll:{top:0,left:0}};
}
export function portableRetainedEditor(state:EditorState|undefined,content:string,position:NoteScroll):PortableLiveEditorSnapshot|null{
  if(!state)return null;
  // Source mode edits are one explicit editor change, so undo can return to the
  // retained live document without adopting callbacks or attachment URLs.
  const next=state.doc.toString()===content?state:state.update({changes:{from:0,to:state.doc.length,insert:content}}).state;
  return capturePortableLiveEditor(next,position);
}
export function restoreNoteSource(area:HTMLTextAreaElement|null,snapshot:NoteViewPresentationSnapshot){
  if(snapshot.mode!=='source')return;
  if(!area||area.value!==snapshot.content)throw new Error('Note presentation: source editor has not acknowledged content');
  const selection=snapshot.sourceSelection;area.setSelectionRange(selection.start,selection.end,selection.direction);
  area.scrollTop=snapshot.sourceScroll.top;area.scrollLeft=snapshot.sourceScroll.left;
  if(area.selectionStart!==selection.start||area.selectionEnd!==selection.end||area.selectionDirection!==selection.direction)fail('source selection restore was not acknowledged');
}
export function noteContentScrollElement(root:HTMLElement|null):HTMLElement|null{return root?.querySelector<HTMLElement>('.note-preview')||root;}
type NoteLayoutRefs={source:()=>HTMLTextAreaElement|null;content:()=>HTMLElement|null;liveScroll:()=>HTMLElement|null};
/** Media can change the final scroll extent after the editor first mounted.
 * Apply against settled visible geometry, then verify browser readback. */
export async function restoreNotePresentationLayout(snapshot:NoteViewPresentationSnapshot,refs:NoteLayoutRefs,assertCurrent:()=>void,frame:()=>Promise<void>=nextNotePresentationFrame):Promise<void>{
  const deadline=Date.now()+2500;
  let previous='',stable=0,unacknowledgedFrames=0;
  while(stable<3){
    assertCurrent();
    const source=snapshot.mode==='source'?refs.source():null;
    if(snapshot.mode==='source'){if(!source)fail('source editor did not mount');restoreNoteSource(source,snapshot);}
    const content=noteContentScrollElement(refs.content());
    if(!content)fail('content scroll container did not mount');
    const entries:Array<{element:HTMLElement;requested:NoteScroll;current:()=>HTMLElement|null}>=[{element:content!,requested:snapshot.contentScroll,current:()=>noteContentScrollElement(refs.content())}];
    if(source)entries.push({element:source,requested:snapshot.sourceScroll,current:refs.source});
    if(snapshot.mode==='live'){
      const live=refs.liveScroll();if(!live||!snapshot.live)fail('live scroll container did not mount');
      entries.push({element:live!,requested:snapshot.live!.scroll,current:refs.liveScroll});
    }
    if(entries.some(({element})=>element.clientHeight<=0||element.clientWidth<=0)){
      if(Date.now()>=deadline)fail('visible note layout did not become measurable');
      stable=0;previous='';await frame();assertCurrent();continue;
    }
    const requested=entries.map(entry=>{
      const {element}=entry,maxTop=Math.max(0,element.scrollHeight-element.clientHeight),maxLeft=Math.max(0,element.scrollWidth-element.clientWidth);
      if(!Number.isFinite(maxTop)||!Number.isFinite(maxLeft))fail('invalid visible scroll geometry');
      const top=Math.min(entry.requested.top,maxTop),left=Math.min(entry.requested.left,maxLeft);
      element.scrollTop=top;element.scrollLeft=left;
      return {...entry,top,left,maxTop,maxLeft};
    });
    await frame();assertCurrent();
    let resized=false,unacknowledged=false;
    const signature=requested.map(({element,current,top,left,maxTop,maxLeft})=>{
      if(current()!==element)fail('scroll container changed during restore');
      const nextTop=Math.max(0,element.scrollHeight-element.clientHeight),nextLeft=Math.max(0,element.scrollWidth-element.clientWidth);
      if(nextTop!==maxTop||nextLeft!==maxLeft){resized=true;return '';}
      if(Math.abs(element.scrollTop-top)>1||Math.abs(element.scrollLeft-left)>1)unacknowledged=true;
      return [element.scrollTop,element.scrollLeft,nextTop,nextLeft].join(':');
    }).join('|');
    if(source&&(source.value!==snapshot.content||source.selectionStart!==snapshot.sourceSelection.start||source.selectionEnd!==snapshot.sourceSelection.end||source.selectionDirection!==snapshot.sourceSelection.direction))unacknowledged=true;
    unacknowledgedFrames=!resized&&unacknowledged?unacknowledgedFrames+1:0;
    if(unacknowledgedFrames>=3)fail('visible scroll restore was not acknowledged');
    stable=!resized&&!unacknowledged&&signature===previous?stable+1:0;previous=signature;
    if(Date.now()>=deadline)fail('visible note layout did not settle');
  }
}
const fields = {history:historyField,folds:foldState};
const fail = (message:string):never => {throw new Error(`Note presentation: ${message}`);};
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value) && (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function onlyKeys(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))fail('unknown snapshot field');}
const finite = (value:unknown,min=0,max=1e9):value is number => typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function jsonBound(value:unknown){
  let nodes=0;
  const walk=(item:unknown,depth:number)=>{
    if(++nodes>250000||depth>24)fail('snapshot is too complex');
    if(item===null||typeof item==='string'||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item)))return;
    if(Array.isArray(item)){for(const child of item)walk(child,depth+1);return;}
    if(!record(item))fail('snapshot must contain plain JSON');
    for(const [key,child] of Object.entries(item as Record<string,unknown>)){
      if(['__proto__','constructor','prototype'].includes(key))fail('invalid snapshot key');
      // CM serializers omit optional history properties when crossing JSON.
      if(child!==undefined)walk(child,depth+1);
    }
  };
  walk(value,0);
  const encoded=JSON.stringify(value);
  if(new TextEncoder().encode(encoded).byteLength>NOTE_PRESENTATION_MAX_BYTES)fail('snapshot exceeds the handoff limit; source retained');
  return encoded;
}
function scroll(value:unknown):value is NoteScroll {return record(value)&&finite(value.top)&&finite(value.left);}

export function capturePortableLiveEditor(state:EditorState,position:NoteScroll):PortableLiveEditorSnapshot {
  const query=getSearchQuery(state);
  if(query.test)fail('custom search filters cannot be transferred');
  const snapshot:PortableLiveEditorSnapshot={version:1,state:state.toJSON(fields),search:{search:query.search,replace:query.replace,caseSensitive:query.caseSensitive,literal:query.literal,regexp:query.regexp,wholeWord:query.wholeWord,panelOpen:searchPanelOpen(state)},scroll:position};
  return validatePortableLiveEditor(JSON.parse(jsonBound(snapshot)),state.doc.toString());
}
export function validatePortableLiveEditor(value:unknown,content:string):PortableLiveEditorSnapshot {
  jsonBound(value);
  if(!record(value)||value.version!==1||!record(value.state)||value.state.doc!==content||!record(value.search)||!scroll(value.scroll))fail('invalid editor snapshot');
  const snapshot=value as PortableLiveEditorSnapshot;
  onlyKeys(value as Record<string,unknown>,['version','state','search','scroll']);
  onlyKeys(snapshot.state as unknown as Record<string,unknown>,['doc','selection','history','folds']);
  onlyKeys(snapshot.search,['search','replace','caseSensitive','literal','regexp','wholeWord','panelOpen']);
  if(!record(snapshot.state.history)||!Array.isArray(snapshot.state.history.done)||!Array.isArray(snapshot.state.history.undone)||!Array.isArray(snapshot.state.folds)||snapshot.state.folds.length%2)fail('invalid editor fields');
  if(snapshot.state.folds.some((pos,index)=>!Number.isSafeInteger(pos)||pos<0||pos>content.length||(index%2===1&&pos<=snapshot.state.folds[index-1])))fail('invalid folded range');
  const query=snapshot.search;
  if(typeof query.search!=='string'||typeof query.replace!=='string'||query.search.length>65536||query.replace.length>65536||['caseSensitive','literal','regexp','wholeWord','panelOpen'].some(key=>typeof query[key as keyof typeof query]!=='boolean'))fail('invalid search');
  // Let the installed CM version validate its own documented JSON encoding.
  const restored=EditorState.fromJSON(snapshot.state,{extensions:[history(),codeFolding(),search()]},fields);
  if(restored.selection.ranges.some(range=>range.from<0||range.to>content.length))fail('invalid selection');
  if((snapshot.state.history as {done:unknown[];undone:unknown[]}).done.length>4096||(snapshot.state.history as {done:unknown[];undone:unknown[]}).undone.length>4096)fail('history exceeds the handoff limit');
  // Parsing alone cannot detect history whose ChangeSets belong to another
  // document length. Exercise both branches in isolated states before apply.
  for(const [change,selection] of [[undo,undoSelection],[redo,redoSelection]]){
    let checked=restored,steps=0;
    const target={get state(){return checked;},dispatch:(transaction:import('@codemirror/state').Transaction)=>{checked=transaction.state;}};
    while(selection(target)||change(target)){if(++steps>16384)fail('history exceeds the handoff limit');}
  }
  return snapshot;
}
export function restorePortableLiveEditor(snapshot:PortableLiveEditorSnapshot,content:string,extensions:Extension):EditorState {
  validatePortableLiveEditor(snapshot,content);
  const state=EditorState.fromJSON(snapshot.state,{extensions},fields);
  return state.update({effects:setSearchQuery.of(new SearchQuery(snapshot.search))}).state;
}
function notePresentationReferenceOccurrences(content:string):Array<NoteAttachmentReference&{from:number;to:number}>{
  const excluded:Array<{from:number;to:number}>=[];
  markdownLanguage.parser.parse(content).iterate({enter(node){if(['FencedCode','CodeBlock','InlineCode'].includes(node.name)){excluded.push({from:node.from,to:node.to});return false;}}});
  const firstBreak=content.indexOf('\n');
  if(firstBreak>=0&&content.slice(0,firstBreak).replace(/^\uFEFF/,'').trim()==='---'){
    let cursor=firstBreak+1;
    while(cursor<content.length){const breakAt=content.indexOf('\n',cursor),end=breakAt<0?content.length:breakAt;if(content.slice(cursor,end).trim()==='---'){excluded.push({from:0,to:end});break;}if(breakAt<0)break;cursor=breakAt+1;}
  }
  const prose=(from:number,to:number)=>!excluded.some(range=>Math.max(from,range.from)<Math.min(to,range.to));
  const refs=standardMarkdownReferences(content).filter(ref=>(ref.embedded||isStandaloneVideoReference(content,ref))&&prose(ref.from,ref.to)).map(ref=>({target:ref.target,wiki:false,from:ref.from,to:ref.to}));
  for(const match of content.matchAll(/!\[\[([^\]\n]+)\]\]/g)){const from=match.index!,to=from+match[0].length;if(prose(from,to))refs.push({target:match[1].split('|')[0].trim(),wiki:true,from,to});}
  return refs.sort((a,b)=>a.from-b.from);
}
export function inspectNotePresentationReferences(content:string):{references:NoteAttachmentReference[];unsupported:Array<NoteAttachmentReference&{reason:string}>}{
  const references:NoteAttachmentReference[]=[],unsupported:Array<NoteAttachmentReference&{reason:string}>=[];
  for(const {target,wiki} of notePresentationReferenceOccurrences(content)){
    let decoded=target;try{decoded=decodeURIComponent(target);}catch{unsupported.push({target,wiki,reason:'invalid reference encoding'});continue;}
    if(!decoded||decoded.length>4096||/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(decoded)||decoded.includes('\0'))unsupported.push({target,wiki,reason:/^https?:/i.test(decoded)?'external embedded media is not authorized in this window':'attachment is not a supported note-relative reference'});
    else references.push({target,wiki});
  }
  return {references:[...new Map(references.map(ref=>[JSON.stringify([ref.target,ref.wiki]),ref])).values()],unsupported};
}
export function assertNotePresentationReferencesSupported(content:string){
  const result=inspectNotePresentationReferences(content);
  if(result.unsupported.length)fail(`unsupported attachment reference: ${result.unsupported[0].target.slice(0,160)}`);
  return result.references;
}
export function notePresentationReferences(content:string):NoteAttachmentReference[]{
  return inspectNotePresentationReferences(content).references;
}
export function validateNoteViewPresentation(value:unknown,baseline:NoteViewBaseline):NoteViewPresentationSnapshot {
  const encoded=jsonBound(value);
  assertNotePresentationReferencesSupported(baseline.content);
  if(!record(value)||value.version!==1||!record(value.authority)||value.revision!==baseline.revision||value.content!==baseline.content||!baseline.revision||['vaultId','sourceId','documentId'].some(key=>typeof (value.authority as Record<string,unknown>)[key]!=='string'||(value.authority as Record<string,unknown>)[key]!==baseline.authority[key as keyof NoteAuthority]))fail('document authority, revision or content changed');
  const snapshot=value as NoteViewPresentationSnapshot;
  onlyKeys(value as Record<string,unknown>,['version','authority','revision','content','mode','live','sourceSelection','sourceScroll','contentScroll','media']);
  onlyKeys(snapshot.authority as unknown as Record<string,unknown>,['vaultId','sourceId','documentId']);
  if(!['live','source','preview'].includes(snapshot.mode)||!record(snapshot.sourceSelection)||!Number.isSafeInteger(snapshot.sourceSelection.start)||!Number.isSafeInteger(snapshot.sourceSelection.end)||snapshot.sourceSelection.start<0||snapshot.sourceSelection.end<snapshot.sourceSelection.start||snapshot.sourceSelection.end>baseline.content.length||!['forward','backward','none'].includes(snapshot.sourceSelection.direction)||!scroll(snapshot.sourceScroll)||!scroll(snapshot.contentScroll)||!Array.isArray(snapshot.media)||snapshot.media.length>256)fail('invalid view state');
  if(snapshot.live!==null)validatePortableLiveEditor(snapshot.live,baseline.content);
  if(snapshot.mode==='live'&&!snapshot.live)fail('live editor has not acknowledged capture');
  const permitted=new Set(notePresentationReferences(baseline.content).map(ref=>JSON.stringify(ref))),seen=new Set<string>();
  for(const media of snapshot.media){
    if(!record(media)||!record(media.reference)||typeof media.reference.target!=='string'||typeof media.reference.wiki!=='boolean'||!permitted.has(JSON.stringify({target:media.reference.target,wiki:media.reference.wiki}))||!Number.isSafeInteger(media.occurrence)||media.occurrence<0||media.occurrence>255||!['audio','video'].includes(media.kind)||!finite(media.currentTime,0,1e9)||!finite(media.volume,0,1)||!finite(media.playbackRate,.0625,16)||typeof media.paused!=='boolean'||typeof media.muted!=='boolean')fail('invalid playback state');
    onlyKeys(media as unknown as Record<string,unknown>,['reference','occurrence','kind','currentTime','volume','playbackRate','paused','muted']);
    onlyKeys(media.reference,['target','wiki']);
    const key=JSON.stringify([media.reference,media.occurrence,media.kind]);if(seen.has(key))fail('duplicate playback state');seen.add(key);
  }
  return JSON.parse(encoded) as NoteViewPresentationSnapshot;
}

type ResolvedMedia={element:HTMLMediaElement;reference:NoteAttachmentReference;occurrence:number;kind:'audio'|'video'};
function resolvedMedia(root:HTMLElement,media:NoteMedia,content:string):ResolvedMedia[]{
  const occurrences=notePresentationReferenceOccurrences(content),refs=[...new Map(occurrences.map(({target,wiki})=>[JSON.stringify([target,wiki]),{target,wiki}])).values()],counts=new Map<string,number>();
  const url=(source:string)=>{try{return new URL(source,root.ownerDocument.baseURI).href;}catch{return source;}};
  return [...root.querySelectorAll<HTMLMediaElement>('audio,video')].map(element=>{
    const source=element.currentSrc||element.getAttribute('src')||'';
    const assets=media.assets.filter(item=>[item.previewUrl,item.thumbnailUrl].some(candidate=>candidate&&url(candidate)===url(source)));
    const token=element.closest?.<HTMLElement>('[data-lr-token-from][data-lr-token-to]');
    const tokenFrom=token?Number(token.dataset.lrTokenFrom):null,tokenTo=token?Number(token.dataset.lrTokenTo):null;
    const authored=tokenFrom!==null&&tokenTo!==null&&Number.isSafeInteger(tokenFrom)&&Number.isSafeInteger(tokenTo)?content.slice(tokenFrom,tokenTo):null;
    const candidates=media.embeds.filter(embed=>assets.some(asset=>asset.id===embed.assetId)).flatMap(embed=>refs.filter(ref=>(ref.wiki?ref.target:`md:${ref.target}`)===embed.targetName))
      .filter(ref=>authored===null||notePresentationReferences(authored).some(item=>item.target===ref.target&&item.wiki===ref.wiki));
    const unique=[...new Map(candidates.map(ref=>[JSON.stringify(ref),ref])).values()];
    if(unique.length!==1)fail('rendered media has no unambiguous note-relative reference');
    const reference=unique[0],kind=element.tagName.toLowerCase() as 'audio'|'video',key=JSON.stringify([reference,kind]);
    // CM virtualizes earlier widgets. Its source range, rather than its DOM
    // ordinal, identifies repeated references across different window sizes.
    const occurrence=tokenFrom!==null?occurrences.filter(item=>item.from<tokenFrom&&item.target===reference.target&&item.wiki===reference.wiki).length:counts.get(key)||0;
    counts.set(key,occurrence+1);return {element,reference,occurrence,kind};
  });
}
export function captureNoteMedia(root:HTMLElement|null,media:NoteMedia,content:string):NoteMediaPlayback[]{
  assertNotePresentationReferencesSupported(content);
  if(!root)fail('view is not mounted');
  return resolvedMedia(root!,media,content).map(({element,reference,occurrence,kind})=>({reference,occurrence,kind,currentTime:element.currentTime,volume:element.volume,playbackRate:element.playbackRate,paused:element.paused,muted:element.muted}));
}
/** URL grants expire independently of attachment bytes. Preserve playback only
 * for the same authored reference and verified content version, using NEW URLs. */
export function prepareNoteMediaRefresh(root:HTMLElement|null,previous:NoteMedia,next:NoteMedia,content:string,pending?:NoteMediaRefreshPlan):NoteMediaRefreshPlan{
  const key=(reference:NoteAttachmentReference)=>JSON.stringify([reference.target,reference.wiki]);
  const before=new Map((previous.bindings||[]).map(binding=>[key(binding.reference),binding]));
  const after=new Map((next.bindings||[]).map(binding=>[key(binding.reference),binding]));
  const permitted=new Set(notePresentationReferences(content).map(key));
  const replacements=new Set<string>();
  for(const [reference,old] of before){
    const fresh=after.get(reference);
    if(!fresh||!old.version||old.version!==fresh.version||!permitted.has(reference))continue;
    const oldAsset=previous.assets.find(asset=>asset.id===old.assetId),newAsset=next.assets.find(asset=>asset.id===fresh.assetId);
    if(oldAsset?.previewUrl!==newAsset?.previewUrl||old.assetId!==fresh.assetId)replacements.add(reference);
  }
  const retained=(pending?.playback||[]).filter(item=>permitted.has(key(item.state.reference))&&after.get(key(item.state.reference))?.version===item.version);
  if(!replacements.size)return {playback:retained};
  const captured=captureNoteMedia(root,previous,content).filter(state=>replacements.has(key(state.reference))).map(state=>({state,version:after.get(key(state.reference))!.version}));
  const playback=new Map(captured.map(item=>[JSON.stringify([key(item.state.reference),item.state.occurrence,item.state.kind]),item]));
  for(const item of retained)playback.set(JSON.stringify([key(item.state.reference),item.state.occurrence,item.state.kind]),item);
  const result={playback:[...playback.values()]};
  if(root)for(const item of resolvedMedia(root,previous,content))if(result.playback.some(saved=>key(saved.state.reference)===key(item.reference)&&saved.state.occurrence===item.occurrence&&saved.state.kind===item.kind))item.element.pause();
  return result;
}
export function nextNotePresentationFrame():Promise<void>{return new Promise(resolve=>{
  let frame:number|undefined;
  const done=()=>{clearTimeout(timer);if(frame!==undefined)cancelAnimationFrame(frame);resolve();};
  const timer=setTimeout(done,100);
  if(typeof requestAnimationFrame==='function')frame=requestAnimationFrame(done);
});}
/** No old URL or opaque token is carried. Match only this target's fresh media. */
export async function restoreNoteMedia(root:()=>HTMLElement|null,media:()=>NoteMedia,content:string,snapshots:NoteMediaPlayback[],assertCurrent:()=>void):Promise<void>{
  const deadline=Date.now()+5000;
  for(const snapshot of snapshots){
    let target:HTMLMediaElement|undefined;
    while(!target){
      assertCurrent();const element=root();
      if(element)target=resolvedMedia(element,media(),content).find(item=>item.kind===snapshot.kind&&item.occurrence===snapshot.occurrence&&JSON.stringify(item.reference)===JSON.stringify(snapshot.reference))?.element;
      if(target&&target.readyState<1)target=undefined;
      if(!target){if(Date.now()>=deadline)fail(`media did not become ready: ${snapshot.reference.target}`);await nextNotePresentationFrame();}
    }
    target.pause();target.volume=snapshot.volume;target.muted=snapshot.muted;target.playbackRate=snapshot.playbackRate;
    if(Number.isFinite(target.duration)&&snapshot.currentTime>target.duration+.1)fail('media duration changed');
    target.currentTime=snapshot.currentTime;
    while(target.seeking||Math.abs(target.currentTime-snapshot.currentTime)>.15){assertCurrent();if(target.error||Date.now()>=deadline)fail(`media seek was not acknowledged: ${snapshot.reference.target}`);await nextNotePresentationFrame();}
    if(!snapshot.paused){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([target.play(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{target!.pause();reject(new Error('Note presentation: media playback acknowledgement timed out'));},Math.max(1,deadline-Date.now()));})]);}
      finally{if(timer!==undefined)clearTimeout(timer);}
    }
    assertCurrent();
    if(target.paused!==snapshot.paused||target.volume!==snapshot.volume||target.playbackRate!==snapshot.playbackRate||target.muted!==snapshot.muted)fail('media playback was not acknowledged');
  }
}
