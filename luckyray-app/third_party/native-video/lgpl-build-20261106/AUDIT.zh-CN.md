# 1.9.10 私库候选：新建可追溯 LGPL 播放器

## 本次采用的处理

原 DLL 的依赖 HEAD/补丁缺口无法从已失效的上游产物恢复，原审计没有改成通过。
按用户授权，从完整对应源码在本机建立新的播放器，保留原 mpv 和 FFmpeg 提交；
没有用 AGPL 预编译播放器、LibreMPEG、x264、x265 或不对应的最新版源码替代。
这不是把旧 DLL 的批准字段改成 true。

- 新 DLL：52,959,744 字节，SHA256 `6938419e82922251619c274c20b33186e70ad2408bb16b30f490433e8c1cbb17`。
- mpv：`3186d369f9f090cd1363be0ac46a037824b702c6`；FFmpeg：`0b01ed76aa6a64e95ec4b87297aaa374a72de34e`。
- 15 个完整源码树、28,893 个源文件；版本、逐文件摘要、完整补丁状态及源档来源见
  `BUILD-INFO.json` / `SOURCE-INDEX.json`。无法证明上游 Git HEAD 的依赖标成精确
  source snapshot，不伪造提交号。构建前后源文件核对保留，Python 缓存和旧构建产物不分发。
- 运行库完整源档 `sources.tar.xz`：90,803,416 字节，SHA256
  `6ef285e376973ac682553c77aa1518f31fac7b65219fb3332b36d96294f84d83`，随安装器安装到 `native-video/`。
- 本机构建：固定摘要的 GCC/MinGW 容器，4 worker、构建时断网；全新静态依赖前缀，
  未链接镜像预编译的媒体库。该容器在本机运行，不是 GitHub Runner。
- mpv 禁用 GPL-only 构建单元；编译单元清单核对未包含 Copyright 中列举的 GPL-only 文件。
  FFmpeg `CONFIG_GPL=0 / CONFIG_GPLV3=0 / CONFIG_NONFREE=0 / CONFIG_VERSION3=0`。
  LCMS2 GPL fastfloat/threaded 插件未编译。Shaderc 使用本次源码生成的 combined 静态库。
- D3D11、WASAPI、字幕与色彩管理保留；Lua 5.2.4 用原始发布源档及官方 SHA256，
  为保留现有客户端选项而编译。应用仍禁用配置、自动脚本、网络流和任意播放器命令。
- PE 导入清单只有 Windows 系统 DLL，没有未附带的第三方动态依赖。

## 软件许可与重新链接

本机同一源码构建还产出 `ffmpeg.exe`（34,188,288 字节，SHA256
`602112ab4a82ee5cec271b3658cc0d8c7ee829fdcf4b9dcc856537df98821b36`）和
`ffprobe.exe`（33,975,808 字节，SHA256
`a5be5ef6a81af32040cf58ac112ed3d4c1a9efad8b9d2b43977072c422da338e`）。
二者使用上述同一 FFmpeg 源码与构建配置；其对应源代码已经包含在同一源档中。
独立工具不链接 mpv 的 Apache/文本排版依赖，许可采用 FFmpeg LGPL-2.1-or-later、
zlib/bzip2/dav1d 的原宽松许可及 GCC 运行库例外。独立工具不含 lensfun filter。
这两份程序替代材料不完整的旧 FFmpeg 9.0.1 工具；不会拿本源档替旧工具冒认对应源码。
封存清单因此由 41 增至 43 个文件，所有新增文件仍逐项验哈希。

逐组件选用许可、版权和原始文本见 `LICENSES.md` 与 `licenses/`；完整源码中保留
逐文件版权。整体按库允许的 later-version 条款选择 LGPL 3，Apache 依赖仍保留
Apache-2.0，FreeType 选择 FTL 并提供署名，不把它们全部重新标作 LGPL/MIT。
GCC runtime 使用 Runtime Library Exception 3.1，MinGW/winpthreads 原文与完整源档随附。

采用 LGPL 3 4(d)(0) 的完整对应库源码及应用代码/重新链接交付方式；同一私库 Release
必须附 `LuckyRay-1.9.10-source.zip`，其版本须与安装器一致。具体步骤在
`RELINK.zh-CN.md`。默认 DLL 大小及摘要校验继续存在，不提供未校验的运行时覆盖入口。
本轮新 DLL 替换、更新绑定及对应应用构建就是该流程的实际执行；不能仅凭动态加载
就声称随便替换文件可用。允许为调试 LGPL 库修改进行反向工程。

**编解码专利：NOT_ASSESSED。** HEVC/H.264/AAC 的专利地域、产品与商业分发事项
独立存在，没有采购、专利许可结论或公开发布批准。`redistributionApproved` 仅标记
本次私库验收的软件许可材料闭合；manifest 同时限定 private-acceptance-only。

## 验证边界

实际 H3 HEVC Main10/yuv420p10le/AAC 与已有 H.264/AAC 原成品，使用生产播放器
包装进行了连续画面、音频输出、跳转及重开验证，均通过且原文件 SHA256 未变。
静音卡片帧路径也通过，均有 10 个不同解码帧。Windows WASAPI 输出已建立。
这仍是独立播放器层检查，不能代替素材库和画布实际界面、听感及安装/覆盖升级验收；
后续结果以 #233 最终回执为准。

新增资源门禁对缺源码、许可证篡改、额外 DLL、仅改状态、未批准、manifest 不一致、
旧开发库进入 release、完全缺失运行库等拒绝用例共 9 项通过；资源绑定合同 6 项通过。
此前额外回归 9 项的独立复核在对应 REGRESSION-RECOVERY 文档，不重算成播放实测。
