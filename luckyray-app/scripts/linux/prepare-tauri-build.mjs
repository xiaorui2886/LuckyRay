// Fail before bundling while mandatory platform implementations are absent.
// This script does not manufacture release inputs or replace build.rs checks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgentBrowserBundle } from './check-agent-browser-bundle.mjs';
import { checkLinuxLshPackage } from './check-lsh-package.mjs';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const pin = JSON.parse(readFileSync(join(appRoot, 'tools', 'linux-agent-browser', 'pin.json'), 'utf8'));

// T55: the pinned Agent Browser engine is packaged only when it verifies.
const agentBrowser = checkAgentBrowserBundle({ appRoot, pin });
// T52 S3: sealed LSH resources and redistribution records are checked, not assumed.
const lsh = await checkLinuxLshPackage({ appRoot });

const unresolved = [
  'prepared Linux sidecars with source-bound identities',
  'Linux Python, FFmpeg and complete runtime license inventories',
  'browser-host native messaging revocation',
];

console.error('LuckyRay Linux package preparation is unavailable:');
for (const problem of agentBrowser) console.error(`- Agent Browser: ${problem}`);
for (const problem of lsh) console.error(`- LSH: ${problem}`);
for (const item of unresolved) console.error(`- ${item}`);
process.exitCode = 1;
