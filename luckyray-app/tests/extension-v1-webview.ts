import { invoke } from "@tauri-apps/api/core";
import { runPlugin } from "../src/core/extensions/runtime";
const check=(v:unknown,m:string)=>{if(!v)throw Error(m)};
const manage=(request:object)=>invoke<any>("manage_extension_packages",{request:JSON.stringify(request)});
async function test(){
 const code=`LuckyRay.register(async e=>{const d=await LuckyRay.call('data.get');await LuckyRay.call('data.set',{schemaVersion:1,revision:d.revision+1,settings:{count:(d.settings.count||0)+1},cache:{}});return {title:'Native IPC',text:JSON.stringify([typeof document,typeof __TAURI_INTERNALS__,e.theme.accent]),actions:[{id:'again',label:'Again'}]};});`;
 const pkg={manifest:{schemaVersion:1,apiVersion:1,id:'fixture.webview',name:'WebView fixture',version:'1.0.0',type:'script',entry:'main.js',minHostVersion:'1.9.2',requiredModules:[],optionalModules:[]},resource:{code,requiredPermissions:[],optionalPermissions:[],dataVersion:1,contributions:[{id:'run',label:'Run',kind:'panel'}]}};
 let state=await manage({op:'list'});state=await manage({op:'install',package:pkg,expectedRevision:state.revision});state=await manage({op:'enable',id:pkg.manifest.id,expectedRevision:state.revision});
 const scope={materialIds:[],canvasIds:[],knowledge:null,writes:false,theme:{accent:'#123456'}};
 const result=await runPlugin(pkg.manifest.id,scope,{contribution:'run'},new AbortController().signal,()=>{});
 check(result.ui.text===JSON.stringify(['undefined','undefined','#123456']),'isolation/theme');check(result.receipts.length===1,'native write receipt');
 const second=await runPlugin(pkg.manifest.id,{...scope,theme:{accent:'#abcdef'}},{contribution:'run',action:'again'},new AbortController().signal,()=>{});
 check(second.ui.text?.includes('#abcdef'),'theme update');
 state=await manage({op:'list'});check(state.packages[0].data.settings.count===2,'own data persistence');
 state=await manage({op:'disable',id:pkg.manifest.id,expectedRevision:state.revision});
 let denied=false;try{await runPlugin(pkg.manifest.id,scope,{contribution:'run'},new AbortController().signal,()=>{})}catch{denied=true}check(denied,'disabled start denied');
 await invoke('extension_fixture_done',{report:{ok:true,passed:['real WebView2 invoke → production package/runtime commands → same application worker','production frontend runPlugin transport and UI validation','no DOM/global bridge in plugin','own data persists across invocations','theme tokens change','disable rejects new invocation'],userAgent:navigator.userAgent}});
}
test().catch(error=>invoke('extension_fixture_done',{report:{ok:false,error:String(error),stack:error?.stack}}));
