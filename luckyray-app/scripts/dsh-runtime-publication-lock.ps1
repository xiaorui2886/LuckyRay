function Get-DshRuntimePublicationMutexName {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$DestinationRoot)

  $canonical = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\').ToUpperInvariant()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
  }
  finally {
    $sha256.Dispose()
  }
  return "Local\LuckyRay-Dsh-Dev-Runtime-$digest"
}

function New-DshRuntimePublicationSiblingPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][ValidateSet('Partial','Quarantine')][string]$Kind
  )

  $destination = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  $suffix = $Kind.ToLowerInvariant()
  return '{0}.{1}-{2}-{3}' -f $destination,$suffix,$PID,[guid]::NewGuid().ToString('N')
}

function Move-DshRuntimePublicationEntryToQuarantine {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$DestinationRoot)

  $destination = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $destination)) {
    return $null
  }
  $quarantine = New-DshRuntimePublicationSiblingPath `
    -DestinationRoot $destination -Kind Quarantine
  Move-Item -LiteralPath $destination -Destination $quarantine -ErrorAction Stop
  return $quarantine
}

function Invoke-DshRuntimePublication {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][scriptblock]$ValidateRuntime,
    [Parameter(Mandatory = $true)][scriptblock]$PublishRuntime,
    [ValidateRange(1, 1800000)][int]$TimeoutMilliseconds = 600000
  )

  $destination = [System.IO.Path]::GetFullPath($DestinationRoot)
  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new(
    $false,
    (Get-DshRuntimePublicationMutexName -DestinationRoot $destination),
    [ref]$createdNew)
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne($TimeoutMilliseconds)
    }
    catch [System.Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      throw 'dsh-dev-runtime-publication-lock-timeout'
    }

    if (-not [bool](& $ValidateRuntime $destination)) {
      Move-DshRuntimePublicationEntryToQuarantine -DestinationRoot $destination | Out-Null
      try {
        & $PublishRuntime $destination | Out-Null
      }
      catch {
        Move-DshRuntimePublicationEntryToQuarantine -DestinationRoot $destination | Out-Null
        throw
      }
      if (-not [bool](& $ValidateRuntime $destination)) {
        Move-DshRuntimePublicationEntryToQuarantine -DestinationRoot $destination | Out-Null
        throw 'dsh-dev-runtime-publication-invalid'
      }
    }
    return $destination
  }
  finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
