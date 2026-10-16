# LuckyRay media engine

This directory pins the source identity of LuckyRay's optional video resolver.
The runtime itself is generated into the ignored `src-tauri/media-engine`
directory by `scripts/prepare-media-engine.ps1`; wheels, archives, executables,
caches and user configuration are never committed.

The product uses the PyPI wheel of yt-dlp rather than its PyInstaller Windows
executable. The wheel is Unlicense; the separate yt-dlp-ejs wheel contains MIT
and ISC components. Deno is MIT. FFmpeg is the BtbN `lgpl-shared` variant and
must report neither `--enable-gpl` nor `--enable-nonfree` before it is accepted.

Runtime auto-update, yt-dlp plugins, remote EJS components, inherited proxy
configuration and DRM bypass are disabled. The first site pack is limited to
YouTube, Bilibili, X/Twitter and Pinterest URLs. The browser extension may, only
after the user grants that site's optional browser permission, attach a bounded
per-transfer Netscape cookie file plus the exact page Referer and bounded
browser User-Agent. They are consumed only by the owned resolver process; the
cookie file is created inside the task staging root, never becomes resolver
configuration, and is removed with the task. PO Token providers are not
bundled. Website changes, authentication, regional
restrictions and DRM can still make an item unavailable; recording remains a
user-visible fallback.

The browser extension remains responsible for binding a request to the hovered
player. Public media is attempted without cookie permission. When a supported
page exposes separate full video and audio tracks, the parent validates both
against the page-specific CDN allowlist and the runner downloads them with
bounded, proxy-free requests before an app-owned LGPL FFmpeg atomically merges
them. Signed media URLs stay out of the FFmpeg command line. This resolver also
replaces the narrow direct/HLS downloader after the normal LuckyRay safety path
determines that a manifest needs a richer resolver.
