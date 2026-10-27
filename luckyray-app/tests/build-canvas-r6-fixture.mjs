import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";
const source = resolve("src/CanvasSpike.tsx");
if (!process.argv[2]) throw Error("Pass output path");
await build({
  stdin: {
    contents:
      (await readFile(source, "utf8")) +
      '\nexport {MaterialCompactComposer,I18nProvider,ReactFlowProvider};\nexport {CanvasMediaProfilesPanel} from "./features/canvas/CanvasMediaProfilesPanel";\nexport {canvasMediaProfilesClient,resolveCanvasTextSelection} from "./core/services/canvasMediaProfiles";\nexport {CanvasImageTools} from "./features/canvas/CanvasImageTools";\n',
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
  outfile: resolve(process.argv[2]),
});
