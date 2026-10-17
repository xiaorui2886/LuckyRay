import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
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
test('native observer retries a process whose main module is not published yet', {skip:process.platform!=='win32'},()=>{
  const file=fileURLToPath(observer).replaceAll("'","''");
  const script=`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors);if($errors.Count){throw 'helper-parse-errors'};$fn=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Get-ObservedExecutablePath'},$true);if($null -eq $fn){throw 'missing-path-helper'};. ([scriptblock]::Create($fn.Extent.Text));$oldFailed=$false;$pending=[pscustomobject]@{MainModule=$null};try{$null=$pending.MainModule.FileName}catch{$oldFailed=$true};if(-not $oldFailed){throw 'old-failure-not-reproduced'};if($null -ne (Get-ObservedExecutablePath $pending)){throw 'pending-path-not-null'};$known=[pscustomobject]@{MainModule=[pscustomobject]@{FileName='C:\\fixture\\LuckyRay-update.exe'}};if((Get-ObservedExecutablePath $known) -cne 'C:\\fixture\\LuckyRay-update.exe'){throw 'known-path-changed'};$self=[Diagnostics.Process]::GetCurrentProcess();try{$path=Get-ObservedExecutablePath $self;if([string]::IsNullOrWhiteSpace($path)){throw 'real-self-path-missing'}}finally{$self.Dispose()};@{nativeMajor=$PSVersionTable.PSVersion.Major;oldFailureReproduced=$true;pendingRetried=$true;knownPathPreserved=$true;systemChanges=$false}|ConvertTo-Json -Compress`;
  const result=JSON.parse(execFileSync(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
  assert.equal(result.nativeMajor,5);assert.equal(result.oldFailureReproduced,true);assert.equal(result.pendingRetried,true);assert.equal(result.knownPathPreserved,true);assert.equal(result.systemChanges,false);
});
