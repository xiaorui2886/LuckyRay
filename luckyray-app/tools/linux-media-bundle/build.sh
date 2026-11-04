#!/usr/bin/env bash
# Reproducible LGPL Linux media bundle: FFmpeg + ffprobe + libmpv.
# Usage: build.sh <work-dir> <out-dir>
# - Sources are fetched from the pinned URLs in sources.json (or taken from
#   $LUCKYRAY_MEDIA_SOURCE_CACHE) and must match size + sha256 exactly.
# - FFmpeg is configured without --enable-gpl/--enable-nonfree/--enable-version3
#   and with --disable-autodetect, so only explicitly listed (LGPL-compatible)
#   system libraries can be linked. The configure output is checked, not trusted.
# - FFmpeg and libplacebo are linked statically into libmpv.so.2 (as the
#   Windows v1.9.9 libmpv does), so the app's verified dlopen of one pinned file
#   needs no side-loaded libav*; ffmpeg/ffprobe are separate static-libav tools.
# - libmpv is built with -Dgpl=false and auto features disabled.
# System build deps (headers) are installed by the caller (CI runner apt pins).
set -euo pipefail
umask 022
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(realpath -m "${1:?work dir}")"
out="$(realpath -m "${2:?out dir}")"
jobs="${JOBS:-$(nproc)}"
audio="${LUCKYRAY_MEDIA_AUDIO:-pulse,alsa}"
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790000000}"
[ ! -e "$out" ] || { echo "out dir must not exist: $out" >&2; exit 2; }
mkdir -p "$work/src" "$work/dl" "$work/prefix"
prefix="$work/prefix"

python3 "$here/bundle.py" fetch "$here/sources.json" "$work/dl" "${LUCKYRAY_MEDIA_SOURCE_CACHE:-}"
for name in ffmpeg-9.0.1.tar.xz lua-5.2.4.tar.gz libplacebo-v7.360.1.tar.gz mpv-3186d369f9f090cd1363be0ac46a037824b702c6.tar.gz; do
  rm -rf "$work/src/${name%%.tar.*}"
  mkdir -p "$work/src/${name%%.tar.*}"
  tar -xf "$work/dl/$name" -C "$work/src/${name%%.tar.*}" --strip-components=1 --no-same-owner
done
rm -rf "$work/src/libplacebo-v7.360.1/3rdparty/Vulkan-Headers"
mkdir -p "$work/src/libplacebo-v7.360.1/3rdparty/Vulkan-Headers"
tar -xf "$work/dl/Vulkan-Headers-1.4.309.tar.gz" -C "$work/src/libplacebo-v7.360.1/3rdparty/Vulkan-Headers" --strip-components=1 --no-same-owner

# meson >= 1.3 (mpv) straight from the pinned, hash-verified wheel (no pip/venv);
# the runner's pinned python3-jinja2 stays visible for libplacebo.
rm -rf "$work/meson" && mkdir -p "$work/meson"
python3 -m zipfile -e "$work/dl/meson-1.5.2-py3-none-any.whl" "$work/meson"
printf '#!/bin/sh\nPYTHONPATH="%s${PYTHONPATH:+:$PYTHONPATH}" exec python3 -m mesonbuild.mesonmain "$@"\n' "$work/meson" >"$work/meson/meson"
chmod 0755 "$work/meson/meson"
meson="$work/meson/meson"
"$meson" --version
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# --- FFmpeg (static, PIC, LGPL) ---------------------------------------------
cd "$work/src/ffmpeg-9.0.1"
./configure --prefix="$prefix" --enable-static --disable-shared --enable-pic \
  --disable-autodetect --enable-zlib --enable-pthreads \
  --disable-doc --disable-debug --disable-ffplay --enable-ffmpeg --enable-ffprobe \
  --disable-network --disable-devices --disable-indevs --disable-outdevs --enable-indev=lavfi \
  --extra-ldflags=-Wl,--build-id=none ${LUCKYRAY_FFMPEG_EXTRA:-} | tee "$work/ffmpeg-configure.log"
grep -qx "License: LGPL version 2.1 or later" "$work/ffmpeg-configure.log"
make -j"$jobs" >"$work/ffmpeg-make.log"
make install >"$work/ffmpeg-install.log"
"$prefix/bin/ffmpeg" -hide_banner -buildconf | tee "$work/ffmpeg-buildconf.txt" >/dev/null
! grep -Eq -- "--enable-(gpl|nonfree|version3)" "$work/ffmpeg-buildconf.txt"

# --- Lua 5.2 (static, PIC; MIT) for mpv's built-in scripting options -------
make -C "$work/src/lua-5.2.4/src" -j"$jobs" liblua.a SYSCFLAGS="-DLUA_USE_POSIX -fPIC" >"$work/lua-make.log"
install -d "$prefix/include/lua5.2" "$prefix/lib/pkgconfig"
install -m 0644 "$work/src/lua-5.2.4/src/"{lua.h,luaconf.h,lualib.h,lauxlib.h} "$prefix/include/lua5.2/"
install -m 0644 "$work/src/lua-5.2.4/src/liblua.a" "$prefix/lib/liblua5.2.a"
printf '%s\n' "Name: lua5.2" "Description: pinned static Lua" "Version: 5.2.4" \
  "Libs: -L$prefix/lib -llua5.2 -lm" "Cflags: -I$prefix/include/lua5.2" >"$prefix/lib/pkgconfig/lua5.2.pc"

# --- libplacebo (static, no GPU backends; software render only needs its core)
cd "$work/src/libplacebo-v7.360.1"
"$meson" setup build --prefix="$prefix" --libdir=lib --buildtype=release \
  -Ddefault_library=static -Dauto_features=disabled -Dvulkan=disabled -Dopengl=disabled \
  -Dd3d11=disabled -Dshaderc=disabled -Dglslang=disabled -Dlcms=disabled -Ddovi=disabled \
  -Dlibdovi=disabled -Dunwind=disabled -Dxxhash=disabled -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
"$meson" install -C build >"$work/libplacebo-install.log"

# --- libmpv (shared, -Dgpl=false) --------------------------------------------
cd "$work/src/mpv-3186d369f9f090cd1363be0ac46a037824b702c6"
audio_opts=()
for a in pulse alsa; do
  if [[ ",$audio," == *",$a,"* ]]; then audio_opts+=("-D$a=enabled"); else audio_opts+=("-D$a=disabled"); fi
done
"$meson" setup build --prefix="$prefix" --libdir=lib --buildtype=release -Db_ndebug=true \
  -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dauto_features=disabled \
  -Dgl=disabled -Dvulkan=disabled -Dlua=lua5.2 -Diconv=enabled -Dzlib=enabled "${audio_opts[@]}" \
  -Dc_link_args="-Wl,--build-id=none -Wl,-Bsymbolic -Wl,--exclude-libs,ALL -Wl,--push-state,--no-as-needed -l:libstdc++.a -Wl,--pop-state" | tee "$work/mpv-configure.log"
python3 - "$PWD/build" <<'PY'
import json, sys
opts = {o["name"]: o["value"] for o in json.load(open(sys.argv[1] + "/meson-info/intro-buildoptions.json"))}
assert opts["gpl"] is False and opts["libmpv"] is True, (opts["gpl"], opts["libmpv"])
PY
"$meson" compile -C build -j "$jobs" >"$work/mpv-build.log"
"$meson" install -C build >"$work/mpv-install.log"

# --- assemble ----------------------------------------------------------------
stage="$work/stage"
rm -rf "$stage"
mkdir -p "$stage/native-video" "$stage/media-engine/ffmpeg" "$stage/licenses"
install -m 0755 "$(readlink -f "$prefix/lib/libmpv.so.2")" "$stage/native-video/libmpv.so.2"
install -m 0755 "$prefix/bin/ffmpeg" "$prefix/bin/ffprobe" "$stage/media-engine/ffmpeg/"
strip --strip-unneeded "$stage/native-video/libmpv.so.2" "$stage/media-engine/ffmpeg/ffmpeg" "$stage/media-engine/ffmpeg/ffprobe"
# Every symbol must resolve on its own (RTLD_NOW), and the options the app's
# hardened init sets must exist in this build.
python3 - "$stage/native-video/libmpv.so.2" <<'PY'
import ctypes, os, sys
lib = ctypes.CDLL(sys.argv[1], mode=os.RTLD_NOW | os.RTLD_LOCAL)
lib.mpv_create.restype = ctypes.c_void_p
handle = ctypes.c_void_p(lib.mpv_create())
for key in ("config", "load-scripts", "ytdl", "osc", "input-default-bindings", "vo", "ao", "hwdec",
            "access-references", "keep-open", "idle", "pause", "mute", "terminal", "osd-level"):
    assert lib.mpv_set_option_string(handle, key.encode(), b"no" if key not in ("vo", "ao", "osd-level", "hwdec") else
                                     {"vo": b"null", "ao": b"null", "osd-level": b"0", "hwdec": b"no"}[key]) >= 0, key
lib.mpv_terminate_destroy(handle)
PY
cp "$work/ffmpeg-buildconf.txt" "$stage/licenses/ffmpeg-buildconf.txt"
python3 "$here/bundle.py" assemble "$here/sources.json" "$work/src" "$stage"
mv "$stage" "$out"
python3 "$here/bundle.py" verify "$out"
