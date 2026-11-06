# FFmpeg / ffprobe 对应源码与许可

本版本随包的独立工具由 LuckyRay 本机从 FFmpeg
`0b01ed76aa6a64e95ec4b87297aaa374a72de34e` 构建，版本字符串为 `8.0.git`。
它与本次 libmpv 使用同一套经过记录的 FFmpeg 源码、补丁和工具链，
并非此前 System233 FFmpeg 9.0.1 二进制的重新标记。

- 实际构建关闭 GPL、nonfree、version3 与依赖自动探测；使用静态 FFmpeg 库、
  zlib、bzip2、dav1d、MinGW-w64/GCC 运行库。没有编入 lensfun filter。
- FFmpeg 为 LGPL-2.1-or-later；相关宽松许可、GCC Runtime Library Exception
  以及原始版权文本在安装目录的 `native-video/licenses/`。
- 完整首选源码、适用补丁、构建脚本与工具链材料在同一安装目录的
  `native-video/sources.tar.xz`，逐文件索引为 `native-video/SOURCE-INDEX.json`。
  `native-video/BUILD-INFO.json` 记录精确版本和二进制摘要。
- 解压源码，按其中 `build-lgpl.sh` 的固定工具链执行；`make` 同时产生
  `result/ffmpeg.exe` 和 `result/ffprobe.exe`。对应库的静态对象由同一源码构建，
  可以修改并重新链接程序，不需要 LuckyRay 的签名私钥。
- 本机自用替换需同步 `third_party/media-engine/manifest.json` 的工具大小/摘要、
  `third_party/native-video/manifest.json` 以及封存运行资源，再重新构建应用。
  完整对应 LuckyRay 应用源码与本版本一起提供；保留原有安全校验。

这些工具作为独立子进程执行媒体探测、抽帧、声波和流复制合并。
运行资源安装在 `media-engine/1910-1/`，开发封存输入仍为
`src-tauri/media-engine/`。覆盖安装会保留旧目录，程序只验证并使用新版完整目录；
旧版遗留的 DLL 不会进入新版运行清单，也不会回退加载旧工具。
未承诺旧第三方工具全部可选编码器/滤镜都存在；本次按产品实际使用范围验证。
没有更改工作流、原成品或原文件导出逻辑。
本说明不授予 HEVC/H.264/AAC 等专利许可，也不代表已完成专利评估。
