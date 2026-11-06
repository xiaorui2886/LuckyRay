# 替换与重新链接说明

本版本选择 LGPL 3 第 4(d)(0) 项的对应源码/应用代码交付方式。
默认应用仍校验官方随包 DLL 的大小与 SHA256；直接改 DLL 会被拒绝。
没有把“动态 DLL”本身当作已经满足替换要求，也没有关闭安全校验。

1. 从同一私库 1.9.10 Release 取得 `LuckyRay-1.9.10-source.zip`，解压到短路径。
   它是安装器对应提交的完整应用源码（含 Cargo.lock、pnpm-lock.yaml、原生播放器
   包装和构建脚本），不是仅有许可文件或测试回执。修改 LGPL 库及为调试这些修改
   而进行的反向工程不受应用条款限制。无需 LuckyRay 的更新签名私钥即可本地构建运行。
2. 解压本目录 `sources.tar.xz` 到空的工作目录；保留 `sources`、`source-trees.json`、
   `build-lgpl.sh` 和 `toolchain`。逐文件哈希在 SOURCE-INDEX.json。
3. 使用 BUILD-INFO.json 固定摘要的容器工具链，在本机挂载该目录到 `/work`，网络关闭，
   执行 `/bin/bash /work/build-lgpl.sh`。不需要旧二进制、不从运行时下载任何媒体库。
   首次完整构建不要设置 LUCKYRAY_BUILD_RESUME；该变量只用于保留已有对象的本轮修复。
   工具链的 Dockerfile、ct-ng 配置、对应补丁、MinGW-w64 完整源档和运行库例外许可一并提供。
4. 修改库后重新构建得到 `result/libmpv-2.dll`。公开 libmpv client API 需要兼容；
   把新文件置于应用 `src-tauri/native-video`，保留所有对应源码与许可证。
   更新 `third_party/native-video/manifest.json` 中 DLL 及每个已修改材料的大小/SHA256，
   同步 `src-tauri/native-video/runtime-manifest.json`，并更新
   `src-tauri/src/material_native_video/mpv.rs` 的 DLL_SHA256 与 DLL_SIZE。
   这是使用完整应用代码重新链接，不是要求偷偷绕过官方应用的校验。
5. 在应用根按 package.json 的固定工具版本准备依赖，执行
   `powershell -NoProfile -File scripts/prepare-native-video.ps1 -VerifyOnly`，
   再执行 `powershell -NoProfile -File scripts/build-nsis.ps1 -LshBackgroundPreload`。
   全部检查仍须通过；生成的自用应用不必使用官方更新签名，也没有安装器密钥锁定。
   不要覆盖正在运行或有未保存资料的安装。不要改造原用户资料来做替换验证。

本轮实际采用的就是这条路径：保留原 mpv/FFmpeg 提交，从完整源码重建新 DLL、更新
绑定并编译对应应用。不同编译时间/工具链可能产生不同 PE 时间戳，未承诺逐字节复现。
重新分发修改版本时仍需履行相应许可义务；本说明不授予编解码专利许可。
