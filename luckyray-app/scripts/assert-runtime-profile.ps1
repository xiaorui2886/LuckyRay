$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expected = "development"
$actual = if (Test-Path -LiteralPath "Env:LUCKYRAY_APP_PROFILE") {
  [string]$env:LUCKYRAY_APP_PROFILE
} else {
  ""
}

if ($actual -cne $expected) {
  throw "luckyray-development-profile-required"
}
