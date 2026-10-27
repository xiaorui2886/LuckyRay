import { build } from 'esbuild';
import {resolve} from 'node:path';
if(!process.argv[2])throw Error('Pass output path');
await build({stdin:{contents:'export {CanvasGridSplit, CanvasImageToolbar} from "./src/features/canvas/CanvasGridSplit";',resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react-dom','react-dom/*','@xyflow/react'],loader:{'.css':'empty'},outfile:resolve(process.argv[2])});
