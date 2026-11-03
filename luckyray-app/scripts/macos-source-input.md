# Existing FFmpeg source input for an internal Mac build

This build input is separate from product credentials and installed application
resources. The importer remains offline and does not download, extract or
execute an input archive.

The only production input is `ffmpeg-9.0.1.tar.xz`, 12,036,420 bytes, SHA-256
`cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635`.
The frozen upstream URL is
`https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz`.
[Debian's official source acceptance record](https://tracker.debian.org/news/1786825/accepted-ffmpeg-7901-1-source-into-experimental/)
independently records that size and digest for `ffmpeg_9.0.1.orig.tar.xz`.
This metadata is not a supplied archive or a verified upstream PGP signature.
Keep any obtained upstream signature, trusted key provenance and actual
verification result with the build-input evidence. The importer always reports
that it has not performed PGP verification.

After the existing native, repository, exact-HEAD and disposable-worktree checks,
the internal GitHub workflow makes one request to the fixed official HTTPS URL
in the same disposable Runner job. The fetch retains the Runner's inherited
proxy and TLS trust settings, refuses an existing curl configuration file rather
than bypassing it, refuses TLS key logging, does not follow redirects or retry, and fails on denial,
timeout, unexpected status, excess bytes, size mismatch or digest mismatch.
It keeps response bytes private and stages them only after successful checks.
This is a new request for the pinned upstream bytes, not a transfer from Library.
Actual access remains subject to the Runner's network policy.

The workflow stages a regular, single-link file at this fixed path **inside the
same disposable Runner worktree**:

```text
luckyray-app/src-tauri/.macos-build/source-input/ffmpeg-9.0.1.tar.xz
```

The source and parent directories must belong to the build user and must not be
writable by another user. No symlink parent or file, hardlink, alternate byte
pin, URL, executable or credential override is accepted. The internal worker
imports an existing staged file before its unchanged source-presence gate. An
operator can also run `node scripts/import-macos-app-source.mjs` from the app
directory; it accepts no path, URL or hash arguments.

The importer retains directory/file descriptors, checks named objects and full
bytes, and publishes with no-follow/O_EXCL at `.macos-build/cache/<SHA-256>`.
Existing valid bytes are verified and reused; conflicts and partial objects are
kept without overwriting, deleting or changing permissions. The real builder
still rechecks the hash, extracts only allowed source objects and retains the
original license texts and source archive.

The fetch stage creates the input exclusively at mode 0600, verifies the same
open and named object and its parents after writing, and leaves any conflict or
partial object untouched. The importer then applies its existing checks and
publishes or verifies the digest-addressed cache. A failed fetch or stage stops
the workflow; it never reports success or switches sources. Neither source nor
cache is uploaded by the workflow: the disposable GitHub-hosted Runner is
discarded after the job. Do not commit archives or credentials to the source
repository. An incomplete distribution-source index continues to block
packaging; successful import does not qualify an installer for release.
