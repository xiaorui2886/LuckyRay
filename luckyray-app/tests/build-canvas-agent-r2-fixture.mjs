import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);const {build,stop}=createRequire(require.resolve('vite'))('esbuild');
const out='output/canvas-agent-r2';await mkdir(out,{recursive:true});
await build({entryPoints:['tests/fixtures/canvas-agent-r2/entry.tsx'],bundle:true,jsx:'automatic',outdir:out,define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'synthetic-agent-io',setup(b){b.onLoad({filter:/\/core\/services\/canvasAgent\.ts$/},()=>({loader:'ts',contents:`
const catalog={available:[{provider:'LSH · DeepSeek',model:'deepseek-flash',label:'LSH · DeepSeek · deepseek-flash',inputModalities:['text']},{provider:'LSH · Gemini',model:'gemini-3.1-pro',label:'LSH · Gemini · gemini-3.1-pro',inputModalities:['text','image']}],defaultModel:{provider:'LSH · DeepSeek',model:'deepseek-flash'},currentModel:null};
export const prepareCanvasAgentHost=async()=>{};
export const canvasAgentErrorMessage=(error:any)=>String(error?.message||error);
export const canvasAgentClient={dispatch:async(request:any)=>({canvasId:request.canvasId,sessionId:null,runId:null,status:'idle',messages:[],models:catalog})};
`}));}}]});
await writeFile(out+'/index.html',`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LuckyRay Agent R2 · 合成交互验证</title><link rel="stylesheet" href="entry.css"><style>:root{--theme-surface-raised:#1c1c20;--theme-surface-panel:#161619;--theme-glass-bg:#1c1c20;--theme-canvas-workspace:#101013;--text-primary:#ececf0;--text-secondary:#9696a0;--theme-border-subtle:#ffffff12;--theme-border-strong:#ffffff24;--theme-hover:#ffffff0c;--accent:#aaa1f7;font-family:Arial,'Noto Sans CJK SC',sans-serif;color:var(--text-primary);background:#101013}body{margin:0}#root{height:100vh;width:100vw}button,input,textarea{font:inherit}</style></head><body><div id="root"></div><script src="entry.js"></script></body></html>`);

stop();
