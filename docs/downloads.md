# 下载与安装

桌面安装包和 Collector 下载尚未开放。开放后将统一发布在本仓库 [Releases](https://github.com/xiaorui2886/LuckyRay/releases)，请以该页面的版本和附件为准。

## 系统要求

- Windows 10/11，x64
- WebView2；缺少时按系统提示从官方渠道安装
- 运行桌面应用不需要另装 Node.js；开发插件需要 Node.js 18 或更高版本

## 安装前

请备份重要资料。升级后，不建议用旧程序打开新格式数据。

v1.9.4 原安装器未作 Authenticode 签名。SHA-256 可核对文件完整性，但不能代替发行者签名；不要为安装而关闭安全软件或绕过安全检查。

下载开放后，可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 核对附件，并与相应 Release 的校验清单比较。

GitHub 自动生成的 Source code ZIP 是文档与 SDK 资源，不是桌面安装程序。

[插件 SDK 入门](../sdk/README.zh-CN.md) · [v1.9.4 版本说明](releases/v1.9.4.md)
