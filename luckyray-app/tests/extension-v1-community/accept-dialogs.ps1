# Accepts or cancels native confirm dialogs that belong ONLY to the given process id
# (the isolated fixture). Uses SendMessage(BM_CLICK) on the dialog's own button:
# no mouse/keyboard input, no focus change, no other window is touched.
param(
  [Parameter(Mandatory = $true)][int]$OwnerPid,
  [Parameter(Mandatory = $true)][string]$ModeFile,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [int]$TimeoutSec = 900
)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FixtureDialogs {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static string Text(IntPtr h) { var sb = new StringBuilder(2048); GetWindowText(h, sb, 2048); return sb.ToString(); }
  public static string Class(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static List<IntPtr> TopLevel(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
$BM_CLICK = 0x00F5
$acceptWords = @('确定', 'OK', '是', 'Yes', '确认')
$cancelWords = @('取消', 'Cancel', '否', 'No')
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$seen = New-Object 'System.Collections.Generic.HashSet[long]'
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) { break }
  $mode = 'accept'
  if (Test-Path -LiteralPath $ModeFile) { $m = (Get-Content -LiteralPath $ModeFile -Raw -ErrorAction SilentlyContinue); if ($m) { $mode = $m.Trim() } }
  foreach ($h in [FixtureDialogs]::TopLevel([uint32]$OwnerPid)) {
    if ([FixtureDialogs]::Class($h) -ne '#32770') { continue }
    $key = $h.ToInt64()
    $children = [FixtureDialogs]::Children($h)
    $message = ($children | Where-Object { [FixtureDialogs]::Class($_) -eq 'Static' } | ForEach-Object { [FixtureDialogs]::Text($_) } | Where-Object { $_ }) -join ' | '
    $buttons = @($children | Where-Object { [FixtureDialogs]::Class($_) -eq 'Button' })
    $words = if ($mode -eq 'cancel') { $cancelWords } else { $acceptWords }
    $target = $buttons | Where-Object { $t = [FixtureDialogs]::Text($_) -replace '&', ''; $words -contains $t.Trim() } | Select-Object -First 1
    if (-not $target -and $buttons.Count -gt 0) { $target = if ($mode -eq 'cancel') { $buttons[-1] } else { $buttons[0] } }
    if ($target) {
      [FixtureDialogs]::SendMessage($target, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      $entry = [ordered]@{ at = (Get-Date).ToString('o'); ownerPid = $OwnerPid; hwnd = ('0x{0:X}' -f $key); title = [FixtureDialogs]::Text($h); message = $message; mode = $mode; clicked = ([FixtureDialogs]::Text($target) -replace '&', ''); buttons = @($buttons | ForEach-Object { [FixtureDialogs]::Text($_) -replace '&', '' }) }
      Add-Content -LiteralPath $LogFile -Value ($entry | ConvertTo-Json -Compress) -Encoding UTF8
      [void]$seen.Add($key)
      Start-Sleep -Milliseconds 400
    }
  }
  Start-Sleep -Milliseconds 150
}
