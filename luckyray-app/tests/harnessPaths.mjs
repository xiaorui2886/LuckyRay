import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run against an executor's final checkout without copying product files.
export const sourceRoot = process.env.SOURCE_ROOT
  ? resolve(process.env.SOURCE_ROOT)
  : fileURLToPath(new URL('../', import.meta.url));
export function readSource(path) {
  return readFileSync(resolve(sourceRoot, path), 'utf8');
}
export function loadTypeScript() {
  if (process.env.TYPESCRIPT_PATH) {
    return createRequire(import.meta.url)(resolve(process.env.TYPESCRIPT_PATH));
  }
  return createRequire(resolve(sourceRoot, 'package.json'))('typescript');
}
