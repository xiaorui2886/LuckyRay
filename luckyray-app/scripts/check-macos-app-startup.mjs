// Real rendered UI and restart/persistence evidence on a disposable runner.
// Native pointer input, the native file picker, LSH and installation are separate.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkMaterialFlow } from "./check-macos-material-flow.mjs";

export async function checkStartup(options = {}) {
  return checkMaterialFlow(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: node check-macos-app-startup.mjs");
    await checkStartup();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
