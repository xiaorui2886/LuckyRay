$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Run-Green.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'harness-syntax-invalid'}
$reserved=@('host','home','args','profile','input','error','pid','pshome','codex_home')
$collisions=@($ast.FindAll({param($node)
 ($node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath.ToLowerInvariant() -in $reserved) -or
 ($node -is [Management.Automation.Language.ParameterAst] -and $node.Name.VariablePath.UserPath.ToLowerInvariant() -in $reserved)
},$true))
if($collisions.Count){throw 'harness-system-variable-collision'}
$before=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try{
 & {
  # Only extracted test-harness functions execute. The process launcher and
  # CDP transport are mocks; no product EXE, environment impersonation or
  # user's profile is involved in this timing regression.
  $script:record=[ordered]@{checks=@()};$script:navReads=0
  $installRoot='synthetic-only';$exe='never-launched.exe'
  function Start-Process {
   param($FilePath,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
   if($FilePath -cne 'never-launched.exe'){throw 'synthetic-launch-target-invalid'}
   $value=[pscustomobject]@{HasExited=$false;MainWindowHandle=[IntPtr]1;Responding=$true}
   $value | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
   return $value
  }
  function Start-Sleep { param($Milliseconds) }
  function Evaluate([string]$expression){
   if($expression -ceq 'Boolean(window.__TAURI_INTERNALS__)'){return $true}
   if($expression -ceq 'Boolean(document.querySelector(".nav-item[data-control-id=ai]"))'){
    $script:navReads++;return $script:navReads -ge 3
   }
   throw 'synthetic-evaluation-invalid'
  }
  foreach($name in @('Check','Start-Product')){
   $definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
   Invoke-Expression $definition.Extent.Text
  }
  Start-Product
  if($script:navReads -ne 3 -or -not $script:record.mainWindowReadiness[0].sidebarReady){throw 'ipc-mistaken-for-dom-ready'}
  $prior=$script:navReads;Start-Product -Legacy
  if($script:navReads -ne $prior -or -not $script:record.mainWindowReadiness[1].legacy){throw 'legacy-window-contract-invalid'}
 }
 Write-Output 'Synthetic early-IPC/delayed-sidebar readiness regression passed; no product executed.'
}finally{$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$before}
