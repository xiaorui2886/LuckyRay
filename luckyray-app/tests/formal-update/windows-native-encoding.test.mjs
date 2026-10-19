import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
const observer=new URL('./Observe-PassiveInstaller.ps1',import.meta.url);
test('native Windows PowerShell helper files preserve non-ASCII literal encoding',()=>{
  for(const name of ['Prepare-ApprovedEphemeralHttps.ps1','Remove-ApprovedEphemeralHttps.ps1','Observe-PassiveInstaller.ps1']){
    const bytes=readFileSync(new URL('./'+name,import.meta.url));
    if(bytes.some(byte=>byte>127))assert.ok(bytes.subarray(0,3).equals(Buffer.from([239,187,191])),name+' needs its original UTF8 BOM for Windows PowerShell5.1');
  }
});
test('real Windows PowerShell5 parser sees the exact approved Chinese-space directory without running helper', {skip:process.platform!=='win32'},()=>{
  const file=fileURLToPath(observer).replaceAll("'","''");
  const script="$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('"+file+"',[ref]$tokens,[ref]$errors);if($errors.Count){throw 'helper-parse-errors'};$expected='D:\\lr-formal-uat\\'+(-join [char[]]@(0x5b89,0x88c5,0x20,0x7a7a,0x683c));$matches=@($ast.FindAll({param($a) $a -is [Management.Automation.Language.StringConstantExpressionAst] -and $a.Value -ceq $expected},$true));@{nativeMajor=$PSVersionTable.PSVersion.Major;exactPath=$matches.Count -eq 1;helperExecuted=$false}|ConvertTo-Json -Compress";
  const result=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
  assert.equal(result.nativeMajor,5);assert.equal(result.exactPath,true);assert.equal(result.helperExecuted,false);
});
test('real native process and TCP observation commands load before any trust/install action', {skip:process.platform!=='win32'},()=>{
  const script="$ErrorActionPreference='Stop';$self=Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\";if($self.ProcessId -ne $PID){throw 'native-process-observation-unavailable'};$command=Get-Command Get-NetTCPConnection -ErrorAction Stop;@{nativeMajor=$PSVersionTable.PSVersion.Major;ownProcessObserved=$true;tcpCommand=$command.Name;systemChanges=$false}|ConvertTo-Json -Compress";
  const result=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
  assert.equal(result.nativeMajor,5);assert.equal(result.ownProcessObserved,true);assert.equal(result.tcpCommand,'Get-NetTCPConnection');assert.equal(result.systemChanges,false);
});
test('the actual passive observer module bootstrap resolves every command and hashes real bytes before installation', {skip:process.platform!=='win32'},()=>{
  const bytes=readFileSync(observer),source=bytes.toString('utf8');
  const bootstrap=source.match(/^Import-Module .*Microsoft\.PowerShell\.Utility\/Microsoft\.PowerShell\.Utility\.psd1.*$/gm);
  assert.equal(bootstrap?.length,1,'exercise the actual helper bootstrap, not a parallel substitute');
  const file=fileURLToPath(observer).replaceAll("'","''");
  const script=bootstrap[0]+";$ErrorActionPreference='Stop';$names=@('Get-CimInstance','Get-FileHash','Get-Process','Get-ItemProperty','ConvertTo-Json','Set-Content');foreach($name in $names){$null=Get-Command $name -ErrorAction Stop};$hash=(Get-FileHash -LiteralPath '"+file+"' -Algorithm SHA256).Hash.ToLowerInvariant();@{nativeMajor=$PSVersionTable.PSVersion.Major;hash=$hash;hashModule=(Get-Command Get-FileHash).Module.Path;commands=$names.Count;helperExecuted=$false;systemChanges=$false}|ConvertTo-Json -Compress";
  const result=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}));
  assert.equal(result.nativeMajor,5);assert.equal(result.hash,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.hashModule.toLowerCase(),join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1').toLowerCase());
  assert.equal(result.commands,6);assert.equal(result.helperExecuted,false);assert.equal(result.systemChanges,false);
});
