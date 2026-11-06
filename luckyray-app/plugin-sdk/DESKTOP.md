# LuckyRay 完整桌面扩展（API 2）

这是社区开发者扩展宿主的接口，不是预制表单插件，也不是 Agent 专用框架。
旧 API 1 的轻量脚本、主题包和模板继续保留。API 2 是另一种**运行模式**，使用同一个安装注册表、发布者验证、启停和更新入口，不另建社区或数据平台。

## 信任模型

完整扩展作为应用代码运行在主界面，可以构建自由 DOM/CSS/React 界面，访问用户资料、联网、运行本机程序并影响应用行为。这**不是沙箱**，manifest 和原生 lease 不能隔离同一主界面中互相恶意的扩展。当前候选只在主窗口启动扩展宿主；独立工作区窗口入口已撤回，不应假定扩展会在其他窗口运行。

安装不执行代码。用户明确选择“信任并启用”后才激活；每次内容更新清除信任并停用，即使发布者签名相同也须重新确认。标准 API 在停用后清理页面、样式、命令、订阅、编辑器扩展及自有原生资源。恶意代码自行建立的全局副作用无法可靠撤销，用户须先保存工作、正常退出并重开软件，才能彻底终止旧代码。

API 2 不自动安装程序、不自动下载依赖，不向扩展回传宿主模型密钥。扩展可以通过宿主代发接口调用已配置模型，可能产生供应商用量或费用。扩展自身代码、网络目的地与外部运行程序由用户判断是否可信。许可和开源不等于安全审计。

## 开始开发

使用同一个 CLI：

    lr-plugin create ./my-extension --desktop
    lr-plugin check ./my-extension
    lr-plugin pack ./my-extension

生成包仍为 `.lrpack.json`，从社区的本地安装入口选择。可使用现有 `sign-package.mjs` 签名；签名覆盖完整 manifest、JS、CSS 和静态资源，不代表平台为作者背书。

`plugin.json` 的新增字段：

- `runtime: "desktop"`；其余 id/name/version/minHostVersion 与现有规则一致。
- `entry`：包内自包含 ESM 文件，默认 `main.js`，导出 `activate(api)`，可选 `deactivate()`。
- `style`：可选包内 CSS 文件。
- `assets`：可选映射，例如 `{"logo":{"file":"assets/logo.svg","mimeType":"image/svg+xml"}}`。
- `contributions`：页面等稳定入口；主区/导航栏页面应列为 `kind: "page"`。运行时注册的 id 必须与声明一致，用户可控制是否显示导航入口。

作者使用自己的构建工具将依赖打成一个 ESM bundle。不要在运行时依赖包目录相对 import 或 Node require：Blob 模块不是磁盘目录，Node 不在主界面里。静态文件使用 `api.assets.url(name)`。完整包最多 16 MiB；拒绝路径逃逸和 symlink。轻脚本仍维持原来的小包限制。

类型从 `@luckyray/plugin-sdk/desktop` 导入，仅用于编译。`api.modules.React/ReactDOM` 提供宿主实例；编辑器必须使用 `api.editor.modules`，避免打入另一份 CodeMirror 导致扩展实例不兼容。第三方复杂 UI 库可自行打包，不需要宿主新增表单组件。

## 开放能力

### 界面、命令与主题

- `workspace.registerView({id,title,mount})`：拿到真实 DOM 容器。mount 可返回或异步返回 cleanup。
- `workspace.openView(id, "main" | "left" | "right" | "modal")`：主区页面或独立侧面板/浮层；左右面板是宿主挂载槽，不冒充现有笔记分屏或任意拖动 Tab API。
- `workspace.closeView(id)`、路由变更订阅。关闭视图不会自动停用后台扩展。
- `commands.register`：进入实际命令面板，支持应用内快捷键；冲突拒绝，默认不抢输入框，遵守宿主模态隔离。不是系统全局热键。
- `commands.executeHost`：调用已有宿主命令。宿主未就绪或被模态窗口阻断会明确失败，不静默成功。
- `menus.register("editor" | "materials", ...)`：加入实际编辑器或素材右键菜单。
- `theme.addStyle`：自由 CSS，可影响整个宿主；停用移除本接口建立的样式。`theme.get` 只返回外观模式和主题 token，不暴露设置和密钥。

### 笔记编辑与渲染

- `editor.current/list`：当前已挂接编辑器和真实 EditorView。
- `editor.registerExtension(factory)`：CodeMirror 6 extension，通过宿主 Compartment 装卸。使用同一份模块；保留宿主撤销、dirty 与保存体系。
- `editor.onChange`：打开/关闭、正文和选区变化。回调不能无限循环写入，作者负责过滤自己产生的修改。
- `markdown.registerCodeBlock(language, renderer)`：阅读视图的交互代码块渲染，注销或失败恢复普通源码展示。实时预览内的自定义表现使用 CM6 extension。

### 业务数据

- `knowledge`：读取、查询、创建、追加、插入、替换、移动、删除、索引和反向链接。复用当前宿主知识库服务及 source/revision 冲突保护；对编辑中的正文优先用 EditorView transaction，不直接写磁盘绕过 draft。
- `knowledge.index()` 首次读取会为当前库建立索引，可能需要等待；已有索引时可返回上次快照，后台刷新不必完成。建索引期间切库会使旧请求失败，扩展应处理错误并重新选择目标。读取索引不会激活 UI 写入来源，来源未激活时写入会返回 `knowledge-source-inactive`。快照不是后续写入的锁或授权：两次调用之间用户仍可能切库。尤其 `knowledge.create` 跟随调用时的当前 UI 源，不能指定目标库；调用前核对快照不能让后续创建原子地绑定到那个库。
- `materials.library(libraryId)`：冻结目标库的读取/导入/修改接口，不跟随随后 UI 切库。顶层 `list/readMany/query/tags` 只是当前库便利接口；异步事件处理应使用显式库对象。
- `canvas`：已有保存文档的列表、读取、创建、带 revision/digest 的保存、改名和删除。不会绕过宿主 CAS。**不包含自定义 Canvas 节点类型或直接操作正在编辑的图**；冲突交回调用者，不自动覆盖/重试。
- `events.on("knowledge.saved" | "materials.imported", ...)`：真实提交之后的通知。只覆盖当前已接线的宿主入口，不能宣称所有 Collector/旧入口均被覆盖。素材通知最多带4096个ID并标记 truncated。
- 新版宿主为这两类回调提供第二个参数 `context`，其中 `context.knowledge.create/append/insert/replace` 与 `context.materials.library/importFiles/importFolder` 复用同一宿主业务接口，但保留该次事件的来源链。回调响应事件而写入时，请使用这些方法；即使等待 Promise 或定时器，链中已处理过事件的扩展也不会再次收到由该写入派生的通知。并发事件各自保持来源，不合并为一个链。独立操作仍可使用原 `api.knowledge`／`api.materials`，并正常接收事件。
- 旧 API 2 宿主只传事件载荷，`context` 可能为 `undefined`；扩展应先检查，缺失时跳过需要防循环的写入并提示需要新版宿主。API 版本号仍为 2，不能仅凭版本号推断有此参数。
- 旧接口保持可用：回调同步执行期间通过旧接口开始的写入仍可关联当前事件。**在 `await` 之后或脱离回调的旧接口写入不能自动关联来源，可能产生循环**，应改用本次 `context`；停用后持有的 `context` 写入会被拒绝。原始 `EditorView` 事务之后的自动保存目前也不带扩展来源，作者须自行避免回写循环；此 API 是完整信任代码，不约束绕过宿主业务接口的操作。
- 其他 `events.on` 名称直接订阅 Tauri 事件，仅已文档化名称是稳定合同。
- `storage.read/write`：本扩展的 settings/cache，带 revision 和 dataVersion；API 2 每包最多8MiB。读出的 revision 应加1后写入；冲突不重试覆盖。

例如，事件后的异步追加应使用该事件自己的 `context`，并自行处理目标或版本变化导致的失败：

```ts
await api.events.on<{documentRef: NoteRef}>('knowledge.saved', async (event, context) => {
  if (!context) return; // older API 2 host: do not start an unguarded write
  const addition = await prepareAddition(event.documentRef);
  if (addition) await context.knowledge.append(event.documentRef, addition);
});
```

`prepareAddition` 代表扩展自己的异步计算。对素材导入同样使用 `context.materials.library(libraryId).importAssets(...)`；目标库仍由调用者显式冻结。

轻脚本事件是有界、最多一次通知，繁忙/满载/执行失败可能丢失，不保证每次保存都执行，不历史回放、不自动补发。本候选补上溢出 token 回收和订阅代际隔离。

### 联网、文件与本机进程

- `ai.generate(prompt,{signal,onChunk})`：宿主代发到当前配置的模型，可流式输出和取消；返回文本，不返回凭据。此 API 不提供每次调用单独选择模型的参数。信任提示包含调用模型可能产生费用；取消本机请求不保证供应商撤销已发生的处理或费用。验收使用合成服务，不擅自调用付费模型。

- `network.request`：真实原生 HTTP(S) 请求，支持方法、调用者自己的 headers/body、timeout 和 AbortSignal。响应 body 是 **base64**，最大16MiB；不会自动跟随重定向或添加宿主密钥。浏览器 fetch/WebSocket 仍是可信界面可使用的平台能力，浏览器 fetch 受 CORS 限制。
- `files`：绝对路径文件字节读写（base64）、目录列表/创建、改名和删除。单文件16MiB，默认写入不覆盖；需要覆盖须显式传 overwrite。不是数据沙箱，也不承诺通用文件写入是事务。LuckyRay 管理的数据应优先走业务 API。
- `process.spawn`：明确 executable/args/cwd/env，不隐式经过 shell。返回 opaque handle，支持 stdin、stdout/stderr、真实退出码、关闭输入、kill。
- Windows 创建时就进入自有 Job，kill 只针对本接口拥有的 Job，不接受任意 PID。输出有序号、base64、溢出标记；输出超限会终止该 Job。退出码和完整 Job/读取器收尾分别返回。
- 需持续 poll 读取输出，观察 settled 后回收活跃槽位；最多16个未收尾句柄。主进程退出、整个 Job 没有活动进程且输出读取结束后，宿主记录观察到的完成顺序；已经 poll 收尾的结果按该顺序保留最近128个，与轮询顺序无关。尚未 poll 收尾的任务仍占槽并保留输出。完成时间极接近的作业可能因系统调度交换观察顺序，这不是操作系统精确的完成时间；不保证无限保留历史 handle。
- **当前本机进程和无覆盖改名实现以 Windows 为目标**。其他桌面平台返回明确 unsupported，不能标为已经跨平台验收。其他平台负责人以后接入对应原生实现；本次不修改其开发分支。

后台指应用运行期间的扩展生命周期。并不创建退出软件后仍运行的服务、开机项或系统守护程序。

## 生命周期约定

`activate(api)` 可返回 cleanup；API 注册返回 disposer，并自动属于本次 package digest/epoch。`lifecycle.add` 可登记自有资源清理，`lifecycle.setInterval` 的计时器随停用停止。不要把 Promise 未完成当成可跳过清理的理由。

更新或停用期间迟到的激活、页面挂载和订阅不得重新获得旧身份。每轮视图容器独立，旧异步 mount 不会清掉新视图。编辑器注册表的重命名和状态重建有组件级检查；当前候选撤回了独立工作区窗口入口，不能据此宣称日常界面中的迁窗便携快照恢复已验证。

## 验收与明确非目标

本接口不是 Obsidian 二进制兼容层，不承诺直接安装其插件。此批交付的是通用宿主扩展能力，样例仅验证接口，不代表社区内容已经齐备。

必须由接入执行者完成真实 Windows：安装未执行→信任启用→自定义页面/菜单/快捷键→笔记和素材真实读写→本机子进程和联网→停用/更新/重启→旧轻脚本兼容。模拟后端和 DOM 检查不是原生验收。未经验证不能合主开发、发正式版或 npm。
