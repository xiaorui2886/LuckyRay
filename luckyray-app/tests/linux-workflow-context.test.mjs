import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/linux-desktop-preflight.yml', import.meta.url), 'utf8');

test('runner context is scoped to steps, not the job environment', () => {
  const jobEnv = workflow.match(/^    env:\s*\n([\s\S]*?)^    steps:/m)?.[1];
  assert.ok(jobEnv, 'job environment must be present');
  assert.doesNotMatch(jobEnv, /\$\{\{\s*(?:runner|steps|job)\./);

  const stepTargetDirs = [...workflow.matchAll(/^          CARGO_TARGET_DIR: (.+)$/gm)];
  assert.equal(stepTargetDirs.length, 3);
  for (const [, value] of stepTargetDirs) {
    assert.equal(value, '${{ runner.temp }}/luckyray-linux-diagnostic-target');
  }
});
