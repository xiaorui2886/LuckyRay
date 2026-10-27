import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';
const source=resolve('src/CanvasSpike.tsx');
await build({stdin:{contents:(await readFile(source,'utf8'))+'\nexport {MaterialCompactComposer,createGenerationRequestSnapshot,I18nProvider,ReactFlowProvider};',loader:'tsx',resolveDir:dirname(source)},bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react-dom','react-dom/*','@xyflow/react'],outfile:resolve(process.argv[2])});
