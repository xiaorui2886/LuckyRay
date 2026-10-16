# Candidate distribution notice supplement

This supplement is bundled with the next immutable Windows update-test pair.
It supplements, not replaces, the original license/NOTICE files in the installed
components and the applicable public runtime/desktop source-material archives.
LuckyRay-owned source uses MIT; third-party code retains its own terms.

## Deno2.9.4 and V8

`deno-2.9.4/INDEX.json` records the exact official Deno2.9.4 source commit,
locked crate archive checksums and906 conservatively reachable non-development
Windows CLI dependencies, including build dependencies. This is not a claim
that every listed build dependency is linked into the executable. Original
distributed license/NOTICE bodies are retained byte-for-byte in `bodies/`.

Some original crate archives do not ship a standalone license file. For those,
the index explicitly identifies the exact published manifest license grant,
original available copyright/SPDX lines, author attribution and standardized
license-version text from the pinned SPDX license-list-data release. These are
not falsely described as an original file, nor copied from a different package
release. Existing notices are not overwritten and copyright holders are not
invented. For alternative permissive grants the selected license is explicit.

`NATIVE-INDEX.json` supplies V8's original BSD notice, its additional original
notices, exact-revision native submodule texts, and the actual Temporal GN Rust
dependency closure. The official Chromium GitHub mirror's Rust subtree is
verified identical to the split repository's tree at its GitOrigin-RevId.
Conditional target branches are conservatively retained. Build-tool notices
are included without asserting those tools ship as runtime code.

MPL-2.0 components remain MPL-2.0. Each exact original unmodified source archive
can be obtained from its versioned crates.io download URL and verified against
the recorded Cargo.lock checksum; this supplies the corresponding source form.
No proprietary/user content is part of those public archives.

## SeaHash4.1.0

`seahash-4.1.0/LICENSE` is the original MIT text from the license-only direct
successor of the exact4.1.0 crate VCS commit. `PROVENANCE.json` proves the parent,
unchanged4.1.0 version and sole LICENSE-file addition. No other version's text
or invented copyright year/holder is substituted.

## Other unchanged components

`desktop-rust-additions/` retains previously reviewed original license files
for exact desktop crate versions. Existing media, Node, LSH and font evidence
is reused only for unchanged inputs. The public release must retain the linked
runtime and desktop source-material archives, including the applicable FFmpeg
GPL scope, corresponding source and build/relink materials. This supplement
does not relabel those components as MIT or LGPL-only.

Every supplied body is hash-addressed in the corresponding index. These files
are distribution/legal notices, not internal test reports or a formal release
acceptance claim.
