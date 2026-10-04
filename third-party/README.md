# 开源组件说明

LuckyRay 感谢所使用的开源项目。各组件保留自己的版权与许可证。

- 插件 SDK 1.0.0：本仓库 `sdk/` 采用 [MIT](../sdk/LICENSE)，CLI 使用 Node.js 内置模块。
- DeepSeek Harness：v1.9.4 随包基线为官方 `@deepseek-ai/dsh 0.1.7-rc.2`，许可原文见 [MIT](dsh-0.1.7-rc.2.LICENSE)。
- 原生依赖：包括 LibreOffice kit、sharp/libvips 和 FFmpeg，分别涉及 MPL、LGPL、GPL 等许可证。v1.9.4 中 FFmpeg 程序/DLL 组合的许可范围为 GPL-3.0-or-later，原上游 LGPL 声明完整保留；具体以材料包内许可范围说明为准。

本页为概要。[v1.9.4 公开归档](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.4)提供[第三方材料包](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-third-party-materials.zip)及[桌面组件许可补充包](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.4/LuckyRay-1.9.4-desktop-third-party-supplement.zip)。两个材料包均为安装器的必要分发附件，请一同下载并保留。

- 原第三方材料包包含 DSH / Node 运行时、sharp / libvips、LibreOffice、FFmpeg 等组件的版权、许可原文、固定版本源码入口、补丁、构建输入及重新链接说明；请先阅读 `README.zh-CN.md` 与 `THIRD-PARTY/SOURCE.zh-CN.md`。
- 桌面组件补充包提供前端、Rust 依赖、Rust 标准库及相关原生组件的版权、许可与源码说明，并随附适用 MPL-2.0 组件的精确源包；请先阅读其 `README.zh-CN.md` 与 `SOURCE.zh-CN.md`。

两个材料包彼此不替代，各第三方许可证赋予的权利保持有效。

## 其他桌面历史版本

v1.6.0、v1.7.0–v1.7.4、v1.8.0 与 v1.9.0–v1.9.3 的公开归档入口见[版本历史](../docs/version-history.md)及[下载说明](../docs/downloads.md)。各版安装器需与发行说明列出的全部第三方材料一同下载并保留。

- 桌面组件材料：使用 `LuckyRay-historical-desktop-third-party-supplement-v2.zip`，包含历史前端、Rust、标准库与原生组件的版权、许可、适用范围及源码材料。早期发行页保留的旧补充包已被 v2 替代。
- v1.7.2 与 v1.7.3：另需 `LuckyRay-historical-Hermes-notices.zip`，提供相应 Hermes/Python 运行时材料。
- v1.7.4、v1.8.0 与 v1.9.0–v1.9.3：另需 `LuckyRay-historical-runtime-third-party-materials.zip`。按包内 `APPLICABILITY.json` 选取对应版本的运行时、原生库、版权、许可及源码材料；未列出的目录不表示该组件存在于相应版本。
- v1.7.4 与 v1.8.0：另提供[FFmpeg 7.1 对应源码与构建材料](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.7.4/LuckyRay-1.7.4-1.8.0-FFmpeg-source-materials.zip)，两版共用同一份公开附件，保存在 v1.7.4 发行页。文件大小和 SHA-256 见各版发行说明及校验清单。

安装使用无需解压或安装源码材料；需要查看组件源码或再次分发时，请一并查阅并保留相应材料及许可说明。

历史 FFmpeg 工具与库组合含有 GPL 组件，其分发须遵守 GPL-3.0-or-later；原始 LGPL 文本一并保留，不能只依据上游文件名中的 LGPL 标签判断实际许可范围。该范围针对 FFmpeg 工具与库，不对独立 LuckyRay 宿主作自动许可推断。请阅读包内对应的许可范围、源码与构建说明；材料整理不构成法律认证。

参考：[MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/) · [LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.html) · [FFmpeg 分发说明](https://ffmpeg.org/legal.html)

Collector 是独立扩展，不适用本仓库 SDK 的 MIT 许可；以其发行附件中的说明为准。
