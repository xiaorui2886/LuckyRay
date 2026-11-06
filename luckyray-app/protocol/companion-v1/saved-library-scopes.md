# Saved-library selection and explicit phone trust (candidate v1)

This is an additive source contract. It is not a receipt for an installed desktop or phone. TLS pinning, device identity, pairing-secret validation, generation fencing, source identity leases and filesystem/symlink checks remain in force. Collection, accepted Canvas/3D and LSH presentation assets are unchanged.

## Discovery and policy negotiation

GET /v1/services/libraries is authenticated. A device with no explicit policy row receives HTTP 200 with scopeSelectionVersion=0, mode=legacyDefaultOnly, authorizationMode=legacy and empty materials/knowledge arrays. The phone must use its previous default/current routes without selection headers. This preserves old access without granting another saved library. An explicitly selected Manual policy is not legacy mode: version 1 with zero permitted rows means no access, not a fallback signal.

Version 1 returns materials[{libraryId,displayName,activeInDesktop,available,readGranted,writeGranted,ingestGranted}] and knowledge[{vaultId,displayName,activeInDesktop,available,readGranted,writeGranted,ingestGranted}], plus authorizationMode. Read-ungranted entries and all filesystem paths are omitted. Offline saved targets retain their identity and available=false. An unavailable target never falls back to the active/default target. Scope-selection implementation is also advertised by /v1/capabilities and /v1/services, but the per-device library catalog is the selection gate.

## Immutable request scope

Every selected request sends X-LuckyRay-Material-Library and/or X-LuckyRay-Knowledge-Vault. IDs are opaque, not paths. Preserve the original IDs with queued writes, uploads, retries, media URLs and range requests. Never obtain an old operation's target from the current UI selection.

The server creates a request-local context with frozen native MaterialCatalog and KnowledgeService views. Gateway control locks, permission store, device connection registry and journals remain shared. No desktop active library or vault is switched. No header preserves the existing contract: legacy material catalog (not desktop active library), and current desktop vault.

A knowledge header must agree with vault query values, registered-vault route IDs, JSON vaultId and nested target.vaultId. Disagreement is 409 SCOPE_MISMATCH. Invalid scope ID is 400 SCOPE_INVALID; missing, offline, removed or identity-changed selected target is 409 SCOPE_UNAVAILABLE. Existing route-level errors remain valid where reached without a header.

Use the same selection headers on /v1/services to discover effective operations for the selected target. Do not gate a selected target with a catalog fetched for another/default target. /v1/vaults and /v1/services/knowledge/vaults return the selected scope when its header is present.

## Writes, transfers, cursors and revocation

Material list/navigation/detail/favorites/tags/folders/file/thumbnail, Services metadata/remove-record, search, changes, hints and ingest use the selected native catalog. Raw SQL material mutations and favorites use its existing temporary namespace views inside their database transaction. Knowledge note CRUD/move, resources, attachment transport, editing leases, relations, changes and ingestion use the frozen saved-vault authority.

Material ingest manifests persist target.libraryId when a material header was selected. Status/chunk/complete/cancel must use that original selection. Old no-header jobs remain no-header jobs. Knowledge manifests already bind target.vaultId. Same opId is still unique in its existing device/operation namespace to preserve old durable receipts: changing its library, vault or payload returns 409 OP_ID_REUSED (or SCOPE_MISMATCH for a stored job), never an unrelated success or a second operation. Clients should generate globally unique opIds and retain original target identity.

Search snapshots, material changes cursors and combined knowledge/material relation cursors include selected scope. A cursor from another scope is rejected/reset, not used to reveal earlier content. Event hints filter material history membership and exact upload targets before limits. Hints are wake-ups only; authoritative fetch remains required.

Mutation/ACK boundaries and bounded response/chunk/event handoffs serialize against the shared permission/control transition. Reads revalidate live registry membership and root identity; streaming rechecks revocation each chunk. Closing a service or revoking a device does not wait for an entire download to finish.

## Explicit desktop consent

The desktop pairing UI offers Trust this phone (recommended) and Manual authorization. QR issuance requires the user's explicit confirmation. Only desktop-owned pairing tickets carry that policy; the phone cannot choose trust in /v1/pair. Missing old policy rows are never upgraded. Existing paired devices may explicitly choose a mode in desktop settings without re-pairing.

Trusted policy covers current and future saved material libraries and knowledge vaults for implemented reading/writing/ingest/desktop-open services, plus LSH. Per-device service off-switches remain authoritative; policy changes never revive a previous Trusted deny accidentally. Manual mode permits exact saved scopes only. A manual exact-scope reenable does not authorize another scope or erase a retained global Trusted deny. Manual and Trusted LSH access remain revocable immediately.

Saved Knowledge locations migrate only from the exact existing desktop saved-vault list; there is no filesystem scan. A native, main-window-only command validates saved registrations and captures existing root identity. Offline/unverifiable entries remain unavailable until explicitly opened in the desktop. Newly opened vaults are registered natively for future selection.

## Explicit boundary

Existing presentation.open can only navigate the currently active desktop target for that domain. A selected nonactive target returns 503 PRESENTATION_SCOPE_NOT_ACTIVE rather than switching desktop state or acknowledging the wrong UI. Operation discovery reports temporarilyUnavailable when neither selected authorized domain can be presented. Independent phone browsing/writing remains available. Generic runs/stop, material restore, capture compatibility and collection behavior are not added or advertised by this change.
