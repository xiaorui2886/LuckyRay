param([Parameter(Mandatory=$true)][string]$ProfileRoot)
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
$anchors = @($ProfileRoot,(Join-Path $ProfileRoot 'luckyray.db')) | Where-Object { Test-Path -LiteralPath $_ }
if (-not (Test-Path -LiteralPath $ProfileRoot -PathType Container)) { throw 'luckyray-development-profile-unavailable' }
foreach ($anchor in $anchors) {
  $expected = Normalize-PhysicalPath $anchor
  $actual = Normalize-PhysicalPath ([LuckyRayPhysicalProfilePath]::Resolve($anchor))
  if (-not $expected.Equals($actual,[StringComparison]::OrdinalIgnoreCase)) {
    throw "luckyray-development-profile-redirected: expected $expected; opened $actual. Use an ordinary Windows terminal. No profile files were changed."
  }
}
