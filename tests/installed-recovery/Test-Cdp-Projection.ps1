param([switch]$BeforeFix,[ValidateSet('Run-Red.ps1','Run-Green.ps1')][string]$ScriptName='Run-Red.ps1')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$errors=$null;$tokens=$null
$source=if($BeforeFix){(& git show 'fe54fc3a07c9b0515e5d5d3f08b2973648ae13c3:tests/installed-recovery/Run-Red.ps1' | Out-String).Replace("'http://127.0.0.1:50891/json/list'",'"http://127.0.0.1:$script:cdpPort/json/list"')}else{Get-Content -LiteralPath (Join-Path $PSScriptRoot $ScriptName) -Raw}
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'harness-syntax-invalid'}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Evaluate'},$true)
if(-not $function){throw 'projection-function-missing'}
Invoke-Expression $function.Extent.Text
$script:cdpSequence=0
$fixture=Join-Path $PSScriptRoot 'cdp-synthetic-fixture.py'
$processInfo=[Diagnostics.ProcessStartInfo]::new('python')
$processInfo.ArgumentList.Add($fixture)
$inputCheck=$ScriptName -ceq 'Run-Green.ps1' -and -not $BeforeFix
if($inputCheck){$processInfo.ArgumentList.Add('--input-check')}
$processInfo.UseShellExecute=$false;$processInfo.CreateNoWindow=$true;$processInfo.RedirectStandardOutput=$true
$process=[Diagnostics.Process]::Start($processInfo)
try{
 $script:cdpPort=[int]$process.StandardOutput.ReadLine()
 $boolean=@(Evaluate 'Boolean(window.__TAURI_INTERNALS__)')
 $status=@(Evaluate 'synthetic-host-status')
 if($BeforeFix){
  if($boolean.Count -le 1 -or $status.Count -le 1){throw 'original-projection-defect-not-reproduced'}
  [ordered]@{originalDefectReproduced=$true;booleanOutputs=$boolean.Count;statusOutputs=$status.Count;types=@($status|ForEach-Object{$_.GetType().Name})}|ConvertTo-Json -Compress
  return
 }
 if($boolean.Count -ne 1 -or $boolean[0] -isnot [bool] -or $boolean[0] -ne $true){throw 'projection-boolean-contaminated'}
 if($status.Count -ne 1 -or $status[0].stage -cne 'unavailable' -or $status[0].canProbe -ne $false){throw 'projection-object-contaminated'}
 if($inputCheck){
  $inserted=@(Evaluate 'LR synthetic input' -TextInput)
  if($inserted.Count -ne 1 -or $inserted[0] -isnot [bool] -or -not $inserted[0]){throw 'projection-input-result-invalid'}
 }
 Write-Output 'Real WebSocket projection: one boolean and one exact synthetic status; no output contamination.'
}finally{if(-not $process.WaitForExit(20000)){throw 'synthetic-fixture-did-not-retire'}}
