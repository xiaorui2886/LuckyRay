# Production Note surface and scoped runtime

`NoteDocumentSurface` is the extracted production document pane. Main's `NotesPage` still owns its existing vault-session, draft, CAS, attachment, dialog and layout handlers; its default index remains open. `NotePreview`, `EditorAutocomplete`, `InsertReferencePicker` and `sourceNoteEditor` are the same shared presentation and pure editor implementations.

`ScopedNoteDocumentSurface` uses that surface without mounting `NotesPage`, App, a LuckyRay bridge, a knowledge singleton or another application/LSH instance. This is an integration boundary, not a declaration of completed native parity.

## Host contract

- Obtain backend-validated `{vaultId, sourceId, documentId}`. `sourceId` is the vault incarnation and `documentId` is the actual note identity, never a view id. Never synthesize authority from a title or current active vault.
- Create one stable `NoteRuntime` per native view grant. Use one `NoteDocumentControllers` registry per host and `registry.get(runtime)` per actual authority.
- Mount `ScopedNoteDocumentSurface` with **both** `controller` and that view's `runtime`, a stable `viewId`, `title`, `visible`, `onFocus`, and `onRevisionReady`. The surface owns `attachView`; the host must not attach the same id a second time. Pass full explicitly scoped panels through `panels.index` and `panels.attachments` where available. The detached index starts collapsed.
- The owner shares content/CAS only. Each view retains its own CodeMirror history, selection, folds, scroll, source selection and mode. Per-view metadata/actions/media use the originating grant. Shared CAS chooses a remaining live grant when another duplicate view closes. `get(runtime)` does not silently swap another view's grant.
- Before quit, detach, transfer or destructive layout change, await `registry.flushAll()`. This includes inactive document owners and blocks while any view has an IME composition or an unresolved dirty conflict. Do not discard a failed owner. Invalidation events call `controller.session.refresh()`; never supply cross-authority content directly.
- Readiness is acknowledged only for a clean rendered revision with exact-revision metadata, complete attachment-provider coverage, every explicitly installed parent-action capability, and both full scoped panel renderers. Unsupported/missing metadata is visible and does not mark the view ready.

## Required services

The authoritative DTOs are in `NoteRuntime.ts`.

- `documents.read/write` return the exact authority, body and committed revision. Every write carries its expected CAS revision. A failed or mismatched response keeps the draft.
- `metadata.read(revision)` returns a matching authority/revision and bounded metadata, with explicit completeness. Linked/backlinked note suggestions are not all-vault suggestions. Foreign note bodies and paths are stripped; navigation requires verified opaque target tickets. The surface shows its bounded vocabulary and reports missing/truncated service data. All-vault title query and cross-note anchor completion require separate host integration.
- `attachments.resolve(references, committedRevision)` may return only parent-baseline-authorized opaque tokens for the exact references and syntax. `mediaUrl` converts only those tokens to the `workspace-attachment` scheme. No `asset://` fallback, original file path or general filesystem read is available. Tokens refresh every five minutes. Child-authored references do not expand the baseline.
- `actions.request` accepts a finite typed action and echoes the request, view, authority, revision and draft generation. The backend must validate the source/revision and target before effects. UI reply guards additionally reject changes to text, grant, lease, mode or caret. A proposed replacement is applied as an editor transaction through the owner, never a second writer. A rename needs a new validated host grant; it does not silently redirect child writes.

## Remaining integration capabilities

Full native parity still requires validated parent implementations for rename/regrant, create/open navigation, tags/favorites, AI result delivery, file/clipboard/material insertion, import/export and vault/attachment browsing, plus the full scoped index/attachment panels. Browser `File[]` is not an arbitrary native path authorization. Composer-only AI staging is an acknowledged action, not a generated suggestion. Missing operations must return typed `unsupported`; installing Main services in the child is not a fallback.

Main behavior and fail-closed runtime paths have focused contracts. Native runtime, browser interactions and Rust compilation still need supported host validation; source/Node checks are not substitutes for that verification.
