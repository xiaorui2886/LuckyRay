# Companion Services V1 — canonical Desktop bundle

Authority: Desktop #172/#213 shared assembly. Mobile copies this **entire directory byte-for-byte** to `shared/companion-services-v1/` and verifies `SHA256SUMS.json`. It must not reauthor wire DTOs. Additive contract revision: `2026-09-30.1`, minor 2 (see ADR-0002 through ADR-0005). A sealed contract and synthetic test are not production UI, APK or LAN acceptance. Existing Content revision `2026-09-21.1` and every byte of that bundle are unchanged.

Run from this directory with installed Node.js 24 (no project dependencies, credentials or profile):

```sh
node verify.mjs
node verify-http.mjs
node fixture-server.mjs --port 0
```

The fixture server binds only `127.0.0.1`; it prints a random ephemeral port. It accepts the fixed **test-only** bearers `fixture-device-a`, `fixture-device-read` and `fixture-device-revoked`, has deterministic seeded assets/notes/vaults, and can be stopped with Ctrl+C. Its fixture-only `POST /__fixture/control` accepts `Bearer fixture-control-test-only` for `reconnect`, `revoke` (device-a), `busy`, `cursor-floor`, `expire-search`, or bounded `advance-editing` scenarios; it is never part of the production Gateway. It never reads the Desktop database or invokes DSH. `verify.mjs` runs golden/negative and fixture scenarios offline without opening a listener, including `verify-knowledge.mjs` for the seven additive operations. `verify-http.mjs` starts and stops its own fixture process for wire tests. `python verify-schema.py` additionally checks JSON Schema 2020-12 when the already-installed `jsonschema` module is available, resolving frozen Content references through an offline registry, never the network; no installation is part of this bundle.

`operations.json` is the normative method/path/capability/grant/scope map; `routes.md` explains its compatibility rules. `schema.json` and `types.ts` describe the same **new** objects. This fixture models the **new** Services routes and the existing LSH state/session decision only; legacy Content V1 handlers are tested using the separate unchanged `../content-v1/golden.json`, `../content-v1/schema.json` and `python ../content-v1/verify.py`, plus final native production regression. A fixture 404 on a legacy Content path is not evidence that production removed it. Old Content V1 DTOs are imported from that existing bundle, not duplicated or widened. All error bodies are bounded `{ "code": "..." }`; the detailed vocabulary is in `errors.json`.

For the digest, sort every regular file in this directory by its forward-slash relative path, excluding **only** `SHA256SUMS.json`. Hash each file's raw bytes with SHA-256. `SHA256SUMS.json.files` contains those hex hashes; `bundleDigest` is SHA-256 of UTF-8 lines `<path>\0<lowercase-hex>\n` in that same sorted order. The digest excludes the checksum file itself, so no self-reference exists. `verify.mjs` recalculates the set and digest and rejects missing, extra or changed files. When the contract changes after Mobile consumption, publish a new revision, digest and compatibility note; never rewrite this revision silently.

New discovery must be authenticated. `GET /v1/services` operation state is per device, operation and scope. Client-side cached discovery is display advice, not authorization; server checks each request. Existing `/v1/capabilities`, Content V1 requests/responses and `/v1/events` remain byte-compatible. No real device receives new grants merely because this bundle exists.
