# Companion Content V1 — 2026-09-12.1

This additive bundle is the content authority. The parent foundation handshake,
pairing identity, TLS certificate pin and credential format remain unchanged.
Mobile vendors this entire directory under `shared/companion-content-v1`.
`SHA256SUMS.json` binds each artifact; both consumers validate the same golden data.

Only registered **current** Knowledge vault is exposed in this version. Browsing
never switches the desktop editor. Other remembered mobile vaults retain drafts
and cached metadata; their queues wait until that vault is current again.

Material metadata uses real page/limit and catalog filters; resources are fetched
on demand. Content reads never reinterpret arbitrary Windows paths. Known links
are resolved through the Knowledge attachment resolver and approved catalog paths.
Range supports one byte range, suffix ranges, 206/416, ETag/If-Range and 304.
Downloads use bounded buffers and app-private resumable staging, not full-file RAM.
Windows read handles exclude in-place mutation while allowing atomic replacement.

Note identity is instance + vault identity + stable note ID. Paths and hashes are
not business IDs. File-object evidence preserves external renames where available;
ambiguous replacement is conservatively observed as deletion and creation.
Initial snapshots use ID keysets plus the initial journal high-water mark. Changes
after that mark are replayed, including tombstones. WSS is only a hint; foreground
polling catches missed events. Journal floor expiry (410) rebuilds clean metadata
while retaining dirty drafts and immutable pending operations. This revision keeps
the journal indefinitely; no automatic retention advances the floor.

Each write has an immutable opId, expectedRevision, and durable pre-write intent.
Existing Knowledge services perform the write with source, revision and dirty
desktop draft guards. Receipt/identity/journal commit together; after interruption,
the pre-write intent and observed file state resolve retries conservatively. The
mobile acknowledgement applies only to its captured draft generation. Conflicts
retain both texts; choosing a local copy creates one durable new-note operation.
Deleting a note retains its before-body in the operation journal. Mobile drafts
also remain available when a remote deletion conflicts.

Attachment publication is scoped by device, vault, note and immutable upload opId.
256 KiB checksummed chunks commit their offsets after fsync. Reopen truncates only
uncommitted staging bytes. Complete verifies 64 MiB maximum, length, SHA-256 and
the note revision, then uses the existing Knowledge attachment publication policy.
Its receipt supplies the real Markdown reference. A new offline note with pending
attachments first creates an empty server shell; its mobile body stays dirty until
all dependencies publish. No private mobile placeholder is sent as note content.
Published orphan attachments and unresolved mobile staging are retained; there is
no automatic deletion of potential user references. Cache cleanup is independent.

Desktop schema 21 and Mobile schema 6 are additive. Old APKs cannot use newer
schemas: downgrade the binary only with a compatible reader or a separate saved
pre-upgrade database. Never reset the upgraded live database to make an old APK
start. Pairing, local inbox/assets/notes and unsynced drafts are not disposable.
Legacy capture/AI sync_run remains gated. No material write or LSH capability is
advertised. Authoring is full-document optimistic concurrency, not CRDT merging.
