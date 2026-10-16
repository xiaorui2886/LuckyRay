// Engineering regression only: fresh disposable Edge profile + temporary Rust
// host. Never attach to an existing browser or contact a Main endpoint.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverBrowser, launchChromium } from "../browser-extension-runtime/lib/browser-launcher.mjs";
import { CdpConnection, attachSession, evaluate, getTargets } from "../browser-extension-runtime/lib/cdp-client.mjs";

let launched, connection, extensionDir;
try {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  const input = JSON.parse(raw);
  assert.equal(input.scenario, "chromium");
  assert(Number.isInteger(input.port) && input.port > 0 && input.port <= 65535);
  const manifest = JSON.parse(await fs.readFile(new URL("../../browser-extension-prototype/manifest.json", import.meta.url), "utf8"));
  extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "luckyray-capture-network-"));
  // This narrow test worker imports the production adapter unchanged. Its
  // network is confined before adapter initialization; no nativeMessaging or
  // production background startup can discover/contact an ordinary host.
  await fs.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "LuckyRay isolated capture transport", version: "0.0.1",
    key: manifest.key, permissions: ["webRequest"], host_permissions: ["http://127.0.0.1/*"],
    background: { service_worker: "worker.js" },
  }));
  await fs.copyFile(new URL("../../browser-extension-prototype/local-transport-auth.js", import.meta.url), path.join(extensionDir, "local-transport-auth.js"));
  await fs.writeFile(path.join(extensionDir, "worker.js"), `
    globalThis.process = { versions: { node: "isolated-test" } };
    globalThis.__LUCKYRAY_TEST_PORTS__ = [${input.port}];
    globalThis.testCalls = []; globalThis.testErrors = [];
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (url, init) => {
      const parsed = new URL(url);
      if (parsed.origin !== "http://127.0.0.1:${input.port}") throw new Error("fixture endpoint only");
      testCalls.push({path: parsed.pathname, method: init?.method || "GET"});
      return nativeFetch(url, init);
    };
    chrome.webRequest.onErrorOccurred.addListener(d => testErrors.push({error: d.error, method: d.method, path: new URL(d.url).pathname}), {urls:["http://127.0.0.1/*"]});
    importScripts("local-transport-auth.js");
  `);
  launched = await launchChromium({browser: discoverBrowser(), extensionPath: extensionDir, headless: true});
  connection = await CdpConnection.connect(launched.wsUrl.replace(/^http:/, "ws:"));
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await getTargets(connection)).find(t => t.type === "service_worker" && t.url.endsWith("/worker.js"));
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(target, "isolated worker started");
  const session = await attachSession(connection, target.targetId);
  const result = await evaluate(connection, session, `(async input => {
    const began = performance.now();
    try {
      const response = await LuckyRayLocalTransport.fetch(null, "/api/material-libraries/import-bytes", {
        method: "POST", headers: {"Content-Type":"application/json","X-LuckyRay-Source":"luckyray-plugin"}, body: JSON.stringify({
          libraryId:input.libraryId, requestId:"popup:isolated-chromium-large",
          name:"Synthetic Chromium PNG.png", mimeType:"image/png", bytesBase64:input.pngBase64,
        })
      }, 25000);
      const payload = await response.json();
      const receipt = payload?.ok === true ? payload.data : payload;
      return {stage:response.ok && receipt?.consumerVersion === 1 && receipt?.assetId
        && receipt?.requestId === "popup:isolated-chromium-large" && receipt?.libraryId === input.libraryId ? "saved" : "failed", status:response.status,
        code:payload.error?.code || payload.code || null, milliseconds:Math.round(performance.now()-began)};
    } catch(e) {
      return {stage:"failed", code:e.code || e.name, failure:e.transportFailure,
        network:e.transportNetwork || null, milliseconds:Math.round(performance.now()-began)};
    }
  })(${JSON.stringify(input)})`);
  const events = await evaluate(connection, session, "({calls:testCalls,errors:testErrors})");
  process.stdout.write(JSON.stringify({outcome:"ISOLATED_CHROMIUM_REAL_NATIVE_CAPTURE", ...result, ...events,
    businessWrites:events.calls.filter(c=>c.path.endsWith("/import-bytes")).length,
    pendingCount:result.stage === "saved" ? 0 : 1, pngBytes:Buffer.from(input.pngBase64,"base64").length}));
} catch (e) {
  process.stdout.write(JSON.stringify({outcome:"ISOLATED_CHROMIUM_REAL_NATIVE_CAPTURE", failed:true, code:e.name, message:e.message}));
  process.exitCode = 1;
} finally {
  if (connection) {
    await connection.send("Browser.close").catch(()=>{});
    await connection.close();
  }
  if (launched && launched.child.exitCode === null) {
    await Promise.race([new Promise(resolve=>launched.child.once("exit",resolve)), new Promise(resolve=>setTimeout(resolve,5000))]);
  }
  // Only remove our exact freshly-created test directories after graceful exit.
  // No force termination and no user profile cleanup on a shutdown failure.
  if (!launched || launched.child.exitCode !== null) {
    for (const dir of [launched?.profileDir, extensionDir].filter(Boolean)) {
      const relative = path.relative(os.tmpdir(), dir);
      assert(!relative.startsWith("..") && !path.isAbsolute(relative) && /^luckyray-(browser-ext|capture-network)-/.test(relative));
      await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:300}).catch(()=>{});
    }
  }
}
