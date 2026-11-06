# LuckyRay 1.9.10 source identity

## Exact release inputs

- [Application source and player materials](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/LuckyRay-1.9.10-source.zip), 157,353,006 bytes.
- SHA-256: `8abc9578b6699bcfbb53549081c614774994fde2619187ba3b7c496a6a1679f0`.
- Release build source identity: `5a1b2d4f74fd205e1b3af69a2120d24c2b819259`.
- [Office corresponding source](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/LuckyRay-1.9.10-Office-corresponding-source.zip), SHA-256 `c04916975649f3ffe856fdba466e201813184f6e1471c660f2f9807a57666e64`.
- [Published checksums](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/SHA256SUMS) and [distribution notes](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/DISTRIBUTION.zh-CN.md).

## Public-tree projection

The application export contains 3,390 product/source entries and 43 additional player
runtime/source-material files. The public tree imports 3,388 of those entries and
excludes two generated sidecar identity receipts under `src-tauri/binaries/`; fresh
builds must produce their own receipts. It adds eight retained public test/helper files.
The repository does not import
private Git history, user data, credentials, installation receipts or screenshots.
The 43 staged files under `src-tauri/native-video/` remain downloadable in the named
release ZIP. Their licenses, source index, build recipe and relinking instructions
remain tracked under `third_party/native-video/lgpl-build-20261106/`.

Public-only differences are deliberate and reviewable:

- Public repository history, root licenses, SDK, documentation and workflows are retained.
- Eight public build/updater test and helper files are retained; the expected sealed
  runtime package count is updated to the verified 593 packages for this release.
- Private historical review links are removed from one old admission note. A signing
  preflight test uses an explicitly synthetic review namespace in its temporary fixture;
  the production signing policy is unchanged.
- Public CI gains strict, pinned player-material staging before the existing media,
  LSH and native checks. Public source checks require 1.9.10 and prohibit tracked
  native runtime staging. Product integrity checks are not bypassed.

The existing `v1.9.10` tag is unchanged and still points to the older public tree.
Therefore GitHub's automatic **Source code (zip/tar.gz)** attachments do not provide
this release's corresponding source. Use the **named application-source asset** above.
The current branch is a public projection and has its own commit identity.

## Licenses and limits

LuckyRay-owned code remains MIT. Third-party components keep their original licenses;
they are not relicensed as MIT. Preserve the source and license materials when
redistributing. Rebuilding or relinking LGPL components does not require the official
update-signing private key. See `RELINK.zh-CN.md` beside the player build recipe.

The Office package contains the fixed Core, wrapper source, full patches, pinned
native/Rust dependencies and editable font sources. Upstream did not provide a final
link map or complete build configuration for this binary. The package is a conservative
corresponding-source set, not a claim of proven per-component linking or byte-for-byte
reproduction. Recompilation of Office and fonts has not been established here.

HEVC, H.264 and AAC patent matters are **not assessed**. Source licenses are not patent
authorization. Historical component metadata records its original review scope; this
repository sync does not change those approval flags or establish new legal clearance.
Windows Authenticode remains unsigned; updater signature verification is separate.
