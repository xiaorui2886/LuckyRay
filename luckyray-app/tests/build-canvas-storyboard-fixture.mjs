import { build } from "esbuild";
import { resolve } from "node:path";
if (!process.argv[2]) throw Error("Pass output path");
await build({
  stdin: {
    contents:
      'export {CanvasStoryboard} from "./src/features/canvas/CanvasStoryboard"; export {CanvasShotSummary} from "./src/features/canvas/CanvasShotSummary"; export {CanvasCreativeRail} from "./src/features/canvas/CanvasCreativeRail"; export * from "./src/core/canvas/storyboard";',
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/*"],
  outfile: resolve(process.argv[2]),
});

