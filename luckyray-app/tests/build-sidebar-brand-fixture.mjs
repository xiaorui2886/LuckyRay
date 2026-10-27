import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.argv[2]) throw new Error("Pass an isolated QA output path");
const sidebarPath = resolve("src/app/AppSidebar.tsx");
const source = await readFile(sidebarPath, "utf8");
const stubs = new Map();
for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g)) {
  const [, bindings, specifier] = match;
  if (!specifier.startsWith(".") || specifier.endsWith(".svg") || specifier === "./SidebarBrandHeader") continue;
  const names = (bindings.match(/\{([\s\S]*)\}/)?.[1] || "").split(",")
    .map(s => s.trim()).filter(s => s && !s.startsWith("type "));
  const hasDefault = !bindings.trim().startsWith("{") && !bindings.trim().startsWith("type ");
  stubs.set(specifier, { names, hasDefault });
}
const shared = `
const noop = () => {};
const presentation = { navigation: { space: { hidden: [] }, filters: { hidden: [] } } };
const snapshot = { presentation };
const store = { subscribe: () => noop, getSnapshot: () => snapshot, dispatch: noop };
const special = {
  windowLayoutStore: () => store,
  defaultPresentation: () => presentation,
  resolveNavigationPresentation: value => value,
  arrangeControls: items => items,
  readSavedSettings: () => ({}),
  useI18n: () => ({ t: key => ({ 'sidebar.action.expand': '展开', 'sidebar.action.collapse': '收起' }[key] || key) }),
  materialLibrarySession: store,
  notesNativeViews: { hasFrozenViews: () => false },
  graphNativeViews: { hasFrozenViews: () => false },
};
`;
// Exercise the real AppSidebar state machine and header. Unrelated navigation
// services are isolated; this does not replace native shell or visual QA.
await build({
  entryPoints: [sidebarPath],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/*"],
  loader: { ".svg": "dataurl" },
  plugins: [{ name: "sidebar-unrelated-services", setup(builder) {
    builder.onResolve({ filter: /^\./ }, args => {
      if (args.importer === sidebarPath && stubs.has(args.path)) return { path: args.path, namespace: "stub" };
    });
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => {
      const { names, hasDefault } = stubs.get(args.path);
      return { contents: shared + names.map(name => `export const ${name} = special[${JSON.stringify(name)}] || (() => null);`).join("\n")
        + (hasDefault ? "\nexport default () => null;" : ""), loader: "js" };
    });
  } }],
  outfile: resolve(process.argv[2]),
});
