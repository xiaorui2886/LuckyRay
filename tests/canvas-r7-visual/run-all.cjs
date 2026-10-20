const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=__dirname; const out=path.join(root,'output'); fs.mkdirSync(out,{recursive:true});
const results=[];
for(const [name,script] of [['agent','canvasAgentR7Ui.browser.cjs'],['creative','canvasCreativeR7Ui.browser.cjs'],['crop','canvasImageCropR7Ui.browser.cjs']]){
 const r=spawnSync(process.execPath,[path.join(root,'tests',script)],{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024,env:{...process.env,CI:'true'}});
 fs.writeFileSync(path.join(out,`${name}.log`),(r.stdout||'')+'\n'+(r.stderr||'')+(r.error?'\n'+String(r.error):''));
 const result={name,status:r.status,signal:r.signal,error:r.error?.message||null}; results.push(result); console.log(JSON.stringify(result));
}
fs.writeFileSync(path.join(out,'run-summary.json'),JSON.stringify({scope:'real production UI with synthetic inputs; not native or provider acceptance',results},null,2)+'\n');
if(results.some(x=>x.status!==0||x.error))process.exitCode=1;
