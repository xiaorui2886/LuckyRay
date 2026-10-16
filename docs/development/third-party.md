# Third-party source and redistribution boundaries

Root MIT covers LuckyRay-owned/licensable code, not third-party files. Retain
original notices. This is an engineering inventory, not legal certification or
codec patent clearance.

| Component | Fixed source/version | License and boundary |
| --- | --- | --- |
| Tauri, React, CodeMirror, Vite, TypeScript | `package.json`, `pnpm-lock.yaml`, `Cargo.lock` | MIT/Apache and each transitive dependency's own terms; public registries. |
| Vendored Tao | `src-tauri/vendor/tao-0.35.3` | Original MIT/Apache-2.0 notices retained, with a local Windows keyboard patch described alongside. |
| D3 | d3-force 3.0.0, frozen closure | ISC; full notices in `public/third-party/graph-d3.txt`. |
| DOM query | 0.27.0 | `third_party/dom-query/LICENSE` and provenance retained. |
| DeepSeek Harness | @deepseek-ai/dsh 0.1.7-rc.2 | MIT, not relabeled. Public npm tarball/closure hashes in `dsh-host/runtime-authority.json`. Git reference is audit-only, not proof of npm/Git equivalence. |
| LSH Node runtime | 22.19.0 Windows x64 | MIT plus bundled notices; archive, executable and license hashes in authority. |
| LibreOffice kit | @deepseek-ai/libreoffice-kit / -win32-x64 0.1.1 | MPL-2.0 and bundled terms; public package includes `sources/` and `licenses/`. Preserve corresponding sources, notices and font terms. |
| sharp/libvips | Exact frozen closure | Apache-2.0 and LGPL-3.0-or-later components; package metadata alone is not a full native license inventory. |
| Fonts | KaTeX in official LSH frontend; OpenSymbol in LibreOffice | Not relabeled as MIT assets. Retain exact upstream MIT/OFL and component-specific font notices; no new font binaries in this source export. |
| Media runtime | Python 3.11.8, yt-dlp 2026.7.4, EJS 0.8.0, Deno 2.9.4 | Python-2.0, Unlicense and bundled MIT/ISC notices; public URLs/hashes in `third_party/media-engine/manifest.json`. |
| FFmpeg | 9.0.1, pinned System233 shared build | Archive LGPL label is insufficient: the included Lensfun filter has GPL-3.0-or-later source. The tool/DLL suite needs GPLv3 corresponding-source scope plus retained LGPL and dependency notices. This does not relabel the independent LuckyRay host. [Upstream filter](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavfilter/vf_lensfun.c), [distribution guidance](https://ffmpeg.org/legal.html). |
| libmpv experiment | Fixed commit/archive in `third_party/native-video/manifest.json` | Redistribution NOT approved. DLL excluded. Existing gate rejects a staged development DLL in non-debug builds; not bypassed. |
| Optional Web MCP | 0.1.1 | Owned connection source is MIT here. Separate public runtime retains Node 24.14.1 MIT, tunnel-client 0.0.16 / cloudflared 2026.8.2 Apache-2.0, SBOM and upstream dependency texts. No hosted account or entitlement supplied. |

## Public acquisition and notices

Required runtime inputs are anonymous public npm, Python, Node or upstream GitHub
downloads with fixed hashes. Never copy a user's runtime/profile/grant into a
checkout. Existing integrity and package layout gates remain mandatory.

`dsh-host/records/THIRD-PARTY-NOTICES.txt` and dependency-audit identify the exact
closure and license hashes. Full texts accompany downloaded upstream packages.
Historical [public release supplements](../../third-party/README.md) remain at
their original locations; they are not automatically applicable to changed bytes.

## Candidate binary gate

Frozen A14/B15 are retained historical inputs, not substituted or overwritten.
The next A16/B17 test pair adds the [exact distribution projection and notice
supplement](distribution-projection.md). Its formal runtime projection excludes
one pinned upstream development CI configuration without modifying official
runtime source; all original sealed-stage checks remain required.

Version-bound Deno/V8 native/transitive notices and the SeaHash4.1.0 original
license omission correction accompany the new pair. Existing source materials
apply only where exact component versions/bytes are verified unchanged.
Missing source/notice materials or new possible secrets still block attachments;
source CI and signature checks do not replace two independent installed chains.
Test-only prereleases must not become Latest or switch a stable update feed.
