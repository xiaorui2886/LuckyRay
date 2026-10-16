let listener:(event:any)=>void=()=>{};
let current:any={revision:0,phase:'idle',version:null,downloadedBytes:0,totalBytes:null,errorCode:null,canCheck:true,canDownload:false,canCancel:false,canInstall:false};
let releaseDownload:(v:unknown)=>void=()=>{};
const calls:string[]=[];
(window as any).qa={calls,set(phase:string,extra:any={}){current={...current,revision:current.revision+1,phase,canCheck:['idle','available','current','error','cancelled'].includes(phase),canDownload:phase==='available',canCancel:['checking','downloading','verifying','ready','scheduled'].includes(phase),canInstall:phase==='ready',...extra};listener({payload:current});return current;},get:()=>current};
export async function listen(_name:string,cb:any){listener=cb;return()=>{listener=()=>{};};}
export async function invoke(_name:string,{action}:any){calls.push(action);const qa=(window as any).qa;if(action==='status')return current;if(action==='check')return qa.set('available',{version:'1.9.7'});if(action==='download'){qa.set('downloading',{downloadedBytes:5242880,totalBytes:10485760});return new Promise(resolve=>{releaseDownload=resolve;});}if(action==='cancel'){const result=qa.set('cancelled');releaseDownload(result);return result;}if(action==='install')return qa.set('scheduled');if(action==='restart')return qa.set('preparing');throw Error('unexpected');}
