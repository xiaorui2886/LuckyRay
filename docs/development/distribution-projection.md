# Update-test candidate distribution inputs

These changes prepare immutable test-only Windows candidates. They do not
publish a stable desktop version or switch the public update feed.

## Exact development metadata exclusion

The existing formal isolated/portable LSH staging projection excludes only the
coverage-service configuration `debug@2.6.9/.coveralls.yml`, after checking its
original SHA-256 `64e6b64f19837a76c30865579aabdde1a825729ae0204ba73ba6de77296ce18e`.
This is not runtime input. No configuration value is disclosed, probed or
assumed harmless. Unexpected bytes fail the projection. Other versions/files,
original copyright notices and runtime entrypoints are unchanged.

The original audit/record generator binds the actual projected closure. Only
that package changes:17 to16 files,46bytes removed. Other515 package records
and the exact lock reconciliation are unchanged. Portable runtime seal:
25658files, SHA-256
`35e43f0fc3b627e74a5b53b14e19dc18f4e2e8c48ffa0e030df0b96eb1a5f98b`.
Reintroducing a file changes the exact sealed tree and fails verification.
Native modules, detached files, resolver graph and offline/no-scripts policies
remain checked. LSH stays0.1.7-rc.2; no official runtime logic is modified.

## Notice supplement

The formal resource contract now requires `third-party-notices/` in the installed
application. Its README and hash-addressed indexes document exact versions,
original sources and scope:

- Deno2.9.4 official commit `14eea3160ae5834476aa3b9d317b8d41d991b982` and its
  locked Windows CLI dependency graph. Original published notices are retained.
  A conservative union includes build dependencies, not a claim every crate is
  linked. Where archives omit a standalone license file, exact original grants,
  available attributions and fixed standardized license-version text are
  explicitly distinguished from original license files.
- V8/rusty_v8 150.2.0 and exact native submodules. Temporal's actual GN references
  cover47targets/46vendor crates. The Chromium mirror subtree is verified equal
  to the split source's tree, not substituted with a newer release.
- SeaHash4.1.0 original MIT text from the license-only direct successor
  `3088c5c912b70b586d27bf553fbe964e025a2c89` of exact crate VCS
  `94b632aeac099031c373599313d5b5f0acbbaec0`, still4.1.0. Only LICENSE was added;
  no copyright year or holder is invented.

Third-party terms remain unchanged. Existing media/runtime corresponding-source
materials remain required where applicable. This supplement does not relabel
FFmpeg's GPL scope, MPL components or other third-party code as LuckyRay MIT.

An informational index-label clarification for wasmparser0.244.0 is supplied
with both frozen candidates: [actual independent MIT alternative](license-index-clarification.md).
Its original grant and full MIT text were already present; the conservatively
included LLVM exception is not an extra condition on that MIT alternative.
Frozen installers and original notices are not edited in place.

## Focused checks

```powershell
cd luckyray-app
node --test tests/distributionNotices.test.mjs tests/dshDistributionMetadata.test.mjs
```

The full production supply-chain gate additionally requires the exact pinned
public Node/pnpm inputs and offline closure, as documented in the source build
guide. A normal unit invocation may skip those fixtures and is not equivalent
to the production gate. Installed updater acceptance is separate: it must
observe save acknowledgement, normal exit, exact installer identity, automatic
reopen and full data/authority preservation in each independent run.
