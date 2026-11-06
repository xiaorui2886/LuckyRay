# LibreOffice 文档引擎：许可及对应源码

本版本包含 `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5`。
引擎 SHA256、固定 Core 提交、对应源码资产及其 SHA256 见本目录 `SOURCES.json`。
原组件许可在安装目录：

`lr-lsh/1910-2/deepseek-harness/host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/licenses/`

其中 `LibreOffice-MPL-2.0.txt`、`LibreOffice-third-party.html`、
`DeepSeek-Harness-MIT.txt` 均保留原文。各第三方文件保留自身许可，不能把整个静态引擎概括为 MIT。

随本安装器一同交付的 `LuckyRay-1.9.10-Office-corresponding-source.zip` 包含：

- 精确 Core 的完整源码、实际包内的构建脚本、完整修改补丁和配置；
- 固定版本原生依赖源档及 y-crdt 锁定的 Rust 源档、逐文件摘要；
- 实际 OpenSymbol 102.12 的可编辑 SFD、原字体版权和许可文本；
- 源码校验及重建说明。

这些材料和精确应用源码 `LuckyRay-1.9.10-source.zip` 应始终与安装器一起提供。
当前为私库验收候选，取得位置为同一私库版本页面；公开分发前，发行方必须在实际接收者可访问的版本页面提供相同文件并核对链接，不能以私库链接代替公开源码提供。

依赖源档采用保守覆盖集合，未冒充实际链接映射；本轮未完整重编 Office，也未声称能逐字节复现原引擎或字体。完整范围和重建入口见源码资产内 `README.zh-CN.md`。用户可依相应许可修改、重建这些组件，并用对应应用源码更新资源绑定后构建自己的版本，无需官方更新签名私钥。

上游： https://www.libreoffice.org/licenses/
MPL 2.0： https://www.mozilla.org/MPL/2.0/

本说明不授予编解码专利许可，不构成公开发布批准。
