// Visual capture for the EXT-Z2 functional-plugin surface. Renders the real
// panels + invocation dialog in headless Edge with stubbed transports and writes
// PNGs for light + dark, wide + narrow reading checks. This is browser-render
// evidence only: no native plugin worker is involved.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "playwright",
);
const outDir = process.env.LUCKYRAY_EXT_Z2_SHOTS || "./test-results/ext-z2-plugin";

const script = (id, name, required, optional, grants, enabled, minHostVersion = "1.9.2") => ({
  package: {
    manifest: { schemaVersion: 1, id, name, version: "1.0.0", type: "script", entry: "main.js", minHostVersion, apiVersion: 1, requiredModules: required.length ? ["materials"] : [], optionalModules: optional.includes("knowledge.create") ? ["knowledge"] : [] },
    resource: { code: "// fixture", requiredPermissions: required, optionalPermissions: optional, dataVersion: 1, contributions: [{ id: "manifest", label: "生成素材清单", kind: "command" }, { id: "manifest-menu", label: "素材清单面板", kind: "menu" }, { id: "settings", label: "清单设置", kind: "settings" }] },
  },
  enabled, digest: "d-" + id, epoch: 1, grants,
});
const PACKAGES = [
  script("example.material-manifest", "素材使用清单", ["materials.read"], ["knowledge.create"], ["materials.read", "knowledge.create"], true),
  script("example.palette", "素材平均配色", ["materials.read", "materials.image"], ["materials.tags"], [], false),
  script("example.old-tool", "旧版画布工具", ["canvas.read"], [], [], false, "9.9.9"),
];
const RUN_UI = {
  title: "素材使用清单",
  text: "共 3 项素材，按类型分为 2 组：\n【image】2 项\n- hero.png（image/png，managed，标签 1 个）\n- logo.svg（image/svg+xml，source，标签 2 个）\n【video】1 项\n- clip.mp4（video/mp4，linked，标签 0 个）",
  fields: [{ id: "group", label: "分组方式（kind=按类型 / storage=按存储模式）", value: "kind" }, { id: "title", label: "清单标题", value: "素材使用清单" }],
  actions: [{ id: "note", label: "生成素材清单笔记" }],
};
const NOTE = { documentRef: { vaultId: "vault-main", relativePath: "notes/素材使用清单.md" }, title: "素材使用清单", content: "", revision: "1" };

(async () => {
  const cssText = fs.readFileSync(root + "/src/features/community/community.css", "utf8") + fs.readFileSync(root + "/src/features/community/scriptPlugins.css", "utf8");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { I18nProvider } from "./src/core/i18n/index";
        import { ScriptPackagesPanel, PluginEntryMenu } from "./src/features/community/ScriptPlugins";
        createRoot(document.getElementById("root")).render(
          <I18nProvider locale="zh-CN"><ScriptPackagesPanel /><PluginEntryMenu /></I18nProvider>
        );
      `,
      resolveDir: root, loader: "tsx",
    },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: "app.js", write: false,
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    plugins: [{
      name: "fixture-transport", setup(b) {
        const map = new Map([
          ["@tauri-apps/api/core", `export const invoke = async (cmd, args) => {
            if (cmd === "manage_extension_packages") return window.__pkgTransport(JSON.parse(args.request));
            if (cmd === "extension_runtime") return window.__runtimeTransport(JSON.parse(args.request));
            if (cmd === "list_canvases") return [{ id: "c1", name: "研究主线图" }, { id: "c2", name: "人物关系" }];
            throw new Error("unexpected " + cmd);
          };`],
          ["@tauri-apps/plugin-dialog", "export const save = async () => 'C:/synthetic-fixture/canvas-export.svg';"],
          ["../../core/services/materials", `export const listMaterialAssets = async () => window.__fixtures.materials;
            export const listFilteredMaterialAssets = async (f = {}) => window.__fixtures.materials.filter(m => !f.query || m.name.toLowerCase().includes(f.query.toLowerCase()));`],
          ["../../core/services/knowledge", `export const listKnowledgeDocuments = async (input = {}) => window.__fixtures.notes.slice(0, input.limit === undefined ? 200 : input.limit).map(n => ({ ...n }));
            export const searchKnowledgeDocuments = async (query, limit) => window.__fixtures.notes.filter(n => n.title.toLowerCase().includes(String(query).toLowerCase())).slice(0, limit || 100);
            export const ensureActiveKnowledgeUiSource = async () => ({ vaultId: "vault-main", sourceEpoch: 7 });
            export const knowledgeDocumentNoteId = (ref) => "note:" + ref.relativePath;`],
          ["../../core/services/knowledgeSource", "export const readActiveKnowledgeWriteSource = () => ({ mode: 'real-vault', vaultId: 'vault-main' });"],
          ["../../core/services/context", "export const focusEntity = () => {};"],
        ]);
        b.onResolve({ filter: /^(@tauri-apps\/api\/core|@tauri-apps\/plugin-dialog|\.\.\/\.\.\/core\/services\/(materials|knowledge|knowledgeSource|context))$/ }, args => {
          if (!map.has(args.path)) return null;
          return { path: args.path, namespace: "fixture" };
        });
        b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: map.get(args.path), loader: "js" }));
      },
    }],
  });
  const appJs = built.outputFiles[0].text;

  const LIGHT = ":root{--bg-active:#ececf0;--bg-elevated:#fff;--bg-panel:#f6f6f9;--bg-input:#fff;--bg-hover:#f0f0f4;--bg-base:#fff;--border:#dcdce4;--border-strong:#c8c8d4;--text-primary:#1c1c22;--text-secondary:#4c4c58;--text-tertiary:#8a8a96;--accent:#4f6ef7;--accent-muted:#e6eaff;--accent-soft-border:#b9c6ff;--warning:#b57f24;--danger:#c0554d;--radius-md:10px;--radius-sm:6px;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--space-8:20px;--transition:120ms ease}body{margin:24px;background:#fafafc;color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}";
  const DARK = ":root{--bg-active:#26262e;--bg-elevated:#1b1b21;--bg-panel:#17171c;--bg-input:#232329;--bg-hover:#232329;--bg-base:#17171c;--border:#33333d;--border-strong:#43434f;--text-primary:#e8e8ee;--text-secondary:#b6b6c2;--text-tertiary:#82828e;--accent:#7c8aff;--accent-muted:#242a4d;--accent-soft-border:#3b4478;--warning:#d29a3a;--danger:#e0685f;--radius-md:10px;--radius-sm:6px;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--space-8:20px;--transition:120ms ease}body{margin:24px;background:#101014;color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}";

  const boot = `
    window.__fixtures = {
      materials: [
        { id: "m1", name: "hero.png", kind: "image", mimeType: "image/png", revision: "r1", storageMode: "managed", tagIds: ["t1"] },
        { id: "m2", name: "clip.mp4", kind: "video", mimeType: "video/mp4", revision: "r1", storageMode: "linked", tagIds: [] },
        { id: "m3", name: "logo.svg", kind: "image", mimeType: "image/svg+xml", revision: "r2", storageMode: "source", tagIds: ["t1", "t2"] },
        ...Array.from({ length: 120 }, (_, i) => ({ id: "f" + i, name: "资料-" + String(i).padStart(3, "0"), kind: "document", mimeType: "application/pdf", revision: "r1", storageMode: "managed", tagIds: [] })),
      ],
      notes: Array.from({ length: 40 }, (_, i) => ({ documentRef: { vaultId: "vault-main", relativePath: "notes/note-" + String(i).padStart(3, "0") + ".md" }, title: "笔记 " + String(i).padStart(3, "0"), relativePath: "notes/note-" + String(i).padStart(3, "0") + ".md" })),
    };
    let revision = 7; const packages = ${JSON.stringify(PACKAGES)}.map(p => structuredClone(p));
    window.__pkgTransport = (req) => {
      const state = () => ({ revision, hostVersion: "1.9.2", packages: packages.map(p => structuredClone(p)) });
      const touch = (id, patch) => { const p = packages.find(x => x.package.manifest.id === id); if (p) Object.assign(p, patch); revision += 1; };
      if (req.op === "list") return state();
      if (req.op === "enable" || req.op === "disable") { touch(req.id, { enabled: req.op === "enable" }); return state(); }
      if (req.op === "grant") { touch(req.id, { grants: req.grants, ...(req.grants.length ? {} : { enabled: false }) }); return state(); }
      if (req.op === "uninstall") { packages.splice(packages.findIndex(x => x.package.manifest.id === req.id), 1); revision += 1; return state(); }
      return state();
    };
    let ranWithWrite = false;
    window.__runtimeTransport = async (req) => {
      if (req.op === "start") return { token: "t1" };
      if (req.op === "close") return {};
      if (req.op === "dispatch") return { response: { value: structuredClone(${JSON.stringify(NOTE)}) } };
      if (req.op === "poll") {
        if (!ranWithWrite) { ranWithWrite = true; return { kind: "call", request: { method: "knowledge.create", params: { title: "素材使用清单", content: "..." } } }; }
        return { kind: "result", result: { ok: true, value: structuredClone(${JSON.stringify(RUN_UI)}) }, receipts: [{ method: "knowledge.create", committed: true }] };
      }
      return {};
    };
  `;

  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    const theme = req.url.includes("dark") ? DARK : LIGHT;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><style>${theme}${cssText}</style><main id="root"></main><script>${boot}</script><script src="/app.js"></script>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, scheme] of [["light", "light"], ["dark", "dark"]]) {
      const page = await browser.newPage({ viewport: { width: 940, height: 1240 } });
      page.on("dialog", dialog => dialog.accept());
      await page.goto(`${base}/${scheme}`);
      await page.locator(".plugin-card").first().waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(outDir, `plugin-panel-${name}.png`), fullPage: true });
      console.log("captured panel", name);
      await page.locator('.plugin-entry:has-text("生成素材清单")').first().click();
      await page.locator(".plugin-dialog").waitFor();
      await page.waitForTimeout(500);
      await page.locator('.plugin-pick:has-text("hero.png") input').check();
      await page.screenshot({ path: path.join(outDir, `plugin-dialog-${name}.png`), fullPage: true });
      console.log("captured dialog", name);
      await page.locator(".plugin-run-bar button:has-text('运行')").click();
      await page.locator(".plugin-output").waitFor();
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(outDir, `plugin-run-${name}.png`), fullPage: true });
      console.log("captured run", name);
      if (name === "light") {
        await page.locator('.plugin-pick:not(.is-pinned):has-text("clip.mp4") input').check();
        await page.locator(".plugin-output.is-stale").waitFor();
        await page.screenshot({ path: path.join(outDir, "plugin-stale-light.png"), fullPage: true });
        console.log("captured stale");
      }
      await page.close();
    }
    const narrow = await browser.newPage({ viewport: { width: 480, height: 900 } });
    narrow.on("dialog", dialog => dialog.accept());
    await narrow.goto(`${base}/light`);
    await narrow.locator(".plugin-card").first().waitFor();
    await narrow.screenshot({ path: path.join(outDir, "plugin-panel-narrow.png"), fullPage: true });
    await narrow.locator('.plugin-entry:has-text("生成素材清单")').first().click();
    await narrow.locator(".plugin-dialog").waitFor();
    await narrow.waitForTimeout(400);
    await narrow.screenshot({ path: path.join(outDir, "plugin-dialog-narrow.png"), fullPage: true });
    console.log("captured narrow");
    await narrow.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
