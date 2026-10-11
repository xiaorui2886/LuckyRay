# 下载与安装

当前下载：[Windows x64 桌面版 1.9.6](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.6)、[Collector 1.9.6](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.6)与 [插件 SDK 1.0.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/sdk-v1.0.0)（开发者预览）。请以相应 Release 的版本和附件为准。

## Windows x64 桌面版 1.9.6

请同时下载并保留安装器与以下两个第三方材料包；两个材料包均为本安装器的必要分发附件，彼此不替代。

- [下载 LuckyRay_1.9.6_x64-setup.exe](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.6/LuckyRay_1.9.6_x64-setup.exe)（200,104,201 字节）
  - SHA-256：`994a56605071c7e762f630a5e2bf241e05d66f458f5debb2ee09c77e28f3a4a4`
- [下载 LuckyRay-1.9.5-third-party-materials.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.5/LuckyRay-1.9.5-third-party-materials.zip)（2,881,473 字节）
  - SHA-256：`5373a7485787626919ef843fcc689e5b904a8cb2d31c5cc744962ad37274ed42`
- [下载 LuckyRay-1.9.5-desktop-third-party-supplement.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.5/LuckyRay-1.9.5-desktop-third-party-supplement.zip)（1,973,401 字节）
  - SHA-256：`fcd7d66f07f0ef697fed98a8c09e12324f792140e9b645eeeca7613df01a673e`
- [SHA-256 校验清单](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.6/SHA256SUMS.txt)

第三方材料包包含第三方版权、许可原文及源码获取、补丁、构建与重新链接说明，请先阅读包内 `README.zh-CN.md` 与 `THIRD-PARTY/SOURCE.zh-CN.md`。桌面组件补充包提供前端、Rust 依赖、Rust 标准库及相关原生组件的许可与源码说明，并随附适用 MPL-2.0 组件的精确源包，请阅读其 `README.zh-CN.md` 与 `SOURCE.zh-CN.md`。各第三方许可证赋予的权利保持有效，具体许可范围见对应包内说明。

桌面 1.9.6 于 2026-10-11（UTC）公开发布，保留维护者实际安装体验通过的原始安装包字节。两个第三方材料包沿用相同依赖对应的 v1.9.5 原始附件，保留原名和许可范围；请一同下载。完整变化见 [1.9.6 发布说明](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.6)。

## 其他桌面历史版本

已开放以下 Windows x64 历史归档：[v1.6.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.6.0) · [v1.7.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.0) · [v1.7.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.1) · [v1.7.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.2) · [v1.7.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.3) · [v1.7.4](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.4) · [v1.8.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.8.0) · [v1.9.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.0) · [v1.9.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.1) · [v1.9.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.2) · [v1.9.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.3) · [v1.9.4](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.4)。各版更新说明见[版本历史](version-history.md)。v1.6.1–v1.6.7 仅保留更新说明，未附独立桌面安装包。

这些归档保留原安装包，未重新构建，也未重新运行历史安装、升级或卸载流程。请先备份资料，阅读各版升级说明，并同时下载、保留该 Release 列出的全部第三方材料及校验清单。

- v1.6.0、v1.7.0–v1.7.3：请使用桌面组件补充包 v2；旧补充包仅作为上一版说明归档保留。v1.7.2 与 v1.7.3 还需 Hermes 运行时材料包。
- v1.7.4、v1.8.0、v1.9.0–v1.9.3：需同时保留桌面组件补充包 v2 和历史运行时第三方材料包，并按包内 `APPLICABILITY.json` 阅读该版本适用的材料。
- v1.7.4 与 v1.8.0 另提供[FFmpeg 7.1 对应源码与构建材料](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.7.4/LuckyRay-1.7.4-1.8.0-FFmpeg-source-materials.zip)（567,001,807 字节；两版共用，保存在 v1.7.4 发行页）。SHA-256：`7c1cf0683b635ee243c58779da636d8356d51197d046bef5663bdcbaac47b8ae`。

安装使用无需解压或安装源码材料；需要查看组件源码或再次分发时，请一并查阅并保留相应材料及许可说明。

材料索引与许可范围另见[开源组件说明](../third-party/README.md)。

**v1.7.0 升级注意**：数据库会迁移至 v3，并移除旧 SQLite 笔记及相关索引对象；请确认笔记已保存在 Markdown 知识库后再升级。

## Collector 1.9.6

Collector 是 Edge / Chrome 浏览器采集扩展，配套 LuckyRay 1.9.6 桌面端使用，需独立下载和更新。

- [下载 LuckyRay-Collector-1.9.6.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.6/LuckyRay-Collector-1.9.6.zip)（247,416 字节）
- [SHA-256 校验清单](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.6/SHA256SUMS.txt)
- SHA-256：`0fa78eda7989ce64cd22e89115fa8996494d8b74b5e9accfca9050f7ad9923b8`

解压后，在浏览器扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，载入直接包含 `manifest.json` 的文件夹。使用前请阅读 Release 附件 [COLLECTOR-README.zh-CN.md](https://github.com/xiaorui2886/LuckyRay/releases/download/collector-v1.9.5/COLLECTOR-README.zh-CN.md) 的安装与权限说明，并保留 [COLLECTOR-LICENSE.txt](https://github.com/xiaorui2886/LuckyRay/releases/download/collector-v1.9.5/COLLECTOR-LICENSE.txt)、使用说明与来源校验记录。

已安装旧版的用户，需要切换到新文件夹或新解压内容，再点“重新加载”并刷新原先打开的网页。仅更新桌面程序或下载新包不会更新旧加载目录。

Collector 1.9.6 于 2026-10-11（UTC）随桌面版公开，保留原验收 ZIP 字节。新增直接 MP3/WAV 音频采集、视频悬浮图标开关及保存反馈改进。

## 桌面端系统要求

- Windows 10/11，x64
- WebView2；缺少时按系统提示从官方渠道安装
- 运行桌面应用不需要另装 Node.js；开发插件需要 Node.js 18 或更高版本

## 安装与校验

请备份重要资料。升级后，不建议用旧程序打开新格式数据。

v1.9.6 安装器未作 Authenticode 签名。SHA-256 可核对文件完整性，但不能代替发行者签名；不要为安装而关闭安全软件或绕过安全检查。

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 核对附件，并与相应 Release 的校验清单比较。

GitHub 自动生成的 Source code ZIP 是文档与 SDK 资源，不是桌面安装程序。

[插件 SDK 入门](../sdk/README.zh-CN.md) · [v1.9.6 版本说明](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.6)
