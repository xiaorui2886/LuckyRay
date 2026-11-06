import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, process.env.LR_R7_TEST_OUTPUT || 'output/canvas-agent-r7-verification');
mkdirSync(output, { recursive: true });
const groups = [
  ['types', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['asset-pins', ['--test', 'tests/dshHostAssetBindings.contract.test.mjs']],
  ['runtime-carrier', ['--test', 'tests/dshCanvasAgent.test.mjs', 'tests/dshCanvasAgentR5.test.mjs', 'tests/dshCanvasAgentHost.contract.test.mjs', 'tests/dshCanvasAgentR5Transport.test.mjs', 'tests/dshCanvasAgentCarrier.integration.test.mjs', 'tests/dshCanvasAgentServices.test.mjs', 'tests/dshCanvasAgentReasoningWire.test.mjs', 'tests/canvasAgentR5EndToEnd.test.mjs']],
  ['core', ['--experimental-strip-types', '--import', './tests/ts-extension-loader.mjs', '--test', 'tests/canvasAgentClient.test.ts', 'tests/canvasAgentPlan.test.ts', 'tests/canvasAgentReferences.test.ts', 'tests/canvasAgentActionLedger.test.ts', 'tests/canvasAgentNavigation.test.ts', 'tests/canvasAgentResultNavigation.test.ts', 'tests/canvasAgentWorkspaceExecution.test.ts', 'tests/canvasAgentGraphEdit.test.ts', 'tests/imageCropGeometry.test.ts']],
  ['react', ['--test', 'src/features/canvas/useCanvasAgent.test.cjs', 'src/features/canvas/CanvasAgentPanel.test.cjs']],
  ['creative-workbench', ['--test', 'src/features/canvas/CanvasCreativeWorkbench.test.cjs', 'src/features/canvas/CanvasCreativeRail.test.cjs', 'src/features/canvas/CanvasImageTools.test.cjs', 'src/features/canvas/CanvasImageCropOverlay.test.cjs']],
  ['black-hole', ['--test', 'tests/canvasBlackHoleRenderer.test.mjs']],
];
// Dedicated R6 suites are discovered, keeping this runner portable for Sol's checkout.
const { readdirSync } = await import('node:fs');
const r6 = readdirSync(join(root, 'tests')).filter(name => /^(?:canvasAgent|dshCanvasAgent)R6.*\.test\.(mjs|ts)$/.test(name));
if (r6.length) groups.push(['r6-regression', ['--experimental-strip-types', '--import', './tests/ts-extension-loader.mjs', '--test', ...r6.map(name => `tests/${name}`)]]);
const results = [];
for (const [name, args] of groups) {
  const run = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const log = (run.stdout || '') + (run.stderr || '');
  writeFileSync(join(output, `${name}.log`), log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(key => [key, Number(log.match(new RegExp(`(?:ℹ |# )${key} (\\d+)`))?.[1] ?? 0)]));
  const result = { name, status: run.status === 0 ? 'PASS' : 'FAIL', exitCode: run.status, signal: run.signal, ...counts };
  results.push(result); console.log(`${name}: ${result.status} (${counts.pass} pass, ${counts.fail} fail, ${counts.skipped} skip)`);
  if (run.status !== 0) console.error(log.slice(-7000));
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({ node: process.version, results, notRun: ['Windows native compile/WebView2: run separately', 'real model/provider/media calls: not part of this synthetic gate', 'browser visual assertions: run tests/canvasAgentR7Ui.browser.cjs, tests/canvasCreativeR7Ui.browser.cjs, tests/canvasImageCropR7Ui.browser.cjs and tests/canvasAgentResultR7dUi.browser.cjs separately'] }, null, 2) + '\n');
process.exitCode = results.some(result => result.status === 'FAIL') ? 1 : 0;
