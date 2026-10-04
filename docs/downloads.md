# 下载与安装

已开放 [Windows x64 桌面版 1.9.4 历史归档](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.4)、[Collector 1.9.4 历史版本归档](https://github.com/xiaorui2886/LuckyRay/releases/tag/collector-v1.9.4)（预发布）与 [插件 SDK 1.0.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/sdk-v1.0.0)（开发者预览）。请以相应 Release 的版本和附件为准。

## Windows x64 桌面版 1.9.4

请同时下载并保留安装器与以下两个第三方材料包；两个材料包均为本安装器的必要分发附件，彼此不替代。

- [下载 LuckyRay_1.9.4_x64-setup.exe](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay_1.9.4_x64-setup.exe)（198,051,397 字节）
  - SHA-256：`612486e6249f4cff781f8f2b02746fd6f817cc5b409337550505e951a57d1806`
- [下载 LuckyRay-1.9.4-third-party-materials.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-third-party-materials.zip)（2,705,024 字节）
  - SHA-256：`055418e72a27e83592545a63fa95930c2b2223cd2f1f0c25ba2ba2eb58fa06a0`
- [下载 LuckyRay-1.9.4-desktop-third-party-supplement.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-desktop-third-party-supplement.zip)（1,883,394 字节）
  - SHA-256：`bf84f934be36d0ad19b912e31c3ee9f48307fc9cedb0af810a1e976f7c130a45`
- [SHA-256 校验清单](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/SHA256SUMS.txt)

原第三方材料包包含第三方版权、许可原文及源码获取、补丁、构建与重新链接说明，请先阅读包内 `README.zh-CN.md` 与 `THIRD-PARTY/SOURCE.zh-CN.md`。桌面组件补充包提供前端、Rust 依赖、Rust 标准库及相关原生组件的许可与源码说明，并随附适用 MPL-2.0 组件的精确源包，请阅读其 `README.zh-CN.md` 与 `SOURCE.zh-CN.md`。各第三方许可证赋予的权利保持有效，具体许可范围见对应包内说明。

原版本发布于 2026-09-28 21:25（UTC+08:00），公开归档发布于 2026-10-04。安装器保持原版字节不变，未重新构建；本次归档未新增 Windows 安装或运行测试。

## 其他桌面历史版本

已开放以下 Windows x64 历史归档：[v1.6.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.6.0) · [v1.7.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.0) · [v1.7.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.1) · [v1.7.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.2) · [v1.7.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.3) · [v1.7.4](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.4) · [v1.8.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.8.0) · [v1.9.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.0) · [v1.9.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.1) · [v1.9.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.2) · [v1.9.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.3)。各版更新说明见[版本历史](version-history.md)。v1.6.1–v1.6.7 仅保留更新说明，未附独立桌面安装包。

这些归档保留原安装包，未重新构建，也未重新运行历史安装、升级或卸载流程。请先备份资料，阅读各版升级说明，并同时下载、保留该 Release 列出的全部第三方材料及校验清单。

- v1.6.0、v1.7.0–v1.7.3：请使用桌面组件补充包 v2；旧补充包仅作为上一版说明归档保留。v1.7.2 与 v1.7.3 还需 Hermes 运行时材料包。
- v1.7.4、v1.8.0、v1.9.0–v1.9.3：需同时保留桌面组件补充包 v2 和历史运行时第三方材料包，并按包内 `APPLICABILITY.json` 阅读该版本适用的材料。
- v1.7.4 与 v1.8.0 另提供[FFmpeg 7.1 对应源码与构建材料](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.7.4/LuckyRay-1.7.4-1.8.0-FFmpeg-source-materials.zip)（567,001,807 字节；两版共用，保存在 v1.7.4 发行页）。SHA-256：`7c1cf0683b635ee243c58779da636d8356d51197d046bef5663bdcbaac47b8ae`。

安装使用无需解压或安装源码材料；需要查看组件源码或再次分发时，请一并查阅并保留相应材料及许可说明。

材料索引与许可范围另见[开源组件说明](../third-party/README.md)。

**v1.7.0 升级注意**：数据库会迁移至 v3，并移除旧 SQLite 笔记及相关索引对象；请确认笔记已保存在 Markdown 知识库后再升级。

## Collector 1.9.4

Collector 是 Edge / Chrome 浏览器采集扩展，需搭配兼容版本的 LuckyRay 桌面端使用。

- [下载 LuckyRay-Collector-1.9.4-public.zip](https://github.com/xiaorui2886/LuckyRay/releases/download/collector-v1.9.4/LuckyRay-Collector-1.9.4-public.zip)（160,814 字节）
- [SHA-256 校验清单](https://github.com/xiaorui2886/LuckyRay/releases/download/collector-v1.9.4/Collector-SHA256SUMS.txt)
- SHA-256：`c5d94bee04a98d34874fab62e886be2da7c8b6fdf751e3f087330102520904ff`

解压后，在浏览器扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，载入包含 `manifest.json` 的 `LuckyRay-Collector-1.9.4` 文件夹。使用前请阅读包内 `README.md` 的权限说明与 `LICENSE.txt` 的使用条款。

原版本发布于 2026-09-28，公开归档整理于 2026-10-04。运行文件保持 1.9.4 原样，不代表当前开发进度或最新功能。

## 桌面端系统要求

- Windows 10/11，x64
- WebView2；缺少时按系统提示从官方渠道安装
- 运行桌面应用不需要另装 Node.js；开发插件需要 Node.js 18 或更高版本

## 安装与校验

请备份重要资料。升级后，不建议用旧程序打开新格式数据。

v1.9.4 原安装器未作 Authenticode 签名。SHA-256 可核对文件完整性，但不能代替发行者签名；不要为安装而关闭安全软件或绕过安全检查。

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 核对附件，并与相应 Release 的校验清单比较。

GitHub 自动生成的 Source code ZIP 是文档与 SDK 资源，不是桌面安装程序。

[插件 SDK 入门](../sdk/README.zh-CN.md) · [v1.9.4 版本说明](releases/v1.9.4.md)
