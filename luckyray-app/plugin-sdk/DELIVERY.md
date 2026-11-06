# 独立 SDK 交付与消费者快速验证

本地候选，不代表已公开 npm/仓库/Release。工具包 1.2.0 候选提供类型、CLI、七个 API 1 示例和说明，另有 API 2 桌面扩展能力；Script API1 由 LuckyRay 受限 worker 注入。开发需要 Node.js>=18 及 npm；可选类型检查使用 TypeScript 5.8。不需要私有源码、凭据或 SDK 专属宿主分支。

## 收到tarball后，从一个空目录开始

以下命令仅安装本地包，不发布。将包路径替换为实际收到的文件，输出目录必须是新目录。

```sh
mkdir sdk-consumer
cd sdk-consumer
npm init -y
npm install --save-dev --ignore-scripts --no-audit --no-fund /path/to/luckyray-plugin-sdk-1.2.0.tgz
npx --no-install lr-plugin create ./hello
npx --no-install lr-plugin check ./hello
npx --no-install lr-plugin pack ./hello
```

`check`就是纯JS的静态构建检查（只解析、不运行开发者代码）；`pack`生成`hello/example.hello.lrpack.json`。编辑plugin.json时换成你自己的ID/name/version，改变已安装内容须提高版本。生成的`main.js`引用同目录的`sdk.d.ts`，而不是私有工程路径。CLI拒绝覆盖已有脚手架目录。

类型检查是可选作者步骤（不会赋予权限）：

```sh
npm install --save-dev --ignore-scripts --no-audit --no-fund typescript@5.8.3
npx --no-install tsc -p ./hello/jsconfig.json
npx --no-install lr-plugin create ./reader --template material-reader
npx --no-install tsc -p ./reader/jsconfig.json
npx --no-install lr-plugin check ./reader
npx --no-install lr-plugin pack ./reader
```

其他模板为 palette、outline、canvas-export、material-manifest、page-desk、event-ai。修改代码时须收窄 LRJson 中的 null/primitive/array，不能假定自有 settings/cache 永远是对象。page-desk 提供保存回显参考；material-reader 只做有限素材读取，知识创建仅由用户明确点击动作发起。event-ai 需要具备候选 AI/事件能力的宿主及单独的事件自动调用授权；示例使用固定合成提示，不用于默认消耗模型额度。

## 安装和调用不是同一个权限步骤

在支持API1的桌面宿主：社区→扩展/插件→功能插件→安装本地插件，选择生成的lrpack.json；核对权限、保存授权、启用，打开入口，在可信宿主UI选本次领域对象；领域写入还须本次确认。data.get/set、ui.theme、log为固有能力，自有data.set不需要领域授权或领域对象写确认，仍受自身数据/revision/lifecycle校验。hello不依赖任何业务模块；reader基本读取只需materials.read和本次素材，未连Knowledge仍能读；Knowledge动作要可选knowledge.create、选Vault及允许创建、本次写确认。拒绝是正常结果，不改投到另一库/接口。真实GUI安装和宿主数据落地另行验收，npm install/check成功不能替代。

material-reader捕获读拒绝并提示宿主检查；知识write只有一次call，unknown/timeout/retired均提示核宿主记录和原目标，不自动重试。Script API1不接受调用者自造requestId来取得重放保证。不要把插件文字当提交证据；宿主confirmed operations才是事实。错误原文可能为plain Error.message，不能假定总有JSON.details。

## 包与来源核对（交付者步骤，消费者不需要仓库）

从干净冻结提交导出到新目录（父目录已存在）：

```sh
node plugin-sdk/export-sdk.mjs ../public-sdk
cd ../public-sdk
npm pack --ignore-scripts --json
```

导出只含明确列出的公共文件和七例的 main.js/plugin.json，不夹带历史 lrpack、node_modules、宿主程序、测试 driver 或用户数据。MANIFEST.json 记录 formatVersion、sdkVersion、Script API/Desktop API/Consumer 版本、sourceCommit、sourceDirty 和逐文件 SHA256/长度。导出时会将 CLI 的 CRLF shebang 规范为 LF 后再计算哈希，避免 npm 安装时改写首行使已安装文件无法通过清单核对。候选须 sourceDirty=false 及准确 Git commit；unknown/null 意味着来源不可证明，不应包装成可追溯提交。MANIFEST 自身不自哈希，交付单另列整个 tarball SHA256。导出工具拒绝已存在目标；再导出已交付包会严格校验原 manifest，不把修改后的文件沿用旧来源。

不执行 npm publish。安装时可忽略 scripts，本包无 install hook/依赖下载。保留原 tarball/hash 和 MANIFEST；不要用一个已被修改的 SDK 目录替换冻结制品。

公开发布前需经独立审查，核实 MIT 许可及包含内容的授权、目标 npm registry 与 `@luckyray` scope 和包名归属、发布者账号的相应权限、版本号与发布渠道。由获授权的维护者在审查后决定发布；不得把本地 pack/install 说成已发布，也不在此申请或索取凭据。

## 验证边界

本交付的独立消费者回归从本地导出tarball/npm install开始，经已安装CLI创建、check、pack和TypeScript正/负用例；调用验证使用既有实际QuickJS worker的stdio通道，RPC由受控适配器回复。它证明真实worker执行消费者代码及可见拒绝/unknown处理，不证明原生Broker授权、GUI安装、真实Vault/PNG落地或普通浏览器activeTab。这些范围必须分列PASS/NOT_RUN，不重新运行旧采集矩阵来填SDK证据。


SDK 1.2.0 / API 2 is a source candidate. Local pack/export is not npm publication or Windows acceptance. Preserve the exact exported MANIFEST and source patch provenance; sourceDirty=true is not a clean release proof.
