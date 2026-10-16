// Builds the community fixture frontend (production CommunityPage + PluginEntryMenu
// behind a small fixture shell) into <app>/target/extension-community-fixture/.
// Usage: node tests/extension-v1-community/build.mjs  (prints the asset manifest)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const outDir = path.join(root, "target", "extension-community-fixture");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/** Vite's `?raw` import suffix → plain text module. */
const rawPlugin = {
  name: "vite-raw",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw" }));
    build.onLoad({ filter: /.*/, namespace: "raw" }, args => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))};`, loader: "js" }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(here, "entry.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  target: "es2022",
  outdir: outDir,
  entryNames: "app",
  sourcemap: false,
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.MODE": '"fixture"',
  },
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".svg": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  plugins: [rawPlugin],
  metafile: true,
});

fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>LuckyRay 插件隔离测试实例</title><link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>
`);
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = {
  builtAt: new Date().toISOString(),
  outDir,
  files: Object.fromEntries(["index.html", "app.js", "app.css"].filter(f => fs.existsSync(path.join(outDir, f))).map(f => [f, { bytes: fs.statSync(path.join(outDir, f)).size, sha256: sha(path.join(outDir, f)) }])),
  inputs: Object.keys(result.metafile.inputs).length,
  productionModules: Object.keys(result.metafile.inputs).filter(f => f.startsWith("src/")).length,
};
fs.writeFileSync(path.join(outDir, "build-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
