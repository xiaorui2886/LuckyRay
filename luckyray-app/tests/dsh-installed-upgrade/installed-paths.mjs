import assert from 'node:assert/strict';
import {win32} from 'node:path';

// Preparation JSON can legitimately contain / on Windows. Normalize exactly
// once at its input boundary; keep every downstream owner/directory assertion.
export function installedPaths(input) {
  assert.deepEqual(Object.keys(input).sort(),['install','local','profile','tls']);
  const paths=Object.fromEntries(Object.entries(input).map(([name,value])=>{
    assert.equal(typeof value,'string');assert.ok(win32.isAbsolute(value));
    return [name,win32.normalize(value)];
  }));
  assert.equal(paths.install,'D:\\lr-formal-uat\\安装 空格');
  assert.equal(paths.tls,'D:\\lr-formal-uat\\private\\tls.json');
  assert.equal(paths.profile,win32.join(paths.local,'..','Roaming','com.luckyray.desktop'));
  return paths;
}
