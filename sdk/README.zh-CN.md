# LuckyRay 插件 SDK 入门（中文）

LuckyRay 插件 SDK 让你用**纯 JavaScript** 为 LuckyRay 桌面应用编写可安装的功能插件。插件代码运行在宿主提供的受限引擎里：没有 DOM、没有网络、没有文件系统和 Node 接口，只能通过本 SDK 公开的方法访问用户**明确授权**的数据。本目录（SDK）可独立使用；你只需要 [Node.js](https://nodejs.org) 来开发和打包。

## 五分钟上手

下载或克隆本仓库，安装 Node.js 18 或更高版本，然后从仓库根目录执行：

```sh
cd sdk
# 1) 用脚手架新建一个插件项目（新目录，不能已经存在）
node cli.mjs create ../my-plugin

# 2) 编辑 my-plugin/plugin.json（id/名称/权限/入口声明）和 my-plugin/main.js（逻辑）

# 3) 静态检查（只解析不执行你的代码）
node cli.mjs check ../my-plugin

# 4) 打包，得到 ../my-plugin/<id>.lrpack.json
node cli.mjs pack ../my-plugin
```

生成的 `.lrpack.json` 就是安装包，把它交给用户即可。

## 安装到 LuckyRay

在 LuckyRay 桌面应用中：**社区 → 扩展/插件 → 功能插件 → 「安装本地插件」**，选择 `.lrpack.json` 文件。之后：

1. 卡片会显示**待授权**：逐项查看权限说明（中文），勾选同意的可选权限后点「保存授权」
2. 点「启用」。更新时选新包，**版本号必须严格升高**（如 1.0.0 → 1.0.1）
3. 通过卡片上的入口（命令/菜单/面板/设置）或右下角「插件」菜单打开使用

## 插件长什么样

`plugin.json` 声明身份与能力：

```json
{
  "id": "example.my-plugin", "name": "我的插件", "version": "1.0.0",
  "requiredModules": ["materials"], "optionalModules": ["knowledge"],
  "requiredPermissions": ["materials.read"], "optionalPermissions": ["knowledge.create"],
  "dataVersion": 1,
  "contributions": [
    { "id": "run", "label": "运行", "kind": "command" },
    { "id": "settings", "label": "设置", "kind": "settings" }
  ]
}
```

`main.js` 注册唯一处理器。每次用户触发任意入口，宿主都**新起一个全新进程**执行它（全局变量不保留）：

```js
/// <reference path="./sdk.d.ts" />
LuckyRay.register(async event => {
  const data = await LuckyRay.call("data.get");      // 插件自有设置/缓存
  const assets = await LuckyRay.call("materials.list"); // 仅本次选中的素材
  return { title: "结果", text: assets.map(a => a.name).join("\n") };
});
```

返回的 `{title, text, fields, actions}` 由宿主用有界控件渲染（最多 8 个字段、8 个动作）；**不能**返回 HTML/DOM。`fields` 供用户输入，用户点你返回的 `actions` 后，同一处理器会再次被调用，`event.input.action` 是所点的动作 id、`event.input.fields` 带用户填写的值。

## 关键语义（容易误解的地方）

- **权限 ≠ 本次范围**。权限在卡片上保存一次；每次运行还要单独选择**本次**可访问的素材/笔记/画布，写入前还会再弹一次确认。范围之外的对象调用会得到 `plugin-object-denied`；未勾写入会得到 `plugin-write-confirmation-required`。
- **`objects.knowledge` 非空 ≠ 允许建笔记**。创建笔记是运行时的独立勾选项；未勾选时 `knowledge.create` 会被 `plugin-create-not-selected` 拒绝。把"创建"做成一个显式动作按钮，捕获该错误并提示用户勾选。
- **笔记标题就是文件名**：不能包含 `:` `/` `\` 等字符（`knowledge-invalid-title`）。参考样例用"标题 + 本地日期时间（HH-MM）"避免重名；重名会得到 `knowledge-name-conflict`。
- **设置入口打开即表单**：`kind: "settings"` 的入口不经过对象选择，宿主自动运行一次并直接显示你返回的 fields。处理 `save` 动作后**把保存后的值回显**在返回的 fields 里。
- **写入以宿主回执为准**。你 `throw`、返回非法 UI 或进程被中止，都不影响宿主已确认的写入展示给用户；也不要在你的文本里自称"已写入"。未收到宿主回应的写入会显示"结果未知"，此时**不要自动重试**。
- **每轮结果独立**。用户改了对象选择后，上一轮结果会标记过期；你的代码不应假设两次调用之间共享状态，需要状态就用 `data.get`/`data.set`（自有、限 64KiB、revision 必须 +1）。

## 宿主版本注意

`minHostVersion` 只是最低宿主要求的声明，**不等于**某个正式发布版本已经包含插件 API。SDK 1.0.0 的 API1 契约已与桌面 v1.9.4 的正式源代码核对；核对范围和未执行的实机检查见[兼容性说明](../docs/compatibility.md)。拿到 SDK 可以开发与打包，安装运行仍需要支持 API1 的桌面宿主。CLI 默认的最低版本声明不是旧版宿主的兼容性测试结果；安装包的公开状态见[下载说明](../docs/downloads.md)。

## 支持与不支持

**支持（V1）**：素材元数据/受限图片像素/标签写入；知识库笔记读取、独立授权的创建、受限追加；画布已保存结构读取与 SVG 导出；插件自有设置与缓存；命令/菜单/面板/设置四种入口；有界宿主渲染 UI。

**页面入口（EXT-PAGE，仅本宿主线）**：`kind: "page"` 的入口会作为主内容区真实页面打开（声明 `{ "id": "board", "label": "看板", "kind": "page" }`）。处理器每次返回同样的有界 `{title,text,fields,actions}`；页面打开时宿主自动运行一次，点击你返回的动作会再次运行；页面进入前进/后退历史（`#plugins/<包>/<页>`）；用户在社区卡片上按页开启"在侧栏显示"后，入口出现在侧栏"筛选"组末尾（宿主偏好、默认关闭、隐藏≠停用）。**旧宿主（无 EXT-PAGE）会在安装时拒绝含 page 入口的包**（`extension-invalid-contribution`）。仍不支持任意 HTML/DOM、后台常驻或自定义导航结构。

**不支持（请勿宣称或尝试）**：后台常驻服务、定时任务；任意网络访问、任意文件系统、命令执行、模型密钥；修改主程序行为或其他插件数据；手机端运行；插件市场/账号体系。

完整方法/权限表、尺寸与资源限额、错误码列表见 [README.md](./README.md)（英文）与 `index.d.ts`（类型定义）。

## 参考样例

`examples/` 下四个教学样例演示多种公开能力，均可直接 `node cli.mjs pack examples/<目录>` 打包安装：

| 样例 | 演示 |
| --- | --- |
| `material-manifest` | 素材分组清单、自有设置、可选创建笔记（带本地时间标题） |
| `palette` | 受限图片像素读取、可选写颜色标签 |
| `outline` | 笔记读取、创建关联提纲、追加写入 |
| `canvas-export` | 画布结构读取、宿主代管 SVG 导出 |

## 许可证

SDK 以 MIT 许可证发布（见 [LICENSE](./LICENSE)）；你的插件代码归你所有。

## 首次试用


首次试用先备份资料，通过软件正常界面建立仅含测试资料的小素材库与 Markdown 知识库。先预览、后显式确认写入，检查宿主回执和实际文件；卸载插件不会删除其已生成的用户笔记或导出文件。SDK 不包含桌面应用。
