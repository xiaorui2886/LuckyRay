# 下载与安装

桌面安装包下载尚未开放。已开放 [Collector 1.9.4 历史版本归档](https://github.com/xiaorui2886/LuckyRay/releases/tag/collector-v1.9.4)（预发布）与 [插件 SDK 1.0.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/sdk-v1.0.0)（开发者预览）。请以相应 Release 的版本和附件为准。

## Collector 1.9.4

Collector 是 Edge / Chrome 浏览器采集扩展，需搭配兼容版本的 LuckyRay 桌面端使用；桌面端公开下载尚未开放。

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
