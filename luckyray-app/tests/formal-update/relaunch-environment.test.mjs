import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';
const helper=new URL('./Manage-ApprovedRelaunchEnvironment.ps1',import.meta.url);
test('relaunch environment helper journals exact scope before mutation',()=>{
  const bytes=readFileSync(helper),s=bytes.toString('utf8');
  assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
  assert.ok(s.indexOf('[IO.FileMode]::CreateNew')<s.indexOf('$key.SetValue('));
  assert.ok(s.includes("OpenSubKey('Environment',$true)"));
  assert.ok(s.includes("$state.userSid -cne $identity.User.Value"));
  assert.ok(s.includes('RegistryValueOptions]::DoNotExpandEnvironmentNames'));
  assert.ok(!s.includes('Registry]::LocalMachine'));
  assert.ok(!s.includes('SendMessage'));
  assert.ok(s.indexOf("Write-SafeEvidence 'PASS_EXACT_TEST_USER_ENVIRONMENT_REMOVED'")<s.indexOf('[IO.File]::Delete($journal)'));
});
test('native PS5 parses helper, exercises pure scope checks and read-only environment block API',{skip:process.platform!=='win32'},()=>{
  const path=fileURLToPath(helper).replaceAll("'","''");
  // Extract only a pure validator and the P/Invoke declaration. Never invoke the
  // helper body: no registry writes, certificates, installer, or approval use.
  const script=`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors);if($errors.Count){throw 'helper-parse-errors'};
$fn=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Get-ExpectedValues'},$true);if($null -eq $fn){throw 'missing-pure-validator'};. ([scriptblock]::Create($fn.Extent.Text));
$values=Get-ExpectedValues 'http://127.0.0.1:12345';if($values.Count -ne 4 -or $values.HTTPS_PROXY -cne 'http://127.0.0.1:12345' -or $values.HTTP_PROXY -cne $values.HTTPS_PROXY -or $values.NO_PROXY -cne '127.0.0.1,localhost' -or $values.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -cne '--remote-debugging-port=9391'){throw 'scope-values-mismatch'};
$rejected=0;foreach($bad in @('http://127.0.0.1:0','http://127.0.0.1:65536','http://localhost:12345','https://127.0.0.1:12345','http://127.0.0.1:12345/','http://user:pass@127.0.0.1:12345')){try{$null=Get-ExpectedValues $bad}catch{$rejected++}};if($rejected -ne 6){throw 'invalid-proxy-accepted'};
$decl=$ast.Find({param($a) $a -is [Management.Automation.Language.StringConstantExpressionAst] -and $a.Value.Contains('public static class LuckyRayRelaunchEnvironment')},$true);if($null -eq $decl){throw 'missing-native-declaration'};Add-Type -TypeDefinition $decl.Value;
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$block=[IntPtr]::Zero;try{if(-not [LuckyRayRelaunchEnvironment]::CreateEnvironmentBlock([ref]$block,$identity.Token,$false)){throw 'native-readonly-environment-block-failed'};if($block -eq [IntPtr]::Zero){throw 'null-environment-block'}}finally{if($block -ne [IntPtr]::Zero){$null=[LuckyRayRelaunchEnvironment]::DestroyEnvironmentBlock($block)};$identity.Dispose()};
@{nativeMajor=$PSVersionTable.PSVersion.Major;rejected=$rejected;readOnlyEnvironmentBlock=$true;helperExecuted=$false;registryChanged=$false}|ConvertTo-Json -Compress`;
  const result=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:30000}));
  assert.equal(result.nativeMajor,5);assert.equal(result.rejected,6);
  assert.equal(result.readOnlyEnvironmentBlock,true);assert.equal(result.helperExecuted,false);assert.equal(result.registryChanged,false);
});
