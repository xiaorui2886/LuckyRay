// Fail before bundling while mandatory platform implementations are absent.
// This script does not manufacture release inputs or replace build.rs checks.
const unresolved = [
  'integration of the separately sealed Linux LSH resources and complete redistribution materials',
  'prepared Linux sidecars with source-bound identities',
  'Linux Python, FFmpeg and complete runtime license inventories',
  'browser-host request mediation and native messaging revocation',
];

console.error('LuckyRay Linux package preparation is unavailable:');
for (const item of unresolved) console.error(`- ${item}`);
process.exitCode = 1;
