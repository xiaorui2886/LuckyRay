<div align="center">

# LuckyRay

**把素材、笔记与灵感，连接成你的创作空间。**

本地优先的 Windows 桌面应用 · 素材管理 · Markdown 知识库 · 画布 · AI

**简体中文** · [English](README.en.md)

[下载桌面版](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) · [下载与安装](docs/downloads.md) · [版本历史](docs/version-history.md) · [反馈建议](https://github.com/xiaorui2886/LuckyRay/issues)

</div>

## 让收集的内容，继续参与创作

保存一张参考图，记录一个想法，再把它们放到同一张画布上。LuckyRay 将素材整理、Markdown 笔记与 AI 辅助创作连接起来，让找到的内容更容易被理解、组织和再次使用。

**收集参考 → 整理资料 → 连接想法 → 继续创作**

## 一个连贯的工作空间

| 空间 | 你可以做什么 |
| --- | --- |
| **素材库** | 用文件夹、标签与搜索整理图片、视频和创作文件；保留来源信息，导出原文件与 CSV 元数据清单。 |
| **Markdown 知识库** | 记录笔记，以链接、反链与关系图谱连接想法，让资料之间的关联清晰可见。 |
| **画布** | 自由组合文字、图片和视频，整理参考、梳理思路，规划下一步创作。 |
| **AI / LightSeek** | 连接你选择的模型服务，在授权范围内使用笔记和素材，辅助查找、理解与创作。 |
| **Collector 网页采集** | 通过 Edge / Chrome 扩展收集网页内容与受支持的素材，交给桌面端继续整理。 |
| **插件扩展** | 按需加入新的工作方式；安装时查看权限，决定插件可以访问的资料。 |

## 开始使用

### 选择你需要的下载

| 下载 | 适用场景 |
| --- | --- |
| [**LuckyRay 1.9.5 · Windows x64**](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) | 当前桌面正式版。适用于 Windows 10/11 x64；请同时下载并保留该版本的两个第三方许可及源码材料附件。 |
| [**Collector 1.9.5 · Main R7**](https://github.com/xiaorui2886/LuckyRay/releases/tag/collector-v1.9.5) | Edge / Chrome 浏览器扩展（预发布），独立下载，配套 LuckyRay 1.9.5 桌面端使用。 |
| [**插件 SDK 1.0.0**](https://github.com/xiaorui2886/LuckyRay/releases/tag/sdk-v1.0.0) | 面向插件作者的开发者预览，包含类型定义、工具与教学示例。 |

桌面 1.9.5 与 Collector 1.9.5 于 **2026-10-06（UTC）** 公开发布。桌面更新不会自动更新浏览器中已加载的 Collector，请按下载说明单独更新扩展。其他版本的说明与下载状态见[版本历史](docs/version-history.md)。

1. **安装桌面端**：先阅读[下载与安装](docs/downloads.md)中的系统要求、文件校验和安装注意事项，并备份重要资料。
2. **建立自己的资料空间**：导入素材、整理 Markdown 笔记，在画布中组合参考与想法。
3. **按需连接更多能力**：需要网页采集时安装 Collector；需要 AI 时配置自己的模型服务，并选择要使用的资料范围。

## 按需扩展你的工作方式

SDK 1.0.0 提供插件创建、检查与打包工具，以及**素材清单、配色、笔记提纲、画布导出**四个教学示例。安装运行需要兼容的桌面宿主，请先查看[版本兼容说明](docs/compatibility.md)。

插件目录已开放提交，目前尚无上架的第三方条目。现阶段由用户手动下载并在应用内安装。

[中文开发指南](sdk/README.zh-CN.md) · [English SDK guide](sdk/README.md) · [浏览插件目录](catalog/README.md) · [提交你的插件](catalog/SUBMISSION.md)

## 你的资料，你来选择

素材、Markdown 笔记与画布优先保存在本地或你选择的资料位置。使用 AI、联网搜索或网页抓取时，相关内容可能发送给你选择的服务；模型和搜索服务可能单独收费。资料加入会话草稿不会自动发送给模型。

网页采集会受到站点结构、访问权限和 DRM 等条件影响。重要资料请保持独立备份。更多说明见[隐私与联网](PRIVACY.md)及 [LightSeek](docs/lightseek.md)。

## 文档与反馈

- **安装与版本**：[下载说明](docs/downloads.md) · [1.9.5 版本说明](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) · [完整版本历史](docs/version-history.md)
- **使用与许可**：[使用与许可说明](LICENSE.md) · [隐私说明](PRIVACY.md) · [开源组件致谢](third-party/README.md)
- **参与改进**：[报告问题 / 提出建议](https://github.com/xiaorui2886/LuckyRay/issues) · [贡献指南](CONTRIBUTING.md) · [安全报告指引](SECURITY.md)

LuckyRay 桌面应用可免费安装和使用，详情见[应用使用条款](LICENSE.md)。本仓库 `sdk/` 采用 [MIT 许可证](sdk/LICENSE)；桌面应用、Collector 与第三方组件各自适用对应许可，第三方许可证赋予的权利保持有效。
