// Export production components for synthetic DOM tests; never patch the app.
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';
const source=resolve('src/CanvasSpike.tsx'),outfile=process.argv[2];
if(!outfile)throw Error('Pass an output.cjs path');
await build({stdin:{contents:await readFile(source,'utf8')+'\nexport {MaterialCompactComposer, MaterialGenerationInspector, I18nProvider, ReactFlowProvider};\n',loader:'tsx',resolveDir:dirname(source),sourcefile:source},bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react-dom','react-dom/*','@xyflow/react'],outfile:resolve(outfile)});
