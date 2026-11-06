#!/usr/bin/env bash
# Rebuild only from the supplied, hashed source trees. No downloads, models,
# host package installation or access to any LuckyRay profile.
set -euo pipefail
umask 022
jobs=4
src=/build/luckyray-sources
build=/build/luckyray-build
prefix=/build/luckyray-prefix
mkdir -p "$build" "$prefix" /work/result
test -f /work/source-trees.json
if [[ ! -d "$src" ]]; then cp -a /work/sources "$src"; fi
export PATH=/opt/ct-ng/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
export AR=x86_64-w64-mingw32-gcc-ar RANLIB=x86_64-w64-mingw32-gcc-ranlib
export NM=x86_64-w64-mingw32-gcc-nm STRIP=x86_64-w64-mingw32-strip
export CFLAGS="-O2 -pipe -static-libgcc -I$prefix/include"
export CXXFLAGS="-O2 -pipe -static-libgcc -static-libstdc++ -I$prefix/include"
export LDFLAGS="-static-libgcc -static-libstdc++ -L$prefix/lib"
export PKG_CONFIG=pkg-config PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig:$prefix/share/pkgconfig"
export LIBRARY_PATH="$prefix/lib"
export CMAKE_BUILD_PARALLEL_LEVEL=$jobs
# Deliberately exclude the image's precompiled media libraries from all paths.
unset FF_CONFIGURE FF_LIBS FF_CFLAGS FF_CXXFLAGS FF_LDFLAGS FF_LDEXEFLAGS
cat > "$build/cross.meson" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
windres = 'x86_64-w64-mingw32-windres'
pkg-config = 'pkg-config'
[properties]
needs_exe_wrapper = true
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
cat > "$build/cross.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER $CC)
set(CMAKE_CXX_COMPILER $CXX)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
set(CMAKE_FIND_ROOT_PATH $prefix)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
EOF
cm() {
  local name=$1 directory=$2; shift 2
  cmake -S "$directory" -B "$build/$name" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$build/cross.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$build/$name" --parallel "$jobs"
  cmake --install "$build/$name"
}
ms() {
  local name=$1 directory=$2; shift 2
  local reuse=()
  if [[ -f "$build/$name/meson-private/coredata.dat" ]]; then reuse=(--reconfigure); fi
  meson setup "${reuse[@]}" "$build/$name" "$directory" --cross-file "$build/cross.meson" \
    --prefix "$prefix" --libdir lib --buildtype release --default-library static \
    --wrap-mode=nofallback --auto-features=disabled --prefer-static "$@"
  meson compile -C "$build/$name" -j "$jobs"
  meson install -C "$build/$name"
}
stage() { printf '\n[stage] %s %s\n' "$1" "$(date -u +%FT%TZ)"; }
if [[ "${LUCKYRAY_BUILD_RESUME:-}" != lua-mpv ]]; then
stage zlib
cm zlib "$src/zlib" -DZLIB_COMPAT=ON -DBUILD_TESTING=OFF -DWITH_GTEST=OFF
stage bzip2
cm bzip2 "$src/bzip2" -DENABLE_LIB_ONLY=ON -DENABLE_STATIC_LIB=ON \
  -DENABLE_SHARED_LIB=OFF -DENABLE_TESTS=OFF -DENABLE_DOCS=OFF
# This CMake source names the static archive bz2_static; FFmpeg expects -lbz2.
cp "$prefix/lib/libbz2_static.a" "$prefix/lib/libbz2.a"
stage freetype
cm freetype "$src/freetype2" -DFT_DISABLE_ZLIB=OFF -DFT_DISABLE_BZIP2=ON \
  -DFT_DISABLE_PNG=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON
stage fribidi
ms fribidi "$src/fribidi" -Ddocs=false -Dbin=false -Dtests=false
stage harfbuzz
ms harfbuzz "$src/harfbuzz" -Dfreetype=enabled -Dtests=disabled -Dutilities=disabled \
  -Dsubset=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled
stage libass
ms libass "$src/libass" -Ddirectwrite=enabled -Dasm=enabled
stage lcms2
ms lcms2 "$src/lcms2" -Dtests=disabled -Djpeg=disabled -Dtiff=disabled \
  -Dutils=false -Dfastfloat=false -Dthreaded=false
stage glslang
cm glslang "$src/shaderc/third_party/glslang" -DENABLE_OPT=OFF \
  -DBUILD_EXTERNAL=OFF -DGLSLANG_TESTS=OFF -DENABLE_GLSLANG_BINARIES=OFF
stage spirv-cross
cm spirv-cross "$src/spirv-cross" -DSPIRV_CROSS_SHARED=ON -DSPIRV_CROSS_CLI=OFF \
  -DSPIRV_CROSS_ENABLE_TESTS=OFF
stage shaderc
cm shaderc "$src/shaderc" -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
  -DSHADERC_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_EXECUTABLES=ON \
  -DENABLE_OPT=OFF -DBUILD_EXTERNAL=OFF -DSHADERC_ENABLE_WERROR_COMPILE=OFF
# Publish the combined static archive through the dependency name expected by
# mpv/libplacebo. The generated shared DLL is not used or shipped.
cp "$prefix/lib/pkgconfig/shaderc_combined.pc" "$prefix/lib/pkgconfig/shaderc.pc"
stage libplacebo
cm vulkan-headers "$src/vulkan-headers" -DVULKAN_HEADERS_ENABLE_TESTS=OFF
ms libplacebo "$src/libplacebo" -Dd3d11=enabled -Dglslang=disabled -Dshaderc=enabled \
  -Dvulkan-sdk="$prefix" \
  -Dvulkan=disabled -Dopengl=disabled -Dlcms=enabled -Dlibdovi=disabled \
  -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
stage dav1d
ms dav1d "$src/dav1d" -Denable_tools=false -Denable_tests=false
stage ffmpeg
mkdir -p "$build/ffmpeg"
pushd "$build/ffmpeg"
"$src/ffmpeg/configure" --prefix="$prefix" --cross-prefix=x86_64-w64-mingw32- \
  --arch=x86_64 --target-os=mingw32 --cc="$CC" --cxx="$CXX" --ar="$AR" \
  --ranlib="$RANLIB" --nm="$NM" --pkg-config=pkg-config --pkg-config-flags=--static \
  --disable-autodetect --disable-gpl --disable-nonfree --disable-version3 \
  --enable-static --disable-shared --disable-doc --disable-debug \
  --enable-zlib --enable-bzlib --enable-libdav1d --enable-d3d11va --enable-dxva2 \
  --enable-schannel --extra-cflags="$CFLAGS -DBZ2_STATICLIB" --extra-cxxflags="$CXXFLAGS" \
  --extra-ldflags="$LDFLAGS" --extra-libs='-lstdc++ -lpthread'
make -j "$jobs" && make install
popd
fi
stage lua
mkdir -p "$src/lua52" "$build/lua52" "$prefix/include/lua52"
cp -a /work/sources/lua52 "$src/"
pushd "$build/lua52"
for file in "$src/lua52/src"/*.c; do
  case "$(basename "$file")" in lua.c|luac.c|onelua.c|ltests.c) continue;; esac
  "$CC" $CFLAGS -DLUA_USE_WINDOWS -c "$file" -o "$(basename "$file" .c).o"
done
"$AR" rcs "$prefix/lib/liblua52.a" ./*.o
cp "$src/lua52/src"/{lua.h,luaconf.h,lualib.h,lauxlib.h} "$prefix/include/lua52/"
cat > "$prefix/lib/pkgconfig/lua52.pc" <<EOF
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include/lua52
Name: Lua
Description: Lua 5.2.4, static Windows library
Version: 5.2.4
Libs: -L\${libdir} -llua52 -lm
Cflags: -I\${includedir}
EOF
popd
stage mpv
reuse=()
if [[ -f "$build/mpv/meson-private/coredata.dat" ]]; then reuse=(--reconfigure); fi
meson setup "${reuse[@]}" "$build/mpv" "$src/mpv" --cross-file "$build/cross.meson" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library shared \
  --wrap-mode=nofallback --auto-features=disabled --prefer-static \
  -Dc_link_args="$LDFLAGS -lstdc++ -lpthread" -Dcpp_link_args="$LDFLAGS -lpthread" \
  -Dgpl=false -Dlibmpv=true -Dcplayer=true -Dwasapi=enabled -Dd3d11=enabled -Dshaderc=enabled \
  -Ddirect3d=disabled -Dlcms2=enabled -Dgl=disabled -Dspirv-cross=enabled \
  -Dlua=lua52 -Dwin32-threads=enabled -Dbuild-date=false
meson compile -C "$build/mpv" -j "$jobs"
stage evidence
cp "$build/mpv/libmpv-2.dll" "$build/mpv/libmpv.dll.a" /work/result/
cp "$build/mpv/mpv.exe" "$build/ffmpeg/ffmpeg.exe" "$build/ffmpeg/ffprobe.exe" /work/result/
"$STRIP" /work/result/*.dll /work/result/*.exe
"$CC" --version > /work/result/compiler.txt
"$CC" -print-file-name=libstdc++.a > /work/result/compiler-libraries.txt
"$CC" -print-file-name=libgcc.a >> /work/result/compiler-libraries.txt
"$CC" -print-file-name=libwinpthread.a >> /work/result/compiler-libraries.txt
"${CC%-gcc}-objdump" -p /work/result/libmpv-2.dll > /work/result/pe-imports.txt
cp "$build/mpv/meson-info/intro-buildoptions.json" /work/result/mpv-buildoptions.json
cp "$build/mpv/config.h" /work/result/mpv-config.h
cp "$build/ffmpeg/config.h" /work/result/ffmpeg-config.h
cp "$build/ffmpeg/config_components.h" /work/result/ffmpeg-components.h
cp "$build/ffmpeg/ffbuild/config.log" /work/result/ffmpeg-config.log
find "$prefix" -name '*.a' -type f -print0 | sort -z | xargs -0 sha256sum > /work/result/static-libraries.sha256
cp "$build/cross.meson" "$build/cross.cmake" /work/result/
sha256sum /work/result/*.dll /work/result/*.exe > /work/result/binaries.sha256
printf '\n[complete] local LGPL build %s\n' "$(date -u +%FT%TZ)"
