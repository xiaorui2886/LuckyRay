// The real card, with synthetic update status/restart only. Native mode retains
// the real plugin-dialog import; it never stages, upgrades or restarts LuckyRay.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function restartFixture({ nativeDialog = false, warm = false } = {}) {
  const result = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import Card from "./src/features/settings/DshEngineUpdateCard";
      globalThis.qa = { dialogCalls: [], confirmations: [], restartCalls: 0, windowConfirmCalls: 0, rejectRestart: false };
      window.confirm = () => { qa.windowConfirmCalls++; return Promise.resolve(false); };
      createRoot(document.getElementById("root")).render(<Card/>);
      setInterval(() => { document.getElementById("calls").textContent = "TEST ONLY restart calls: " + qa.restartCalls; }, 20);
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" },
    plugins: [{ name: "explicit-restart-fixture", setup(builder) {
      builder.onResolve({ filter: /\/dshEngineUpdate$/ }, () => ({ path: "status", namespace: "fixture" }));
      builder.onResolve({ filter: /\/i18n\/index$/ }, () => ({ path: "locale", namespace: "fixture" }));
      if (!nativeDialog) builder.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: "dialog", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents:
        path === "locale" ? `export const defineMessages=x=>x;export const useMessages=x=>({t:k=>x[k]["zh-CN"]});` :
        path === "dialog" ? `export function confirm(message,options){qa.dialogCalls.push({message,options});return new Promise((resolve,reject)=>qa.confirmations.push({resolve,reject}));}` :
        `const status={phase:"restart_required",currentVersion:"0.1.7-rc.2",candidateVersion:"0.2.1-rc.2",channel:"preview",sourceClass:"production",canCheck:true,canRestart:${!warm},canPrepareExit:${warm}};
         export const dshEngineUpdate={latest:()=>status,subscribe:()=>()=>{},status:async()=>status,restart:async()=>{qa.restartCalls++;if(qa.rejectRestart)throw Error("synthetic restart failure");}};`
      }));
    } }],
  });
  return result.outputFiles[0].text;
}
