const fs=require('node:fs'),path=require('node:path');
const esbuild=require(process.env.LR_ESBUILD_MODULE||'esbuild');
const out=path.resolve(process.argv[2]||'output/canvas-ux');fs.mkdirSync(out,{recursive:true});
const common={bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react-dom','@xyflow/react'],loader:{'.css':'empty'},logLevel:'warning'};
(async()=>{
 for(const [entry,name] of [['src/features/canvas/CanvasCreativeRail.tsx','rail'],['src/features/canvas/CanvasGridSplit.tsx','grid']])await esbuild.build({...common,entryPoints:[entry],outfile:path.join(out,name+'.cjs')});
 await esbuild.build({...common,entryPoints:['src/CanvasSpike.tsx'],outfile:path.join(out,'composer.cjs'),plugins:[{name:'qa-private-components',setup(b){b.onLoad({filter:/[\\/]CanvasSpike\.tsx$/},a=>({contents:fs.readFileSync(a.path,'utf8')+'\nexport {MaterialCompactComposer,I18nProvider};',loader:'tsx',resolveDir:path.dirname(a.path)}));}}]});
})().catch(e=>{console.error(e);process.exitCode=1;});
