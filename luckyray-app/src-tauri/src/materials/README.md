# Material Catalog Module

`MaterialCatalog` is the domain Interface for LuckyRay materials. SQLite
`asset` / `folder` / `item_tag` rows are metadata truth, files remain at paths
selected by `storageMode`, and `material_change_state` is the refresh version
truth.

Tauri commands and the existing localhost HTTP routes are transport Adapters.
They may select files or download bytes, but query, folder scope validation,
managed SHA-256 dedupe, linked/source path identity, filesystem cleanup,
database writes, and aggregated change metadata belong to this module.

Managed imports stage a unique file before taking a SQLite `BEGIN IMMEDIATE`
gate. The final duplicate check and insert run while that write lock is held;
the losing import removes its staged file. Linked/source imports use the same
database gate but deduplicate only by normalized path identity. Byte imports
are explicitly managed-only.

Physical file identity is owned by one asset path plus its SHA-256 content hash.
Generic metadata patches cannot rewrite `storageMode`, `originalPath`, or
`libraryPath`; relocate and real-file rename use dedicated Catalog operations
that hold a SQLite `BEGIN IMMEDIATE` gate while rechecking path ownership.

Deleting a managed copy or an explicitly authorized source file first renames
it to a same-filesystem quarantine path and records both an enumerable manifest
under `material-delete-pending` and a database identity journal. Database
failure restores the file before returning an error. After a successful commit,
purge failure is reported as `cleanupPending` and later Catalog construction
retries only when the manifest, journal, asset id, canonical path, storage mode,
and content hash still agree. Linked assets never delete physical files;
record-only deletion remains available for every storage mode.

Browser preview is deliberately a separate localStorage Adapter; it is not a
production persistence source. Network authentication, CORS and request limits
remain outside this module and are reserved for the transport hardening batch.
`storageMode` remains a MaterialsPage presentation filter over the canonical
result set; it is intentionally not advertised as a Catalog query field.

The Rust backend bootstrap owns application-wide schema and migration setup
before the WebView or LocalTransport can use services. The WebView retains only
the one-time import of legacy browser-local data after backend readiness. Notes
export/wiki-embed code still owns cross-domain coordination; this module does
not absorb Notes behavior.
