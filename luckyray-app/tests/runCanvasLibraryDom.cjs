// Bundle the actual exported components without booting unrelated Tauri services.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {createRequire}=require('node:module');const requireApp=createRequire(path.resolve('package.json'));
const esbuild=createRequire(requireApp.resolve('vite'))('esbuild');
for(const name of ['canvasNodeName','canvasLibraryPicker']){
 let fixture=fs.readFileSync(`tests/${name}.fixture.tsx`,'utf8');
 const outfile=path.join(os.tmpdir(),`${name}-actual.cjs`);esbuild.buildSync({stdin:{contents:fixture,resolveDir:path.resolve('tests'),sourcefile:`${name}.fixture.tsx`,loader:'tsx'},bundle:true,platform:'node',outfile,loader:{'.css':'empty'}});
 cp.execFileSync(process.execPath,[`tests/${name}.dom.cjs`,outfile],{stdio:'inherit',env:process.env});
}
