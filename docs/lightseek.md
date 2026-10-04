# LightSeek

LightSeek 是 LuckyRay 的 AI 集成入口，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)接入模型和工具能力。感谢上游项目与开源贡献者。

LuckyRay 是独立产品，与 DeepSeek 的官方产品及服务有所区别。

v1.9.4 随包使用官方 `@deepseek-ai/dsh 0.1.7-rc.2`，其许可证为 [MIT](../third-party/dsh-0.1.7-rc.2.LICENSE)。引擎的第三方依赖分别遵守各自许可，见[组件说明](../third-party/README.md)。

使用时需要配置你自己的模型服务，可能产生第三方费用。模型请求会使用你选择发送的内容，请参阅[隐私说明](../PRIVACY.md)。

应用版本与引擎版本分别管理；v1.9.4 未配置可用的独立引擎在线更新源。DSH 插件与 LuckyRay SDK 插件也使用不同的能力和权限体系。
