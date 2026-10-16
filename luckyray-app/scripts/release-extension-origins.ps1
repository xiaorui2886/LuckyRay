Set-StrictMode -Version Latest

function Get-LuckyRaySha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-LuckyRayChromiumExtensionId([byte[]]$SubjectPublicKeyInfo) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $algorithm.ComputeHash($SubjectPublicKeyInfo)
  } finally {
    $algorithm.Dispose()
  }
  $alphabet = 'abcdefghijklmnop'
  $builder = [Text.StringBuilder]::new(32)
  for ($index = 0; $index -lt 16; $index++) {
    $value = [int]$digest[$index]
    [void]$builder.Append($alphabet[($value -shr 4) -band 0x0f])
    [void]$builder.Append($alphabet[$value -band 0x0f])
  }
  return $builder.ToString()
}

function ConvertTo-LuckyRayCanonicalExtensionOrigin([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Trim() -cne $Value -or $Value -cne $Value.ToLowerInvariant()) {
    throw 'release-extension-origin-invalid'
  }
  $origin = if ($Value.EndsWith('/')) { $Value.Substring(0, $Value.Length - 1) } else { $Value }
  if (-not $origin.StartsWith('chrome-extension://', [StringComparison]::Ordinal)) {
    throw 'release-extension-origin-invalid'
  }
  $id = $origin.Substring('chrome-extension://'.Length)
  if ($id -notmatch '\A[a-p]{32}\z') {
    throw 'release-extension-origin-invalid'
  }
  return $origin
}

function ConvertTo-LuckyRayCanonicalOriginSet([string[]]$Values) {
  if ($Values.Count -eq 0) { throw 'release-extension-origin-empty' }
  $canonical = [Collections.Generic.List[string]]::new()
  foreach ($value in $Values) {
    $canonical.Add((ConvertTo-LuckyRayCanonicalExtensionOrigin ([string]$value)))
  }
  $sorted = @($canonical.ToArray() | Sort-Object)
  for ($index = 1; $index -lt $sorted.Count; $index++) {
    if ($sorted[$index - 1] -ceq $sorted[$index]) { throw 'release-extension-origin-duplicate' }
  }
  return [string[]]$sorted
}

function Assert-LuckyRayReleaseOriginSchemaTokens([string]$RawConfig) {
  # ConvertFrom-Json collapses duplicate property names. The tracked release
  # schema is intentionally tiny, so reject any duplicate expected field before
  # parsing instead of allowing a last-value-wins ambiguity into staging.
  foreach ($field in @('schemaVersion', 'channel', 'origins', 'publicKeySha256')) {
    $pattern = '(?<!\\)"' + [regex]::Escape($field) + '"\s*:'
    if ([regex]::Matches($RawConfig, $pattern).Count -ne 1) {
      throw 'release-extension-origins-schema-invalid'
    }
  }
}

function Get-LuckyRayManifestPublicKey($Manifest) {
  if ($null -eq $Manifest.PSObject.Properties['key'] -or $Manifest.key -isnot [string]) {
    throw 'release-extension-manifest-key-missing'
  }
  $manifestKey = [string]$Manifest.key
  try { $publicKey = [Convert]::FromBase64String($manifestKey) } catch { throw 'release-extension-manifest-key-invalid' }
  if ($publicKey.Length -lt 128 -or [Convert]::ToBase64String($publicKey) -cne $manifestKey) {
    throw 'release-extension-manifest-key-invalid'
  }
  return ,$publicKey
}

function Get-LuckyRayReleaseOriginConfig([string]$RepoRoot) {
  $repo = [IO.Path]::GetFullPath($RepoRoot)
  $configPath = Join-Path $repo 'config\release-extension-origins.json'
  $manifestPath = Join-Path $repo 'browser-extension-prototype\manifest.json'
  try {
    $configBytes = [IO.File]::ReadAllBytes($configPath)
    $rawConfig = [Text.Encoding]::UTF8.GetString($configBytes)
  } catch {
    throw 'release-extension-origins-config-unavailable'
  }
  Assert-LuckyRayReleaseOriginSchemaTokens $rawConfig
  try {
    $config = ($rawConfig | ConvertFrom-Json)
  } catch {
    throw 'release-extension-origins-config-invalid'
  }
  $expected = @('schemaVersion', 'channel', 'origins', 'publicKeySha256')
  $properties = @($config.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($properties.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $properties }).Count -ne 0 -or
      @($properties | Where-Object { $_ -notin $expected }).Count -ne 0 -or
      $config.schemaVersion -ne 1 -or [string]$config.channel -cne 'private-release-v1') {
    throw 'release-extension-origins-schema-invalid'
  }
  $fingerprint = [string]$config.publicKeySha256
  if ($fingerprint -notmatch '\A[0-9a-f]{64}\z' -or $config.origins -is [string] -or $null -eq $config.origins) {
    throw 'release-extension-origins-schema-invalid'
  }
  $configuredOrigins = @($config.origins | ForEach-Object {
    if ($_ -isnot [string]) { throw 'release-extension-origins-schema-invalid' }
    [string]$_
  })
  $canonicalOrigins = @(ConvertTo-LuckyRayCanonicalOriginSet $configuredOrigins)
  if ($configuredOrigins.Count -ne $canonicalOrigins.Count) { throw 'release-extension-origins-noncanonical' }
  for ($index = 0; $index -lt $configuredOrigins.Count; $index++) {
    if ($configuredOrigins[$index] -cne $canonicalOrigins[$index]) { throw 'release-extension-origins-noncanonical' }
  }
  try {
    $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    $manifest = ([Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json)
  } catch {
    throw 'release-extension-manifest-unavailable'
  }
  $subjectPublicKeyInfo = Get-LuckyRayManifestPublicKey $manifest
  $manifestFingerprint = Get-LuckyRaySha256 $subjectPublicKeyInfo
  if ($fingerprint -cne $manifestFingerprint) { throw 'release-extension-origins-manifest-mismatch' }
  $extensionId = Get-LuckyRayChromiumExtensionId $subjectPublicKeyInfo
  $expectedOrigin = 'chrome-extension://' + $extensionId
  if ($canonicalOrigins.Count -ne 1 -or $canonicalOrigins[0] -cne $expectedOrigin) {
    throw 'release-extension-origins-manifest-mismatch'
  }
  return [pscustomobject]@{
    schemaVersion = 1
    origins = [string[]]$canonicalOrigins
    effectiveOriginsCsv = ($canonicalOrigins -join ',')
    configSha256 = Get-LuckyRaySha256 $configBytes
    manifestPublicKeySha256 = $manifestFingerprint
    extensionId = $extensionId
  }
}

function Resolve-LuckyRayReleaseExtensionOrigins {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [AllowEmptyString()]
    [string]$Override = '',
    [bool]$OverrideProvided = $false
  )
  $canonical = Get-LuckyRayReleaseOriginConfig $RepoRoot
  if ($OverrideProvided) {
    $effectiveOrigins = @(ConvertTo-LuckyRayCanonicalOriginSet $Override.Split(',', [StringSplitOptions]::None))
    $source = 'explicit-override'
  } else {
    $effectiveOrigins = @($canonical.origins)
    $source = 'canonical-private-release'
  }
  $originBytes = [Text.Encoding]::UTF8.GetBytes((($effectiveOrigins -join [char]0) + [char]0))
  return [pscustomobject]@{
    schemaVersion = 1
    source = $source
    origins = [string[]]$effectiveOrigins
    effectiveOriginsCsv = ($effectiveOrigins -join ',')
    originFingerprint = Get-LuckyRaySha256 $originBytes
    configSha256 = $canonical.configSha256
    manifestPublicKeySha256 = $canonical.manifestPublicKeySha256
    extensionId = $canonical.extensionId
  }
}
