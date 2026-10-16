import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const backgroundPath = fileURLToPath(new URL("../src/core/services/dshBackgroundPreload.ts", import.meta.url));
const hostPath = fileURLToPath(new URL("../src/core/services/dshHost.ts", import.meta.url));
const surfacePath = fileURLToPath(new URL("../src/core/services/dshNativeSurface.ts", import.meta.url));
const compatPath = fileURLToPath(new URL("../src/core/services/dshPluginCompat.ts", import.meta.url));
const modules = {
  react: `export default {StrictMode:"strict",createElement(type,props,...children){return {type,props,children}}};`,
  "react/jsx-runtime": `export const Fragment="strict";export function jsx(type,props){return {type,props,children:[props?.children].flat()}};export const jsxs=jsx;`,
  "react-dom/client": `function render(node){if(!node)return;if(node.type==="strict")node.children.forEach(render);else if(typeof node.type==="function")render(node.type(node.props));else __fixture.events.push("error-render")} export default {createRoot(){return {render}}};`,
  "@tauri-apps/api/window": `export const getCurrentWindow=()=>({label:__fixture.label});`,
  "@tauri-apps/api/core": `export const invoke=(command,args)=>__fixture.invoke(command,args);`,
  useSettings: `export const readSavedSettings=()=>({});export const applyGlobalSettings=()=>{};`,
  windowSurfaceBackground: `export const syncWindowSurfaceBackground=async()=>{};`,
  windowLifecycle: `export const installWorkspaceLifecycle=async()=>{__fixture.events.push("lifecycle")};`,
  WorkspaceWindow: `export default function WorkspaceWindow(){__fixture.events.push("workspace-render");return null;}`,
  AppShell: `import {createDefaultDshPluginCompatClient} from ${JSON.stringify(compatPath)};
    import {prepareDshNativeSurfaceForAttach} from ${JSON.stringify(backgroundPath)};
    import {createDefaultDshHostClient} from ${JSON.stringify(hostPath)};
    import {createDefaultDshNativeSurfaceClient} from ${JSON.stringify(surfacePath)};
    export default function AppShell(){__fixture.events.push("main-render");
      __fixture.entry=async()=>{const [host,surface]=await Promise.all([createDefaultDshHostClient(),createDefaultDshNativeSurfaceClient()]);
        await prepareDshNativeSurfaceForAttach(host,surface);return surface;};
      if(__fixture.native){__fixture.settings=createDefaultDshPluginCompatClient().then(client=>client.status());
      __fixture.settings.catch(()=>{});}return null;}`,
  luckyrayBridge: `export const installLuckyRayBridge=async()=>{};`,
  CanvasSpike: `export default function CanvasSpike(){return null;}`,
};
const bundled = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
  bundle: true, format: "iife", write: false, jsx: "transform",
  plugins: [{ name: "native-transport-seam", setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if ([compatPath, backgroundPath, hostPath, surfacePath].includes(args.path)) return { path: args.path, namespace: "file" };
      const key = Object.keys(modules).find(key => args.path === key || args.path.endsWith(`/${key}`));
      if (key) return { path: key, namespace: "seam" };
      if (args.path.endsWith(".css")) return { path: "css", namespace: "seam" };
    });
    build.onLoad({ filter: /.*/, namespace: "seam" }, args => ({ contents: modules[args.path] ?? "", loader: "js" }));
  } }],
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function boot(label, native = true, enabled = true) {
  let releaseProbe;
  const probe = new Promise(resolve => { releaseProbe = resolve; });
  let releaseSurface;
  const surfaceReady = new Promise(resolve => { releaseSurface = resolve; });
  const events = [], calls = [];
  let stage = "bundled-verified";
  const fixture = { label, native, events, calls, settings: null, entry: null,
    surfaceStage: "closed", children: 0, visible: false,
    async invoke(command) {
      calls.push(command);
      if (command === "dsh_host_status") return {
        stage, canProbe: true, canRetry: false, hostReusable: stage === "probe-completed", latestProbePassed: stage === "probe-completed",
      };
      if (command === "dsh_host_probe") {
        stage = "starting";
        await probe;
        stage = "probe-completed";
        return { stage, canProbe: true, canRetry: false, hostReusable: true, latestProbePassed: true };
      }
      if (command === "dsh_native_surface_preload") {
        assert.equal(stage, "probe-completed");
        if (!enabled) return null;
        fixture.children += 1; fixture.surfaceStage = "webview-created";
        await surfaceReady;
        fixture.surfaceStage = "client-ready";
        return { stage: "client-ready", ready: true };
      }
      if (command === "dsh_native_surface_status") return { stage: fixture.surfaceStage, ready: fixture.surfaceStage === "client-ready" };
      if (command === "dsh_native_surface_show") { fixture.visible = true; return; }
      if (command === "dsh_plugin_compat_status") {
        assert.equal(stage, "probe-completed", "Settings must not create a recovery-only host on cold boot");
        return { manifestValid: true, plugins: [] };
      }
      throw Error(`unexpected command ${command}`);
    },
  };
  const document = {
    getElementById: () => ({}),
    createElement: () => ({}),
    documentElement: { dataset: {} }, head: { appendChild() {} }, body: { style: {} },
  };
  const window = { location: { hash: "#settings" }, ...(native ? { __TAURI_INTERNALS__: {} } : {}) };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    __fixture: fixture, window, document, performance,
    console: { info() {}, error() {} },
  });
  return { fixture, releaseProbe, releaseSurface };
}

test("real main.tsx boot renders Settings while preload is pending and releases compat afterward", async () => {
  const { fixture, releaseProbe, releaseSurface } = boot("main");
  await tick();
  assert.deepEqual(fixture.events, ["lifecycle", "main-render"]);
  assert.deepEqual(fixture.calls, ["dsh_host_status", "dsh_host_probe"]);
  assert.ok(fixture.settings instanceof Promise || typeof fixture.settings?.then === "function");
  releaseProbe();
  await fixture.settings;
  await tick();
  assert.deepEqual(fixture.calls, ["dsh_host_status", "dsh_host_probe", "dsh_plugin_compat_status", "dsh_native_surface_preload"]);
  assert.equal(fixture.surfaceStage, "webview-created");
  assert.equal(fixture.visible, false);
  releaseSurface(); await tick();
  assert.equal(fixture.surfaceStage, "client-ready");
  assert.equal(fixture.visible, false, "boot fully prepares the actual surface without exposing it");
  assert.equal(fixture.children, 1);
});

test("real boot routes workspace children before importing main services", async () => {
  const { fixture } = boot("workspace-123");
  await tick();
  assert.deepEqual(fixture.events, ["lifecycle", "workspace-render"]);
  assert.deepEqual(fixture.calls, []);
});

test("unknown native identity fails closed before lifecycle or preload", async () => {
  const { fixture } = boot("unrecognized");
  await tick();
  assert.deepEqual(fixture.events, ["error-render"]);
  assert.deepEqual(fixture.calls, []);
});


test("real boot immediate AI entry joins full pending preparation; later entry reuses one child", async () => {
  const { fixture, releaseProbe, releaseSurface } = boot("main");
  await tick();
  let settled = false;
  const entry = fixture.entry().then(client => { settled = true; return client; });
  releaseProbe(); await tick();
  assert.equal(settled, false);
  assert.equal(fixture.surfaceStage, "webview-created");
  assert.equal(fixture.visible, false);
  releaseSurface();
  const client = await entry;
  assert.equal(fixture.calls.filter(x => x === "dsh_host_probe").length, 1);
  await client.show({ x: 230, y: 60, width: 900, height: 650 });
  await fixture.entry();
  assert.equal(fixture.children, 1);
  assert.equal(fixture.calls.filter(x => x === "dsh_native_surface_preload").length, 1);
  assert.equal(fixture.calls.includes("dsh_native_surface_open"), false);
  assert.equal(fixture.calls.some(x => x.includes("open_intent")), false);
});

test("real boot default-null skips child creation and preserves the host preparation", async () => {
  const { fixture, releaseProbe } = boot("main", true, false);
  await tick(); releaseProbe(); await tick();
  await fixture.entry();
  assert.equal(fixture.children, 0);
  assert.equal(fixture.calls.filter(x => x === "dsh_host_probe").length, 1);
  assert.equal(fixture.calls.filter(x => x === "dsh_native_surface_preload").length, 1);
});

test("real browser boot renders Main without any native preload", async () => {
  const { fixture } = boot("main", false);
  await tick();
  assert.deepEqual(fixture.events, ["main-render"]);
  assert.deepEqual(fixture.calls, []);
});

test("a native surface child cannot own Main startup", async () => {
  const { fixture } = boot("dsh-native-surface-m1");
  await tick();
  assert.deepEqual(fixture.events, ["error-render"]);
  assert.deepEqual(fixture.calls, []);
});
