import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The nine reviewed behavior suites plus two reviewed UI suites are explicit.
// Keep VideoFlow here: a prior writer list omitted it. Counts may grow.
const reviewed = [
  "extensionContextMenuSecurity.contract.test.mjs",
  "extensionCaptureTask.contract.test.mjs",
  "extensionHoverCapture.contract.test.mjs",
  "extensionRecording.contract.test.mjs",
  "extensionQuickCollect.contract.test.mjs",
  "extensionPlayerMediaProbe.contract.test.mjs",
  "extensionMediaCapture.contract.test.mjs",
  "extensionVideoDownload.contract.test.mjs",
  "extensionVideoFlow.contract.test.mjs",
  "extensionIconDelivery.contract.test.ts",
  "extensionThemeContrast.contract.test.ts",
];
const added = ["extensionAppearance.contract.test.cjs"];
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...[...reviewed, ...added].map(name => `tests/${name}`)], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
