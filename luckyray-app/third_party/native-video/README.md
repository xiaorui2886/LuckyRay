# Native video runtime — local development only

LuckyRay uses libmpv's separate DLL through its public client API. No upstream
source modification is made by the client integration. The pinned artifact comes
directly from the identified upstream Windows build, not a LuckyRay mirror.
The mpv build log and runtime configuration both report `gpl=false`; the embedded
FFmpeg configure log reports LGPL version 3 or later. These are configuration
observations, **not a completed license/dependency audit**.

The upstream archive does not contain a complete notices/source bundle. Exact
transitive source revisions have not been recovered from its job summary. The
build also statically incorporates dependencies, so mpv's top-level Copyright
file alone would not close redistribution obligations. See manifest.json for
the exact artifact hashes, build identities and remaining release gates.

This runtime may be prepared locally from an already downloaded upstream
artifact for development and internal verification. It is never committed,
automatically downloaded at application runtime, uploaded as a LuckyRay asset,
or included in Tauri's release resource list. The build rejects a non-debug
build when this local-development runtime is staged. Do not remove that gate
or call this runtime ready for redistribution until the listed gates are closed.

Software-license fees are not required merely to use/modify these LGPL
components commercially under their license terms. Codec patent rights are a
separate question: H.264/HEVC/AAC commercial distribution is not promised to be
royalty-free. No licenses have been bought and no commercial release is approved.

Primary license references:

- https://github.com/mpv-player/mpv/blob/3186d369f9f090cd1363be0ac46a037824b702c6/Copyright
- https://ffmpeg.org/legal.html
- https://www.gnu.org/licenses/lgpl-3.0.html
- https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

The application-facing capability remains local video only: catalog/library/
revision-bound source, no arbitrary mpv commands, scripts, configuration,
network streams or sidecar subtitle discovery. Original media is not modified.
The exact two HEVC user samples and an H.264 fixture have been decoded in an
isolated engineering window. This is not a guarantee of every container/codec,
nor acceptance of the production application's complete native composition.
