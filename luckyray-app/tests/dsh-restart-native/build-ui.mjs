import { cp, mkdir, writeFile } from "node:fs/promises";
import { restartFixture } from "../helpers/dshRestartFixture.mjs";
const web = new URL("./web/", import.meta.url);
await mkdir(new URL("./icons/", import.meta.url), { recursive: true });
await cp(new URL("../../src-tauri/icons/icon.ico", import.meta.url), new URL("./icons/icon.ico", import.meta.url));
await mkdir(web, { recursive: true });
await writeFile(new URL("fixture.js", web), await restartFixture({ nativeDialog: true }));
await writeFile(new URL("index.html", web), `<!doctype html><meta charset="utf-8"><title>TEST ONLY</title>
<style>body{font:15px system-ui;background:#121215;color:#eee;padding:25px}button{font:inherit;padding:10px;margin:5px;background:#30303a;color:#fff;border:1px solid #555;border-radius:7px}button:disabled{opacity:.45}#calls{margin-top:25px;color:#bdbdff}</style>
<h2>TEST ONLY — native restart confirmation</h2><p>Real React card + Tauri dialog. Synthetic status and restart counter only. No real restart, upgrade, user profile or model request.</p>
<div id="root"></div><div id="calls"></div><script src="fixture.js"></script>`);
