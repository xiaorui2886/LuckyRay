param([Parameter(Mandatory=$true)][int]$Status, [ValidateRange(1,65535)][int]$Port = 1420)
$ErrorActionPreference = 'Stop'
switch ($Status) {
  0 { return }
  3 { return }
  4 { throw "luckyray-development-frontend-occupied: port $Port has an unverified or unhealthy listener. Inspect its owner and health; do not stop an unidentified process." }
  5 { throw "luckyray-development-frontend-bind-denied: OS bind of port $Port was denied (EACCES). Inspect bind policy, reservations and logs; this does not prove administrator privileges are needed." }
  default { throw "luckyray-development-frontend-probe-failed: exit $Status; inspect the diagnostic above. No ownership or permission cause is established." }
}
