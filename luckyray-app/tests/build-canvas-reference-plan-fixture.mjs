import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve("vite"))("esbuild");
const source = resolve("src/CanvasSpike.tsx"),
  outfile = process.argv[2];
if (!outfile) throw Error("Pass output.cjs");
await build({
  stdin: {
    contents:
      (await readFile(source, "utf8")) +
      '\nexport {MaterialCompactComposer,createGenerationRequestSnapshot,resolveStoredCanvasReferences,referenceForCanvasNode,resolveCanvasConnectionData,I18nProvider,ReactFlowProvider};\nexport {REFERENCE_TEST_PROFILE} from \"../tests/fixtures/references/profile\";',
    loader: "tsx",
    resolveDir: dirname(source),
    sourcefile: source,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  loader: { ".css": "empty" },
  external: ["react", "react-dom", "react-dom/*", "@xyflow/react"],
  outfile: resolve(outfile),
});
