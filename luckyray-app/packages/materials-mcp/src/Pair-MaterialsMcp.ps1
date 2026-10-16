param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$stage='preflight'
# Interactive only: creating a new private client binding is an explicit user action.
try {
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  if (-not [IO.Path]::IsPathRooted($Destination) -or $Destination.StartsWith('\\')) { throw 'absolute-local-directory-required' }
  $dest = [IO.Path]::GetFullPath($Destination)
  if (Test-Path -LiteralPath $dest) { throw 'destination-must-be-new-no-overwrite' }
  Write-Host 'Use Main Settings > Storage > Materials MCP access to authorize ONE synthetic test library.'
  Write-Host 'This stores only that scoped credential, encrypted for this Windows user (DPAPI). No service or startup changes.'
  if ((Read-Host 'Save this explicit local binding? Type YES') -cne 'YES') { return }
  # Clipboard is read only after the user's button click. Multi-line JSON is never pasted into a shell.
  $stage='clipboard-import'
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object Windows.Forms.Form
  $form.Text = 'LuckyRay Materials MCP - Local Pairing'; $form.Width = 550; $form.Height = 170
  $label = New-Object Windows.Forms.Label
  $label.Text = 'Copy the ONE-TIME JSON from Main, then click Import. Nothing secret is displayed.'
  $label.Left = 15; $label.Top = 15; $label.Width = 510; $label.Height = 45
  $button = New-Object Windows.Forms.Button
  $button.Text = 'Import pairing JSON from clipboard'; $button.Left = 100; $button.Top = 65; $button.Width = 330
  $button.Add_Click({ $form.Tag = [Windows.Forms.Clipboard]::GetText(); $form.DialogResult = [Windows.Forms.DialogResult]::OK; $form.Close() })
  $form.Controls.Add($label); $form.Controls.Add($button)
  if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { $form.Dispose(); return }
  $json = [string]$form.Tag; $form.Tag = $null; $form.Dispose()
  $credentialFile = Join-Path $dest 'credential.dpapi'
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stage='pairing-validation'
  $entry = Join-Path $PSScriptRoot 'pairing.mjs'
  . (Join-Path $PSScriptRoot 'pairing-process.ps1')
  $publicConfig = Invoke-MaterialsPairingValidation -Json $json -Node $node -Entry $entry -CredentialFile $credentialFile
  $pair = $json | ConvertFrom-Json
  $summary = 'Client: ' + $pair.clientName + "`nLibrary: " + $pair.libraryId + "`nDesktop: " + $pair.desktopExe + "`nProfile: " + $pair.profileRoot + "`nExpires (Unix seconds): " + $pair.expiresAt + "`nSave the scoped encrypted binding?"
  if ([Windows.Forms.MessageBox]::Show($summary,'Confirm exact binding','OKCancel') -ne 'OK') { $json=$null; $pair=$null; return }
  # Seal identity metadata together with the scoped credential; edits to public config must not relabel the binding.
  $stage='save-private-binding'
  $secret = ConvertTo-SecureString $json -AsPlainText -Force
  $pair = $null
  $encrypted = ConvertFrom-SecureString $secret; $secret.Dispose()
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  [void][IO.Directory]::CreateDirectory($dest,$acl)
  [IO.File]::WriteAllText($credentialFile,$encrypted,(New-Object Text.UTF8Encoding($false)))
  $configPath = Join-Path $dest 'connection.json'
  [IO.File]::WriteAllText($configPath,$publicConfig,(New-Object Text.UTF8Encoding($false)))
  $clientConfig = @{mcpServers=@{'luckyray-materials'=@{command=$node;args=@((Join-Path $PSScriptRoot 'server.mjs'),'--config',$configPath)}}} | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $dest 'client.json'),$clientConfig,(New-Object Text.UTF8Encoding($false)))
  # A double-clickable status shortcut: no credential or startup action in its arguments.
  $stage='create-status-shortcut'
  $shortcutShell = New-Object -ComObject WScript.Shell
  $shortcut = $shortcutShell.CreateShortcut((Join-Path $dest 'Check Materials MCP.lnk'))
  $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $shortcut.Arguments = '-NoProfile -File "' + (Join-Path $PSScriptRoot 'Check-MaterialsMcp.ps1') + '" -ConfigPath "' + $configPath + '" -Pause'
  $shortcut.Save()
  if ([Windows.Forms.Clipboard]::GetText() -ceq $json) { [Windows.Forms.Clipboard]::Clear() }
  $json = $null
  Write-Host ('Saved private binding: ' + $configPath)
  Write-Host 'client.json contains the ready-to-use stdio client config. Check Materials MCP.lnk is the one-click status entry.'
  Write-Host 'For status, run node server.mjs --config <this connection.json> --check from an ordinary Windows terminal.'
  Write-Host 'Revoke in Main before deleting this binding. Do not share credential.dpapi or pairing JSON.'
} catch { [Console]::Error.WriteLine('Pairing was not completed at stage: '+$stage+'. Existing bindings were not overwritten. Do not share the pairing JSON.'); exit 1 }
