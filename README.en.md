<div align="center">

# LuckyRay

**Bring your materials, notes and ideas into one creative workspace.**

A local-first Windows app · Material library · Markdown notes · Canvas · AI

[简体中文](README.md) · **English**

[Download desktop app](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) · [Installation guide](docs/downloads.md) · [Version history](docs/version-history.md) · [Feedback](https://github.com/xiaorui2886/LuckyRay/issues)

</div>

## Put what you collect to work

Save a reference image, capture an idea, then bring them together on a canvas. LuckyRay connects material organization, Markdown notes and AI-assisted creation, making the content you find easier to understand, organize and use again.

**Collect references → Organize materials → Connect ideas → Create**

## A connected workspace

| Space | What you can do |
| --- | --- |
| **Material library** | Organize images, videos and creative files with folders, tags and search. Keep source information and export original files or CSV metadata. |
| **Markdown knowledge base** | Write notes and connect ideas through links, backlinks and a relationship graph. |
| **Canvas** | Arrange text, images and videos freely to organize references, develop ideas and plan your next piece of work. |
| **AI / LightSeek** | Connect your chosen model provider and use authorized notes and materials to help find, understand and create content. |
| **Collector web capture** | Collect web content and supported materials through the Edge / Chrome extension, then organize them in the desktop app. |
| **Plugins** | Add capabilities as you need them. Review permissions at installation and choose which materials a plugin can access. |

## Get started

### Choose your download

| Download | Who it is for |
| --- | --- |
| [**LuckyRay 1.9.5 · Windows x64**](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) | Current stable desktop release for Windows 10/11 x64. Download and keep both companion third-party license and source material packages alongside the installer. |
| [**Collector 1.9.5 · Main R7**](https://github.com/xiaorui2886/LuckyRay/releases/tag/collector-v1.9.5) | Edge / Chrome extension, marked as a pre-release. Download separately for use with the LuckyRay 1.9.5 desktop app. |
| [**Plugin SDK 1.0.0**](https://github.com/xiaorui2886/LuckyRay/releases/tag/sdk-v1.0.0) | Developer preview for plugin authors, with type definitions, tools and teaching examples. |

Desktop 1.9.5 and Collector 1.9.5 were publicly released on **2026-10-06 (UTC)**. Updating the desktop app does not automatically update Collector in your browser. Update the extension separately: switch to the new extracted folder or replace the files in the currently loaded folder, click **Reload** in the browser's extension manager, then refresh any open pages. See the [installation guide](docs/downloads.md) for details and the [version history](docs/version-history.md) for other releases and download availability.

1. **Install the desktop app.** Read the [installation guide](docs/downloads.md) for system requirements, checksums and installation notes. Back up important data first.
2. **Build your own workspace.** Import materials, organize Markdown notes and bring references and ideas together on the canvas.
3. **Connect what you need.** Install Collector for web capture. To use AI, configure your own model provider and choose the materials it may use.

## Extend your workflow

SDK 1.0.0 includes tools to create, check and package plugins, plus four teaching examples: **material manifests, color palettes, note outlines and canvas export**. Running a plugin requires a compatible desktop host. Start with the [compatibility notes](docs/compatibility.md).

The plugin catalog is open for submissions and currently has no listed third-party entries. For now, users download plugins manually and install them in the app.

[English SDK guide](sdk/README.md) · [中文开发指南](sdk/README.zh-CN.md) · [Browse the catalog](catalog/README.md) · [Submit a plugin](catalog/SUBMISSION.md)

## Your materials, your choices

Materials, Markdown notes and canvases are stored locally or in your chosen location by default. When you use AI, web search or web fetching, relevant content may be sent to the services you select. Model and search providers may charge separately. Adding materials to a conversation draft does not automatically send them to a model.

Web capture depends on site structure, access permissions and DRM restrictions. Keep independent backups of important data. Read more in the [privacy and network notes](PRIVACY.md) and [LightSeek overview](docs/lightseek.md).

## Documentation and feedback

- **Installation and releases:** [Download guide](docs/downloads.md) · [1.9.5 release notes](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5) · [Full version history](docs/version-history.md)
- **Use and licensing:** [Use and license terms](LICENSE.md) · [Privacy](PRIVACY.md) · [Open-source acknowledgments](third-party/README.md)
- **Help improve LuckyRay:** [Report a bug / suggest a feature](https://github.com/xiaorui2886/LuckyRay/issues) · [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md)

The desktop app is free to install and use; see the [application terms](LICENSE.md) for details. The `sdk/` directory is [MIT-licensed](sdk/LICENSE). The desktop app, Collector and third-party components have their own applicable licenses, and rights granted by third-party licenses remain in effect.

The SDK has a dedicated English guide. Most other linked documentation is currently in Chinese.
