# 开源组件说明

LuckyRay 感谢所使用的开源项目。各组件保留自己的版权与许可证。

- 插件 SDK 1.0.0：本仓库 `sdk/` 采用 [MIT](../sdk/LICENSE)，CLI 使用 Node.js 内置模块。
- DeepSeek Harness：v1.9.4 随包基线为官方 `@deepseek-ai/dsh 0.1.7-rc.2`，许可原文见 [MIT](dsh-0.1.7-rc.2.LICENSE)。
- 原生依赖：包括 LibreOffice kit、sharp/libvips 和 FFmpeg，分别涉及 MPL、LGPL、GPL 等许可证。v1.9.4 中 FFmpeg 程序/DLL 组合的许可范围为 GPL-3.0-or-later，原上游 LGPL 声明完整保留；具体以材料包内许可范围说明为准。

本页为概要。[v1.9.4 公开归档](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.4)提供[第三方材料包](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-third-party-materials.zip)及[桌面组件许可补充包](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-desktop-third-party-supplement.zip)。两个材料包均为安装器的必要分发附件，请一同下载并保留。

- 原第三方材料包包含 DSH / Node 运行时、sharp / libvips、LibreOffice、FFmpeg 等组件的版权、许可原文、固定版本源码入口、补丁、构建输入及重新链接说明；请先阅读 `README.zh-CN.md` 与 `THIRD-PARTY/SOURCE.zh-CN.md`。
- 桌面组件补充包提供前端、Rust 依赖、Rust 标准库及相关原生组件的版权、许可与源码说明，并随附适用 MPL-2.0 组件的精确源包；请先阅读其 `README.zh-CN.md` 与 `SOURCE.zh-CN.md`。

两个材料包彼此不替代，各第三方许可证赋予的权利保持有效。

参考：[MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/) · [LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html) · [FFmpeg 分发说明](https://ffmpeg.org/legal.html)

Collector 是独立扩展，不适用本仓库 SDK 的 MIT 许可；以其发行附件中的说明为准。
