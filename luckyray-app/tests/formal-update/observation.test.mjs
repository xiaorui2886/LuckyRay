import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {within,lineCollector} from './observation.mjs';

test('native evidence remains exact across every chunk split',()=>{
  const line='[dsh-update-exit] lsh official saved=true stopped=true revision=23 exit=0';
  const input=line+'\r\n[workspace] saved=true\n';
  for(let split=0;split<=input.length;split++){
    const output=[];const collector=lineCollector(s=>output.push(s));
    collector.write(input.slice(0,split));collector.write(input.slice(split));collector.end();
    assert.deepEqual(output,[line,'[workspace] saved=true']);
  }
});
test('character-at-a-time and unterminated final line do not lose or duplicate evidence',()=>{
  const output=[];const collector=lineCollector(s=>output.push(s));
  for(const char of 'first\nsecond')collector.write(char);
  collector.end();collector.end();assert.deepEqual(output,['first','second']);
});
test('observer deadlines cover never-settling operations',async()=>{
  await assert.rejects(within('hung status',()=>new Promise(()=>{}),20),/hung status timed out/);
});
test('observer deadlines preserve results and underlying errors',async()=>{
  assert.equal(await within('ok',()=>42,100),42);
  await assert.rejects(within('fail',()=>{throw Error('original failure');},100),/original failure/);
});
test('installer observation is armed before either actual trigger and binds its parent',()=>{
  const chain=readFileSync(new URL('./installed-chain.mjs',import.meta.url),'utf8');
  const firstArm=chain.indexOf("if(updateMode==='immediate')await startInstallerObserver(installerLanguage)");
  assert.ok(firstArm>0&&firstArm<chain.indexOf("await event('immediate_update_clicked'"));
  const scheduled=chain.indexOf("stage='scheduled_next_normal_start'");
  assert.ok(chain.indexOf('await startInstallerObserver(installerLanguage)',scheduled)<chain.indexOf('Startup=spawn',scheduled));
  assert.match(chain,/assert.equal\(installerResult.parentPid,installerParentPid/);
  assert.match(chain,/assert.equal\(BProcess.ppid,installer.pid/);
  assert.ok(chain.indexOf("await writeFile(join(evidence,'RESULT.json'),JSON.stringify(failure")<chain.indexOf("within('bounded stop diagnostics'"));
  const helper=readFileSync(new URL('./Observe-PassiveInstaller.ps1',import.meta.url),'utf8');
  assert.ok(helper.indexOf('$null=$candidate.Handle')<helper.indexOf('$candidateOwner=Get-CimInstance'));
  assert.ok(helper.indexOf('$candidateOwner=Get-CimInstance')<helper.indexOf('Get-FileHash'));
  assert.match(helper,/installer-owner-hash-mismatch/);
  assert.match(helper,/installer-language-not-inherited/);
});
