# 版本、公开surface与authority

候选宿主支持可选 Ed25519 包签名；`node sign-package.mjs <unsigned-package.json> <existing-private-key.pem> <new-output.json>` 使用作者已有私钥，工具不生成或迁移密钥。首次安装时应通过可信渠道核对完整公钥并确认；签名只证明密钥控制权，不能单独证明现实身份。同 ID 后续包须用同一私钥签名，才能自动确认身份连续；旧版缺签名、身份变化或签名丢失须用户确认，功能插件会停用并清除授权、保留自有数据。无效签名一律拒绝，旧包保留。旧宿主不接受包含 signature 的包；不要声称此能力已随旧版发布。

独立版本：作者工具包候选 npm SemVer **1.2.0**；桌面 Script Plugin **schemaVersion1/apiVersion1**；完整桌面扩展 **schemaVersion2/apiVersion2**；显式素材 LocalTransport **consumerVersion1**。SDK 1.1.0 曾增加候选宿主的 AI、事件和多行字段类型与示例，不表示已有公开宿主或 npm 发布。API1 全局由宿主提供，没有 npm JavaScript LuckyRay 对象。1.0.1 把带输入的 call 参数设为必填，仅 data.get/ui.theme/materials.list/knowledge.selection 可省略空参数；空参数不能夹带 identity 字段。旧无效调用现在编译报错，不表示扩大宿主能力。

Script API1的完整已实现方法见index.d.ts及README。807基线已实现additive `materials.library.list/read`：materials.read保存授权之外，宿主还必须冻结materialLibraryId和本次selected IDs。输入包含libraryId/requestId，返回consumerVersion1+相同身份及已授权素材；不枚举全库、不授予原文件访问。老API1宿主可能没有这两个additive方法，会plugin-method-unavailable；应明确不支持，不回落默认库。legacy materials.list/read按既有scope工作。候选宿主另增加需要授权和本次模型选择的 `ai.generate` 与流式调用；老宿主不支持。没有Script import-bytes、视觉/相似检索或任意网络能力；不能从新Desktop内部功能推断公共方法存在。

候选宿主的事件能力仅在软件进程存活期间订阅已明确选择的笔记或素材库；覆盖主界面笔记创建/追加/插入/保存，以及具明确库 ID 的主界面素材路径、字节、文件夹和库根导入。只在成功后入队，不回放历史。插件自身领域写入不产生这些通知，事件回调也不允许领域写入或再次订阅；队列有上限，最多投递一次，停用/卸载会清理。旧宿主不支持该扩展。

Classic `material-library-consumer.js`/types另属生产者094冻结的宿主transport适配器。原JS/types不改：由可信宿主提供已验证request，脚本自身不取凭据，不是LuckyRay.call授权，也不是普通插件从npm获得的网络通道。显式select libraryId、冻结operation及完整requestId/body、late/current身份、read generation语义保持。消费者不能把库列表当授权或用UI当前库改写已准备目的。无自动重试/legacy fallback；unknown先核对原目标。生产者可能支持人工明确原操作的严格同ID/body回执检查，但这不意味着可盲重试/换ID或对失败ID改body。组织warning/partial已提交、atomic=false，需检查分类，不再导入。

未知优先于零写错误白名单：已验证HTTP状态与精确code只能证明当前首次attempt；root.writeOutcome、error.writeOutcome或V1 error.details.writeOutcome任一unknown都保留核对保护。经典consumer.save绑定original libraryId/requestId/current但会重包Error，并不保留任意details；宿主transport必须在包装之前保存/判定unknown，不能依赖重包后的Error恢复该标记。交付不提供泛4xx安全重试助手。

原生store的包规则：ID3–80小写ASCII/数字/点/减号，首位小写且无连续点；name非空白、≤160 UTF8 bytes无control；version/minHostVersion三段数字，各≤9位且无前导零；模块数组总≤16且名称小写/减号≤40 bytes，permission所属模块须在required或optional中声明。合法模块名不代表宿主支持：required未知模块在安装兼容检查失败；optional未知模块不赋权。CLI只检查语法/封包，原生兼容/permission/object/write-confirmation仍是权威。

严格字段；dataVersion正u32；permissions总≤16，候选宿主在既有八项上新增 `ai.generate` 和 `events.subscribe`；贡献1–16，唯一ID1–64 ASCII字母/数字/减号，label非空≤120 UTF8 bytes无control，kind command/menu/panel/settings/page；JS非空≤120000 bytes，包序列化≤128KiB。page是EXT-PAGE能力，旧无EXT-PAGE宿主会拒绝，不因为apiVersion1或minHostVersion数字就保证支持。更新同ID须提高版本；新增required或optional权限清consent，重审后启用；数据保留，不自动重置。

代码/资料隔离：只可用本次授权对象和自有data，单领域无需被迫连接另一领域。跨域领域写入必须显式模块/可选权限+本次对象+write确认；selected knowledge不等于允许创建。data.get/set、ui.theme、log为固有能力；自有data.set不需要领域grant/对象写确认，仍受数据/revision/lifecycle校验。SDK不能创建grant/修改scope/跨插件数据/遍历用户资料。关闭/超时后已接受write可能仍提交，宿主记录才是事实。GUI/native Broker/domain结果若本批未实际执行，一律NOT_RUN，受控RPC拒绝只是消费者错误处理证据。


## Desktop API 2 candidate

SDK 1.2.0 adds `runtime: desktop` authoring and `manifest.type=desktop / schemaVersion=2 / apiVersion=2` packages. API 1 remains available. API 2 requires a host containing this implementation; version 1.9.8 alone does not establish that capability, and older hosts reject the new type. No automatic migration of script plugins or claim of Obsidian plugin compatibility is made.

Full-trust UI runs in the main application realm, not an isolated security boundary. Native process and no-replace rename currently target Windows. Native checks and real desktop acceptance are required before publishing. See DESKTOP.md for per-feature limits and lifecycle rules.
