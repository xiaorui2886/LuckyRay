import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const npm=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const npmRun=(args,cwd)=>execFileSync(process.execPath,[npm,...args],{cwd,encoding:'utf8',timeout:60000,windowsHide:true});
test('clean prefix installs private tarball, actual stdio process reports missing exact target, EOF exits, uninstall removes package',async()=>{
 const base=resolve(root,'../../output/materials-mcp-install');
 const {mkdirSync}=await import('node:fs');mkdirSync(base,{recursive:true});
 const run=mkdtempSync(join(base,'run-'));const packed=JSON.parse(npmRun(['pack','--ignore-scripts','--json','--pack-destination',run],root))[0];
 const tarball=join(run,packed.filename);assert.ok(packed.files.every(f=>/^(src\/|examples\/|README.md$|NOTICE.md$|package.json$)/.test(f.path)));
 npmRun(['install','--prefix',run,'--ignore-scripts','--no-audit','--no-fund','--package-lock=false',tarball],root);
 const config=join(run,'connection.json');writeFileSync(config,JSON.stringify({version:1,desktopExe:join(run,'deliberately-absent','luckyray-app.exe'),profileRoot:join(run,'unused-profile'),authKind:'materials-mcp-scoped-v1',baseUrl:'http://127.0.0.1:37418',clientId:'synthetic-client',clientName:'Install fixture',libraryId:'synthetic-library',expiresAt:4102444800,scope:['materials.search','materials.inspect','folders.read','materials.import'],credentialFile:join(run,'absent.dpapi')}));
 const entry=join(run,'node_modules/@luckyray/materials-mcp/src/server.mjs');assert.ok(existsSync(entry));
 const child=spawn(process.execPath,[entry,'--config',config],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const exited=new Promise((accept,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('stdio did not stop after EOF'));},25000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);accept(code);});});
 child.stdin.end([
 {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'isolated-install-test',version:'1'}}},
 {jsonrpc:'2.0',method:'notifications/initialized'},
 {jsonrpc:'2.0',id:2,method:'tools/list'},
 {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'connection_status',arguments:{}}},
 ].map(JSON.stringify).join('\n')+'\n');
 assert.equal(await exited,0);assert.equal(stderr,'');const results=stdout.trim().split('\n').map(JSON.parse);assert.equal(results[1].result.tools.length,5);assert.equal(results[2].result.content[0].text,'target-not-running');
 assert.equal(existsSync(join(run,'unused-profile')),false);npmRun(['uninstall','--prefix',run,'@luckyray/materials-mcp','--ignore-scripts','--no-audit','--no-fund','--package-lock=false'],root);assert.equal(existsSync(entry),false);
 const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(readFileSync(tarball)).digest('hex');
 writeFileSync(join(run,'evidence.json'),JSON.stringify({syntheticConfig:true,package:packed.filename,sha256:hash,files:packed.files.map(f=>f.path),installed:true,actualStdio:true,missingTargetError:true,profileCreated:false,exitCode:0,uninstalled:true,realDesktopImports:'NOT_RUN'},null,2));
 console.log('Private tarball installation evidence: '+join(run,'evidence.json'));
});
