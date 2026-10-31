// Fail before bundling while mandatory platform implementations are absent.
// This script does not manufacture release inputs or replace build.rs checks.
const unresolved = [
  'owned process-tree lifecycle and settled-zero admission',
  'sealed LSH runtime and stable-file leases',
  'Linux Python, FFmpeg and complete runtime license inventories',
  'browser-host request mediation and native messaging revocation',
];

console.error('LuckyRay Linux package preparation is unavailable:');
for (const item of unresolved) console.error(`- ${item}`);
process.exitCode = 1;
