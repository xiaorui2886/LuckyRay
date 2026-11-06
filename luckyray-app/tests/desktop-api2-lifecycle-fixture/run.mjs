// Drives only the existing fresh-profile Tauri fixture through its IPC test page.
// It does not attach to or control any ordinary application window or profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '../..');
const arg = name => { const i=process.argv.indexOf(name); if(i<0 || !process.argv[i+1]) throw Error(`missing ${name}`); return path.resolve(process.argv[i+1]); };
const exe = arg('--exe');
const output = arg('--out');
if (!fs.existsSync(exe)) throw Error('fixture executable missing');
fs.mkdirSync(output); // Fail if anything already exists; never replace test or user data.
const assets=path.join(output,'assets');fs.mkdirSync(assets);
const helper=path.join(output,'synthetic-lifecycle-child.exe');
const compile=spawnSync(process.env.RUSTC || 'rustc',['--edition=2021',path.join(here,'child.rs'),'-o',helper],{windowsHide:true,encoding:'utf8'});
if(compile.status!==0) throw Error(`synthetic helper compilation failed: ${compile.stderr}`);
const require=createRequire(import.meta.url);
const esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
await esbuild.build({entryPoints:[path.join(here,'entry.ts')],bundle:true,platform:'browser',format:'iife',target:'es2022',outfile:path.join(assets,'app.js'),logLevel:'warning'});
fs.writeFileSync(path.join(assets,'config.js'),`window.__lifecycleFixture=${JSON.stringify({executable:helper,cwd:output})};\n`,{flag:'wx'});
fs.writeFileSync(path.join(assets,'index.html'),'<!doctype html><html><body><script src="/config.js"></script><script src="/app.js"></script></body></html>',{flag:'wx'});

const envKeys=['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','COMSPEC'];
const env=Object.fromEntries(envKeys.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
env.LUCKYRAY_APP_PROFILE='';env.LUCKYRAY_FIXTURE_TIMEOUT_SECS='120';env.LUCKYRAY_EXTENSION_FIXTURE_HIDDEN='1';
const fixture=spawn(exe,['--extension-community-fixture',assets],{cwd:app,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='';fixture.stdout.on('data',b=>{stdout+=b;});fixture.stderr.on('data',b=>{stderr+=b;});
const watchers=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, label, ms=20000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {
    const result=check();if(result) return result;
    if(fixture.exitCode!==null) throw Error(`fixture exited before ${label}; code=${fixture.exitCode}; stderr=${stderr}`);
    await sleep(50);
  }
  throw Error(`timed out waiting for ${label}; stderr=${stderr}`);
}
async function exited(child, label, ms=20000) {
  const end=Date.now()+ms;
  while(child.exitCode===null && Date.now()<end) await sleep(50);
  if(child.exitCode===null) throw Error(`timed out waiting for ${label}`);
  if(child.exitCode!==0) throw Error(`${label} failed: ${child.exitCode}`);
}
try {
  const ready=await until(()=>stdout.split(/\r?\n/).flatMap(line=>{try {const x=JSON.parse(line);return x.event==='community-fixture-ready'?[x]:[];}catch{return [];}})[0],'fixture startup');
  const profile=fs.realpathSync(ready.root);
  if(!/^com\.luckyray\.extensionfixture\.p[0-9a-f]{32}$/i.test(path.basename(profile)) || ready.pid && ready.pid!==fixture.pid)
    throw Error('fixture root identity refused');
  const report=name=>path.join(profile,'reports',`${name}.json`);
  const readReport=name=>{try{return JSON.parse(fs.readFileSync(report(name),'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
  const phases=[];
  for(const name of ['disable','update','exit']) {
    const start=await until(()=>readReport(`${name}-started`),`${name} start`);
    if(!Number.isInteger(start.pid)||start.pid<=0||start.running!==true) throw Error(`invalid synthetic ${name} child`);
    const watcher=spawn(helper,['watch',String(start.pid),path.join(output,`${name}-started.ack`)],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    watchers.push(watcher);let watchError='';watcher.stderr.on('data',b=>{watchError+=b;});
    await until(()=>{if(watcher.exitCode!==null) throw Error(`cannot watch ${name} child: ${watchError}`);return fs.existsSync(path.join(output,`${name}-started.ack`));},`${name} watcher`);
    if(name==='exit') {
      await until(()=>fs.existsSync(report('exit-requested')),'fixture exit request');
      await exited(watcher,'exit child');await exited(fixture,'fixture application');
    } else {
      const done=await until(()=>readReport(`${name}-done`),`${name} completion`);
      if(done.enabled!==false || (name==='update' && (done.grants!==0 || done.dataPreserved!==true))) throw Error(`unexpected ${name} state`);
      await exited(watcher,`${name} child`);
      fs.writeFileSync(path.join(output,`${name}-done.ack`),'verified',{flag:'wx'});
    }
    phases.push({name, childWasRunning:true, childHandleSignaled:true});
  }
  const result={ok:true,fixture:'fresh-profile Tauri IPC fixture',phases,applicationExitCode:fixture.exitCode};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify(result));
} catch(error) {
  console.error(String(error));
  if(fixture.exitCode===null) fixture.kill(); // Only the exact fixture process we started.
  for(const watcher of watchers) if(watcher.exitCode===null) watcher.kill();
  process.exitCode=1;
}
