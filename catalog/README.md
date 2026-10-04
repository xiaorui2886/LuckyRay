# LuckyRay 插件目录

这是供浏览和 GitHub PR 审核使用的静态目录。当前生产目录 [entries.json](entries.json) 为空，没有经过核实的第三方插件。

[官方素材清单示例](examples/material-manifest.json) 来自 SDK 1.0.0 的教学代码，演示真实元数据、许可、权限和校验字段。它不属于生产目录，也未被标成实机测试通过或可直接用于生产。

本目录的 schema 描述目录条目元数据，不是宿主 `.lrpack.json` 的安装 schema。软件目前使用本地扩展管理，用户手动获取插件包，在社区中导入/更新、查看权限、授权和启用；没有由此目录提供的在线商城、自动安装和自动更新。

LuckyRay API1 脚本与 DSH 插件为不同体系；本目录首轮只收 API1 桌面脚本条目。目录合并不授予新的宿主权限，也不赋予官方包例外。用户仍须审核来源、许可和权限，软件仍按既有受限运行边界处理。

提交、审核和撤下流程见 [SUBMISSION.md](SUBMISSION.md)，宿主版本边界见[兼容性说明](../docs/compatibility.md)。
