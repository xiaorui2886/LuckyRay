# 下载与安装

当前桌面版为 **LuckyRay 1.9.9（Windows x64）**；浏览器扩展仍为 **Collector 1.9.6**，两者分别更新。[完整更新明细](releases/v1.9.9.md)。

## Windows x64 桌面版 1.9.9

- [下载 LuckyRay_1.9.9_x64-setup.exe](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.9/LuckyRay_1.9.9_x64-setup.exe)
- [发行附件、校验清单及第三方材料](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.9)

安装包内置 LSH 0.2.1-rc.3，不需另走在线引擎更新取得这一随包版本。请一并查阅并保留本次发行页列出的第三方许可和对应源码材料；第三方组件保留各自许可。

### 从旧版更新

1. 备份重要资料，保存笔记，正常退出待更新软件。
2. 原公开版 1.9.7 及更早版本需手动安装一次新版。1.9.8 起支持带签名校验的应用内更新。
3. 更新后正常打开软件检查自己的资料；不要混用开发版和日常版数据，也不要用旧程序直接打开新版格式数据。

更新器使用的签名与更新清单无需普通用户手动配置。更新器签名与 Windows Authenticode 是两回事，本版安装器仍未进行 Authenticode 代码签名。

## 其他桌面历史版本

最近历史版本：[v1.9.8](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.8) · [v1.9.7](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.7) · [v1.9.6](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.6) · [v1.9.5](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.5)。

更早 Windows x64 历史归档：[v1.6.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.6.0) · [v1.7.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.0) · [v1.7.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.1) · [v1.7.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.2) · [v1.7.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.3) · [v1.7.4](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.7.4) · [v1.8.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.8.0) · [v1.9.0](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.0) · [v1.9.1](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.1) · [v1.9.2](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.2) · [v1.9.3](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.3) · [v1.9.4](https://github.com/xiaorui2886/LuckyRay/releases/tag/v1.9.4)。各版更新说明见[版本历史](version-history.md)。v1.6.1–v1.6.7 仅保留更新说明，未附独立桌面安装包。

这些归档保留原安装包，未重新构建，也未重新运行历史安装、升级或卸载流程。请先备份资料，阅读各版升级说明，并同时下载、保留该 Release 列出的全部第三方材料及校验清单。

- v1.6.0、v1.7.0–v1.7.3：请使用桌面组件补充包 v2；旧补充包仅作为上一版说明归档保留。v1.7.2 与 v1.7.3 还需 Hermes 运行时材料包。
- v1.7.4、v1.8.0、v1.9.0–v1.9.3：需同时保留桌面组件补充包 v2 和历史运行时第三方材料包，并按包内 `APPLICABILITY.json` 阅读该版本适用的材料。
- v1.7.4 与 v1.8.0 另提供[FFmpeg 7.1 对应源码与构建材料](https://github.com/xiaorui2886/LuckyRay/releases/download/v1.7.4/LuckyRay-1.7.4-1.8.0-FFmpeg-source-materials.zip)（567,001,807 字节；两版共用，保存在 v1.7.4 发行页）。SHA-256：`7c1cf0683b635ee243c58779da636d8356d51197d046bef5663bdcbaac47b8ae`。

安装使用无需解压或安装源码材料；需要查看组件源码或再次分发时，请一并查阅并保留相应材料及许可说明。

材料索引与许可范围另见[开源组件说明](../third-party/README.md)。

**v1.7.0 升级注意**：数据库会迁移至 v3，并移除旧 SQLite 笔记及相关索引对象；请确认笔记已保存在 Markdown 知识库后再升级。

## Collector 1.9.6

Collector 是 Edge / Chrome 浏览器采集扩展，本次继续沿用正式 1.9.6 扩展包，需独立下载和更新。

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

当前桌面安装器未作 Authenticode 签名。SHA-256 可核对文件完整性，但不能代替发行者签名；不要为安装而关闭安全软件或绕过安全检查。

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 核对附件，并与相应 Release 的校验清单比较。

GitHub 自动生成的 Source code ZIP 是仓库源码与资源归档，不是桌面安装程序。

[插件 SDK 入门](../sdk/README.zh-CN.md) · [v1.9.9 版本说明](releases/v1.9.9.md)
