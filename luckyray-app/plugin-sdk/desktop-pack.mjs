// A single self-contained ESM bundle; package bytes, CSS and assets share the existing signature.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const LIMIT=16*1024*1024;
const fail=message=>{throw Error(message);};
const safeName=name=>typeof name==='string'&&name.length>0&&name.length<=240&&!name.includes('\\')&&!name.startsWith('/')&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&!/[\x00-\x1f]/.test(name);
function ownedFile(root,name){if(!safeName(name))fail('Invalid package-relative resource path');const file=path.join(root,name);const parts=name.split('/');let p=root;for(const part of parts){p=path.join(p,part);if(fs.lstatSync(p).isSymbolicLink())fail('Package symlinks are not supported');}if(!fs.statSync(file).isFile())fail('Resource is not a file');return file;}
export function buildDesktopPackage(root){
 const c=JSON.parse(fs.readFileSync(ownedFile(root,'plugin.json'),'utf8'));
 const allowed=['runtime','id','name','version','minHostVersion','requiredModules','optionalModules','dataVersion','contributions','entry','style','assets'];
 if(Object.keys(c).some(k=>!allowed.includes(k))||c.runtime!=='desktop')fail('Invalid desktop manifest');
 const version=s=>typeof s==='string'&&/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(s);
 if(!/^[a-z][a-z0-9.-]{2,79}$/.test(c.id??'')||c.id.includes('..')||typeof c.name!=='string'||!c.name.trim()||Buffer.byteLength(c.name)>160||/[\p{Cc}]/u.test(c.name)||!version(c.version)||!version(c.minHostVersion??'1.9.8'))fail('Invalid desktop identity');
 if(!Array.isArray(c.requiredModules??[])||!Array.isArray(c.optionalModules??[]))fail('Invalid modules');
 const modules=[...(c.requiredModules??[]),...(c.optionalModules??[])];if(modules.length>16||modules.some(m=>typeof m!=='string'||!/^[a-z-]{1,40}$/.test(m)))fail('Invalid modules');
 const contributions=c.contributions??[];const ids=new Set();if(!Array.isArray(contributions)||contributions.length>128)fail('Invalid contributions');
 for(const x of contributions){if(!/^[a-zA-Z0-9._-]{1,80}$/.test(x.id??'')||ids.has(x.id)||typeof x.label!=='string'||!x.label.trim()||Buffer.byteLength(x.label)>160||/[\p{Cc}]/u.test(x.label)||!['page','panel','settings','command','menu'].includes(x.kind))fail('Invalid contribution');ids.add(x.id);}
 const code=fs.readFileSync(ownedFile(root,c.entry??'main.js'),'utf8');
 const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:code,encoding:'utf8',maxBuffer:1024*1024});if(checked.status!==0)fail(checked.stderr||'Invalid JavaScript module');
 const css=c.style?fs.readFileSync(ownedFile(root,c.style),'utf8'):'';const assets=Object.create(null);let size=Buffer.byteLength(code)+Buffer.byteLength(css);
 for(const [name,definition]of Object.entries(c.assets??{})){
  if(Object.keys(assets).length>=256||!safeName(name)||typeof definition!=='object'||typeof definition.mimeType!=='string'||definition.mimeType.length>120||/[\p{Cc}]/u.test(definition.mimeType))fail('Invalid asset');
  const file=ownedFile(root,definition.file);const data=fs.readFileSync(file);size+=data.length;if(size>LIMIT)fail('Desktop package too large');assets[name]={mimeType:definition.mimeType,base64:data.toString('base64')};
 }
 const pkg={manifest:{schemaVersion:2,apiVersion:2,type:'desktop',entry:'main.js',id:c.id,name:c.name,version:c.version,minHostVersion:c.minHostVersion??'1.9.8',requiredModules:c.requiredModules??[],optionalModules:c.optionalModules??[]},resource:{code,css,assets,dataVersion:c.dataVersion??1,contributions}};
 if(!Number.isInteger(pkg.resource.dataVersion)||pkg.resource.dataVersion<1||pkg.resource.dataVersion>4294967295)fail('Invalid dataVersion');
 const encoded=JSON.stringify(pkg)+'\n';if(Buffer.byteLength(encoded)>LIMIT)fail('Desktop package too large');return{pkg,encoded};
}
export function createDesktopProject(root){
 if(fs.existsSync(root))fail('Choose a new directory');fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify({runtime:'desktop',id:'example.workbench',name:'Community Workbench',version:'1.0.0',minHostVersion:'1.9.8',requiredModules:['workspace','commands','editor'],optionalModules:[],dataVersion:1,contributions:[{id:'board',label:'Workbench',kind:'page'}]},null,2)+'\n');
 fs.writeFileSync(path.join(root,'main.js'),`// Full trusted extension. Bundle optional libraries; use host CodeMirror/React modules.\nexport function activate(api) {\n  api.workspace.registerView({id:'board',title:'Workbench',mount(container) {\n    const title=document.createElement('h2'); title.textContent='Your own workspace';\n    const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=280;\n    const ctx=canvas.getContext('2d');ctx.fillStyle='#8b5cf6';ctx.fillRect(20,20,160,100);\n    const button=document.createElement('button');button.textContent='Change color';\n    button.onclick=()=>{ctx.fillStyle='#14b8a6';ctx.fillRect(20,20,160,100);};\n    container.append(title,canvas,button);return()=>container.replaceChildren();\n  }});\n  api.commands.register({id:'open-board',name:'Open community workbench',run:()=>api.workspace.openView('board')});\n}\n`);
 return root;
}
