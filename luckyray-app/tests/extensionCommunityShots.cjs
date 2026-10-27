// Visual capture for the EXT-Z1 community package surface. Renders the real
// panel in headless Edge and writes PNGs for light + dark reading checks.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "playwright",
);
const outDir = process.env.LUCKYRAY_EXT_Z1_SHOTS || "./test-results/ext-z1-community";

const THEME = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.paper-sage", name: "Paper Sage", version: "1.0.0", type: "theme", entry: "theme.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: [], optionalModules: [] },
  resource: { base: "light", tokens: { "--theme-app-bg": "#edf1e8", "--theme-sidebar-bg": "#e2e9dd", "--theme-titlebar-bg": "#f6f8f2", "--theme-surface-base": "#f2f5ec", "--theme-surface-raised": "#fcfdf9", "--theme-surface-panel": "#e8eee1", "--theme-card-bg": "#f6f8f2", "--theme-hover": "#dce5d4", "--theme-selected": "#ceddc3", "--theme-border-subtle": "#dce4d4", "--theme-border-strong": "#c3d1b9", "--theme-dialog-border": "#c3d1b9", "--theme-text-muted": "#74806d", "--text-primary": "#293b29", "--text-secondary": "#52664d" } },
});
const TEMPLATE = JSON.stringify({
  manifest: { schemaVersion: 0, id: "org.luckyray.research-note", name: "Research note", version: "1.0.0", type: "template", entry: "template.json", minHostVersion: "1.9.2", apiVersion: 0, requiredModules: ["knowledge"], optionalModules: ["assets"] },
  resource: { markdown: "# {{topic}}\n\n## Research question\n\n{{question}}\n", parameters: { topic: "Research note", question: "What do we need to learn?" } },
});

(async () => {
  const cssText = fs.readFileSync(root + "/src/features/community/community.css", "utf8");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { createExtensionPackageService } from "./src/core/extensions/packages";
        import { PackagesPanel } from "./src/features/community/ExtensionPackagesPanel";
        import { EXT_PACKAGE_MESSAGES } from "./src/features/community/extensionMessages";
        let revision = 0; const store = new Map();
        const state = () => ({ revision, hostVersion: "1.9.2", packages: [...store.values()].map((p) => ({ ...p })) });
        const transport = async (r) => {
          if (r.op === "list") return state();
          const m = r.package?.manifest;
          if (r.op === "install") { const e = store.get(m.id); if (!e) store.set(m.id, { package: r.package, enabled: false, digest: "d" + revision }); revision += 1; return state(); }
          if (r.op === "enable" || r.op === "disable") { store.get(r.id).enabled = r.op === "enable"; revision += 1; return state(); }
          if (r.op === "uninstall") { store.delete(r.id); revision += 1; return state(); }
          return state();
        };
        const service = createExtensionPackageService(transport);
        window.__service = service;
        const locale = "zh-CN";
        const t = (key, vars = {}) => (EXT_PACKAGE_MESSAGES[key] ? EXT_PACKAGE_MESSAGES[key][locale].replace(/\\{([a-zA-Z][\\w]*)\\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : key);
        createRoot(document.getElementById("root")).render(<PackagesPanel service={service} copy={{ t, locale }} onMessage={() => {}} />);
      `,
      resolveDir: root, loader: "tsx",
    },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: "app.js", write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "stub", setup(b) { b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "t", namespace: "s" })); b.onLoad({ filter: /.*/, namespace: "s" }, () => ({ contents: "export const invoke = async () => ({ revision: 0, hostVersion: '1.9.2', packages: [] });", loader: "js" })); } }],
    logLevel: "silent",
  });
  const appJs = built.outputFiles[0].text;

  const LIGHT = ":root{--bg-active:#ececf0;--bg-elevated:#fff;--bg-panel:#f6f6f9;--bg-input:#fff;--border:#dcdce4;--border-strong:#c8c8d4;--text-primary:#1c1c22;--text-secondary:#4c4c58;--text-tertiary:#8a8a96;--accent:#4f6ef7;--accent-text:#3b53c9;--danger:#c0554d;--radius-md:10px;--radius-sm:6px;--font-mono:ui-monospace,monospace;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--transition:120ms ease}body{margin:24px;background:#fafafc;color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}main{max-width:760px}";
  const DARK = ":root{--bg-active:#26262e;--bg-elevated:#1b1b21;--bg-panel:#17171c;--bg-input:#232329;--border:#33333d;--border-strong:#43434f;--text-primary:#e8e8ee;--text-secondary:#b6b6c2;--text-tertiary:#82828e;--accent:#7c8aff;--accent-text:#a3aeff;--danger:#e0685f;--radius-md:10px;--radius-sm:6px;--font-mono:ui-monospace,monospace;--fs-xs:10px;--fs-sm:11px;--fs-md:12px;--fs-lg:14px;--space-2:6px;--space-3:8px;--space-4:10px;--space-5:12px;--space-6:14px;--space-7:16px;--transition:120ms ease}body{margin:24px;background:#101014;color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}main{max-width:760px}";

  const server = http.createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(appJs); return; }
    const theme = req.url.includes("dark") ? DARK : LIGHT;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<meta charset="utf-8"><style>${theme}${cssText}</style><main id="root"></main><script src="/app.js"></script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const [name, scheme, themePack] of [["light", "light", THEME], ["dark", "dark", THEME]]) {
      const page = await browser.newPage({ viewport: { width: 860, height: 720 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/${scheme}`);
      await page.locator(".ext-packages").waitFor();
      await page.setInputFiles('.ext-install input[type="file"]', { name: "paper-sage.lrpack.json", mimeType: "application/json", buffer: Buffer.from(themePack) });
      await page.locator('.ext-package-card:has-text("Paper Sage")').waitFor();
      await page.setInputFiles('.ext-install input[type="file"]', { name: "research-note.lrpack.json", mimeType: "application/json", buffer: Buffer.from(TEMPLATE) });
      await page.locator('.ext-package-card:has-text("Research note")').waitFor();
      await page.locator('.ext-package-card:has-text("Paper Sage") button:has-text("启用")').click();
      await page.locator('.ext-package-card:has-text("Paper Sage") .ext-package-state.is-on').waitFor();
      await page.locator('.ext-package-card button, button:has-text("使用模板")').first().waitFor().catch(() => {});
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(outDir, `package-surface-${name}.png`), fullPage: true });
      await page.close();
      console.log("captured", name);
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
