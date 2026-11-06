# 固定原生播放器分发材料补全：尚未闭合

状态：**BLOCKED**。按用户“先暂停成包，补齐播放器分发材料，再打功能完整的包”的决定执行。本目录是阶段材料，不能当作完整可分发声明，也没有授权移除 `manifest.json` 或 `native_video_build.rs` 的门禁。

## 已取得并核对

- 原始 `libmpv-2.dll`：100,487,168 字节，SHA256 `1a51f1000450ce97ae99fa44b13bc312ab5335e511bc8ae28ae2d90c78069848`。
- 上游 7z 原包：28,273,230 字节，SHA256 `1c91708e027ed19eceff5a6f9b62ab1901b3592f02a1924473396db33bc9cec4`。两个文件都只留在已有本地证据目录，没有提交或上传 DLL。
- mpv 源码 `3186d369f9f090cd1363be0ac46a037824b702c6`；原构建记录的 FFmpeg 前缀已解析为 `0b01ed76aa6a64e95ec4b87297aaa374a72de34e`。
- 上游构建仓库 `zhongfly/mpv-winbuild@88bdc4db67bb476a7606921eb2d68b273440d59b`，配方 `shinchiro/mpv-winbuild-cmake@05a60b3cfd04e3e3b89918f4a27f3dde2935dff2`。
- 上述四份固定提交的完整上游源码 tar.gz 已在本地取得，逐份验证归档根目录、大小和 SHA256；索引见 `EVIDENCE.json`。它们是干净上游树，不等于当次所有依赖与补丁的完整构建树。
- 补入八份原始许可/版权文本，来自相应固定提交。这里包含上游随附 GPL 文本，不据此把已观察到的 LGPL 配置改称 GPL 构建。
- 原构建日志明确报告 mpv `gpl=false`、FFmpeg `LGPL version 3 or later`、静态外部依赖。它们只能证明配置，不能单独证明完整许可合规。

## 依赖提交证据为什么缺失

固定配方 [`cmake/custom_steps.cmake`](https://github.com/shinchiro/mpv-winbuild-cmake/blob/05a60b3cfd04e3e3b89918f4a27f3dde2935dff2/cmake/custom_steps.cmake) 的 `write-head` 把 `git rev-parse HEAD` 重定向到每个包的 `HEAD` 文件，而不是标准输出。

固定 [构建工作流](https://github.com/zhongfly/mpv-winbuild/blob/88bdc4db67bb476a7606921eb2d68b273440d59b/.github/workflows/mpv.yml) 的 `Collect logs` 只收集 `*-*.log` 和 `ffbuild/config.log`，没有包含这些 `HEAD`。本地日志里 94 个包目录的 `write-head-out` 均不能提供该锁定表；94 是构建缓存/日志清单，不能当作实际链接库数量。

配方部分依赖使用可变上游分支，没有完整 `GIT_TAG`。仅按配方提交、构建日期、项目版本或当前最新版补下载，会存在源码与 DLL 不对应的风险。没有这样猜测或重新标记现有文件。

实际访问原运行、作业、产物清单及 Release 标签 API 均返回 404；GitHub 作业连接器也返回 404。网页仍可查到历史构建页面，但没有取得当次 `Packages Version` 表或完整源码产物，缓存网页不当作仍可下载的源档。

## 仍缺少的具体材料

1. 当次**实际链接**的静态依赖的精确提交、各自补丁、子模块及 Rust 锁定依赖，以及对应源码；需要与这一个 DLL 的构建身份对应。不是把所有构建过的目录全部宣称为实际依赖。
2. 与这些精确版本匹配的完整版权、许可证和署名材料；现有八份文本只是已补齐的部分。
3. 可操作并验证的 LGPL 替换或重新链接路径。现有应用通过公开 libmpv API 动态加载独立 DLL，但 `mpv.rs` 同时固定检查 DLL 大小及 SHA256，直接替换文件会被拒绝。不能仅凭“用了 DLL”就宣称此项已经满足；需选择并验证适当的应用源码/重新链接交付方式或受控替换方式，保留安全边界。
4. 原有产品特定分发审查。没有据 LGPL 配置推断编解码专利结论，也没有新增购买或公开发布行为。

最小后续输入是上游当次完整 `src_packages` 版本/补丁及源档（含原 `HEAD` 表）。若无法取回，需要另做从完整锁定源码构建的可追溯播放器，再更新摘要和验证原视频功能；那会是新的播放器构建，不能冒充当前已验收 DLL。尚未启动替代构建或新增构建环境。

## 保持的边界

`redistributionApproved` 仍为 `false`；原非 debug 构建拒绝规则、DLL 身份校验和正式资源清单均未改。Main 的原播放器与界面保持运行；没有在安装包中悄悄省略播放器来报告“功能完整”。未构建、签名或上传 1.9.10 安装器，未覆盖 E 盘、重启 Main、修改 profile 或运行模型/GPU。
