# Explicit material library consumer, version 1

This host transport module is separate from the isolated plugin `LuckyRay.call` API. It uses an already verified native/local transport supplied by the caller. It does not obtain credentials, register libraries, or turn a library listing into read/file permission. Domain fixtures are proposals until the common host registration/capability bundle is published by the shared owner.

Load `material-library-consumer.js` as a classic script (Collector service workers can use `importScripts`). It exposes `LuckyRayMaterialLibraries.create(request)`, where `request(method,path,body)` returns the successful, unwrapped JSON body or throws the transport/service error. Include `material-library-consumer.d.ts` for host TypeScript tooling.

```js
const materials = LuckyRayMaterialLibraries.create(verifiedJsonRequest);
const registry = await materials.libraries();
materials.select(chosenLibraryId);
const taxonomy = await materials.taxonomy("popup:taxonomy-uuid");
const operation = materials.prepareCapture({
  requestId: "popup:capture-uuid", name: "Screenshot.png", mimeType: "image/png",
  bytesBase64: pngBase64, targetFolderId: chosenFolderId, tagNames: ["Reference"],
  sourcePageUrl: "https://example.test/article", sourcePageKind: "capture-page"
});
const { receipt, current } = await materials.save(operation);
```

Each `select` increments an epoch, including A -> B -> A. Late taxonomy/query/detail successes and errors reject with `consumer-stale-result`. A capture operation freezes its original library and entire payload; UI switching cannot change its destination. After an uncertain network result, preserve that operation and first inspect the host's original operation record and target; do not automatically or blindly retry, create a new request ID, or change the body. Only an explicit human recovery decision using an available, verified host receipt-check path may reuse the exact original request ID, complete body and verified principal; this is not permission to reexecute an uncertain write. `current:false` means the save belongs to a previous selection and must not replace the current panel's state. Save errors also carry the original `libraryId`, `requestId`, and `current` flag. The client does not automatically retry or fall back to old default-library endpoints.

The classic wrapper repackages errors and does not preserve arbitrary `details`. The verified transport must retain and evaluate unknown-outcome markers before wrapping; missing details afterwards are never proof of zero writes. See [COMPATIBILITY.md](./COMPATIBILITY.md) for the precise unknown-marker precedence and first-attempt rejection boundary.

The host binds authorization and durable receipt identity to its verified principal, route, request ID and complete payload (including library ID). Reusing an ID with another target or payload returns `request-id-conflict`. An interrupted intent returns `capture-commit-uncertain` and never silently reexecutes. Authorization and availability are rechecked before reading a cached result; a live host admission guard is held through new writes. Old catalog grants apply only to the persisted legacy library.

Capture input: required `libraryId`, `requestId`, `name`, `mimeType`, `bytesBase64`; optional `targetFolderId` (`folderId` alias), `newFolderName`, `tagIds`, `tagNames`, `description`, `sourcePageUrl`, `sourcePageTitle`, `sourcePageKind`. Strict fields. PNG <=12MiB, <=40M pixels, <=32767 per side; UTF-8 .md/.txt also supported. Up to32 tags, request IDs <=128 ASCII bytes using letters/digits/-/_/:. Filename has no path. Foreign folder/tag IDs fail before writes. Duplicate content preserves the existing target's manual metadata and organization. Imports and post-import organization use the existing Catalog transactions (`atomic:false`); a committed asset with an organization warning must be checked, not blindly imported again.

Only minimal library descriptions and material metadata are returned, never managed roots, original paths or thumbnail file URLs. Enumeration has no file authorization. Offline/removed libraries fail without recreating an empty root. Vault-only attachment projections stay private. Collector has no original-file route. A `view.available:false` receipt explicitly means the common explicit-library view connection is not installed.

The additive isolated plugin methods `materials.library.list/read` require the existing materials.read package permission plus a host-confirmed, frozen library AND selected object scope. Their domain adapter is bounded to at most32 selected assets; listing is not whole-library access. The old `materials.list/read` methods keep their legacy behavior. The common broker/Scope/event registration is a separate precise handoff, not installed merely by importing this transport helper.
