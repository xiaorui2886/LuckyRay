# Runtime notices and source offer

Copyright remains with the respective upstream authors. Full notices, copyright
headers and applied changes are retained in sources.tar.xz. No warranty is given.
This runtime is distributed under LGPL-3.0-or-later, electing the later version
permitted by mpv, FFmpeg, libplacebo and FriBidi. This does not relicense Apache,
BSD, ISC, MIT, FTL, Zlib, bzip2 or compiler-runtime material.

| Linked component | Exact identity | Terms / complete notice |
|---|---|---|
| mpv | 3186d369f9f090cd1363be0ac46a037824b702c6 | LGPL-2.1+; GPL-only source units absent from compile commands |
| FFmpeg | 0b01ed76aa6a64e95ec4b87297aaa374a72de34e | LGPL-2.1+; GPL/nonfree/version3 configure switches OFF |
| libplacebo | 7.371.0, full hashed snapshot | LGPL-2.1+ |
| FriBidi | 1.0.16, full hashed snapshot | LGPL-2.1+ |
| libass | full hashed snapshot | ISC |
| HarfBuzz | 14.2.1, full hashed snapshot | Old MIT and per-file notices |
| FreeType | 2.14.3, full hashed snapshot | FreeType License (FTL), BDF/PCF permissive notices |
| LCMS2 | 2.19, full hashed snapshot | MIT; GPL fastfloat/threaded plug-ins NOT built |
| dav1d | 1.5.4, full hashed snapshot | BSD-2-Clause |
| zlib-ng | 2.3.3 in zlib compatibility mode | Zlib and per-file notices |
| bzip2 | 1.1.0 snapshot | bzip2 license |
| Shaderc | 2026.2 snapshot with complete third_party | Apache-2.0 |
| glslang | embedded exact snapshot | Full glslang multi-license notice |
| SPIRV-Tools / SPIRV-Headers | embedded exact snapshots | Apache-2.0 and per-file notices |
| SPIRV-Cross | full hashed snapshot, static C target patch retained | Apache-2.0 / MIT election as marked |
| Vulkan-Headers | full hashed snapshot, headers only | Apache-2.0 and per-file notices |
| Lua | original 5.2.4 source release | MIT |
| MinGW-w64 / winpthreads | v14.0.0, full source archive and toolchain patch recipes | ZPL-2.1 / MIT / BSD / per-file notices |
| GCC runtime / libstdc++ | GCC 16.2.0 | GPL-3.0 with GCC Runtime Library Exception 3.1; eligible compilation using unmodified GCC |

Portions of this software are copyright © 2026 The FreeType Project
(https://freetype.org). All rights reserved.
This software is based in part on the work of the Independent JPEG Group.
Shaderc is Copyright The Shaderc Authors; SPIR-V and Vulkan notices are included
in licenses/ and the full original source headers. No endorsement is implied.

All static media dependencies are inside libmpv-2.dll; the application loads it
dynamically. Import-table inspection found only Windows system DLLs. No x264,
x265, LibreMPEG, fdk-aac or downloaded AGPL runtime is linked or shipped. Built-in
H.264/HEVC/AAC decoders still have separate patent considerations.

The installation includes complete corresponding library sources in
native-video/sources.tar.xz, including build controls, exact patches as applied,
full per-file notices, hashes and toolchain configuration. The same private
Release supplies LuckyRay-1.9.10-source.zip, the complete application code needed
to rebuild/relink this Combined Work. Reverse engineering for debugging changes
to these LGPL components is permitted. See RELINK.zh-CN.md for exact steps.
