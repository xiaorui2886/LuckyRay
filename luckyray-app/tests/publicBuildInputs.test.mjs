import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validatePublishedDshRecords } from '../scripts/dsh-supply-chain.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const sealed = [
  'dsh-host/.npmrc', 'dsh-host/package.json', 'dsh-host/pnpm-lock.yaml',
  'dsh-host/pnpm-workspace.yaml', 'dsh-host/runtime-authority.json',
  'dsh-host/records/dependency-audit.json', 'dsh-host/records/launch-manifest.json',
  'dsh-host/records/runtime-manifest.json', 'dsh-host/records/THIRD-PARTY-NOTICES.txt',
];

test('the exact sealed source inputs keep LF even with Windows autocrlf enabled',()=>{
  const values=execFileSync('git',['check-attr','-z','eol','--',...sealed],{cwd:root}).toString('utf8').split('\0').filter(Boolean);
  assert.equal(values.length,sealed.length*3);
  for(let i=0;i<values.length;i+=3){
    assert.equal(values[i+1],'eol'); assert.equal(values[i+2],'lf',values[i]);
  }
});

test('published-record verification remains strict, including the full notice bytes',async()=>{
  const json=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
  const authority=await json('dsh-host/runtime-authority.json');
  const records={dependencyAudit:await json('dsh-host/records/dependency-audit.json'),
    sbom:await json('dsh-host/records/sbom.cdx.json'),
    launchManifest:await json('dsh-host/records/launch-manifest.json'),
    runtimeManifest:await json('dsh-host/records/runtime-manifest.json'),
    notice:await readFile(resolve(root,'dsh-host/records/THIRD-PARTY-NOTICES.txt'),'utf8')};
  assert.equal(validatePublishedDshRecords({authority,records}).packageCount,561);
  const crlf=records.notice.replaceAll('\r\n','\n').replaceAll('\n','\r\n');
  assert.throws(()=>validatePublishedDshRecords({authority,records:{...records,notice:crlf}}),/dsh-published-records-invalid/);
});
