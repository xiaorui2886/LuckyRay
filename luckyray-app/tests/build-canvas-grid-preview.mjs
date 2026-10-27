import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(process.argv[2]||'.qa/canvas-grid-preview');await mkdir(out,{recursive:true});
await build({entryPoints:['tests/fixtures/canvas-grid-preview.tsx'],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:resolve(out,'preview.js')});
await writeFile(resolve(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="preview.css"><style>body{margin:0;padding:24px;background:#151619;color:#e5e5e5;font:14px system-ui}</style><div id="root"></div><script type="module" src="preview.js"></script></html>');
console.log(`Serve ${out} with a local HTTP server. Visual fixture only; native persistence is not simulated.`);
