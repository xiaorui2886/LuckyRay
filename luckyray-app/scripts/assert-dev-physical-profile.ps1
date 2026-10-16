param([string]$ProfileRoot = (Join-Path $env:APPDATA 'com.luckyray.desktop.dev'))
$ErrorActionPreference = 'Stop'
if (-not ('LuckyRayPhysicalProfilePath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LuckyRayPhysicalProfilePath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  public static string Resolve(string path) {
    using (var handle=CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var buffer=new StringBuilder(32768);
      uint length=GetFinalPathNameByHandle(handle,buffer,32768,0);
      if (length==0 || length>=32768) throw new Win32Exception(Marshal.GetLastWin32Error());
      return buffer.ToString();
    }
  }
}
'@
}
function Normalize-PhysicalPath([string]$Path) {
  if ($Path.StartsWith('\\?\UNC\')) { $Path = '\\' + $Path.Substring(8) }
  elseif ($Path.StartsWith('\\?\')) { $Path = $Path.Substring(4) }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

# Anchor the data location to the Windows user profile itself. A host that
# redirects APPDATA (for example a packaged/MSIX or sandboxed harness) can make
# the profile root resolve to a fresh empty directory, which passes the
# junction check below yet silently starts the app against a different, empty
# database. The profile Known Folder is not redirected by the same mechanism, so
# comparing against it refuses that case before any database is opened.
if (-not ('LuckyRayUserProfileFolder' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LuckyRayUserProfileFolder {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  public static string Profile() {
    var id = new Guid("5E6C858F-0E22-4760-9AFE-EA3317B67173");
    IntPtr p;
    if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out p) != 0) return null;
    string value = Marshal.PtrToStringUni(p);
    CoTaskMemFree(p);
    return value;
  }
}
'@
}
$realUserProfile = [LuckyRayUserProfileFolder]::Profile()
if ($realUserProfile) {
  $expectedRoot = Normalize-PhysicalPath (Join-Path $realUserProfile 'AppData\Roaming\com.luckyray.desktop.dev')
  $actualRoot = Normalize-PhysicalPath $ProfileRoot
  if (-not $expectedRoot.Equals($actualRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw "luckyray-development-profile-outside-user-profile: development data would open at $actualRoot, but the Windows user profile is $realUserProfile. Refusing to start against a redirected/foreign data location; no profile files were changed."
  }
}

$anchors = @('luckyray.db','companion-gateway-identity-v1.dpapi') | ForEach-Object { Join-Path $ProfileRoot $_ } | Where-Object { Test-Path -LiteralPath $_ }
if (-not $anchors) {
  $ancestor = [IO.Path]::GetFullPath($ProfileRoot)
  while (-not (Test-Path -LiteralPath $ancestor)) {
    $ancestor = Split-Path -Parent $ancestor
    if (-not $ancestor) { throw 'luckyray-development-profile-parent-unavailable' }
  }
  $anchors = @($ancestor)
}
foreach ($anchor in $anchors) {
  $expected = Normalize-PhysicalPath $anchor
  $actual = Normalize-PhysicalPath ([LuckyRayPhysicalProfilePath]::Resolve($anchor))
  if (-not $expected.Equals($actual,[StringComparison]::OrdinalIgnoreCase)) {
    throw "luckyray-development-profile-redirected: expected $expected; opened $actual. Use an ordinary Windows terminal. No profile files were changed."
  }
}
Write-Host '[dev] physical profile path: verified'
