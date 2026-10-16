function Invoke-MaterialsPairingValidation {
  param([string]$Json,[string]$Node,[string]$Entry,[string]$CredentialFile)
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Node
  if ($Entry.Contains('"') -or $CredentialFile.Contains('"')) { throw 'invalid-path' }
  $info.Arguments = '"' + $Entry + '" "' + $CredentialFile + '"'
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
  $process = New-Object Diagnostics.Process; $process.StartInfo = $info
  try {
    [void]$process.Start()
    # .NET Framework / Windows PowerShell 5.1 has no StandardInputEncoding property.
    # Write UTF-8 directly to the redirected pipe; secrets never enter argv.
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Json)
    try { $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length); $process.StandardInput.BaseStream.Flush() }
    finally { [Array]::Clear($bytes,0,$bytes.Length); $process.StandardInput.Close() }
    $publicConfig = $process.StandardOutput.ReadToEnd()
    $safeError = $process.StandardError.ReadToEnd(); $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'pairing-invalid-or-expired' }
    return $publicConfig
  } finally { $process.Dispose() }
}
