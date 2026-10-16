# LuckyRay 素材 MCP — 开源候选 0.1.0-candidate.4

## 推荐：LuckyRay 桌面界面连接

包含本轮桌面接线的候选中，进入 **设置 → 存储 → 连接 AI 客户端**，选择 Codex 和素材库，审阅配置位置与权限，然后勾选确认并点击 **授权并连接**。无需复制 JSON、运行终端或自行安装 Node。应用复用随包分发且校验 SHA-256 的 Node 22.19.0，只复制通用 Node 运行时和此素材客户端，不安装 LSH/Gateway 权限。

在 Codex **设置 → MCP 服务器** 找到界面显示的 `luckyray_materials_…` 条目，重启该服务器；开始新任务使用。LuckyRay 的“测试连接”验证桌面接口，不冒充客户端已经加载。Codex 的组织策略、远程执行和自定义配置覆盖可能限制此入口；首批只支持 Windows 本机标准用户配置。

撤销：回到此页点击 **撤销授权并移除连接**。这会先拒绝后续请求，再移除本功能的配置条目和加密配对文件，其他客户端设置保持不变。若有人手改了此条目，拒绝覆盖并提示在 Codex 中移除它；私有回退副本只留本机。已启动客户端按其自身生命周期结束 stdio 进程，无后台服务/自启动。

新 GUI 配对采用 profileProofVersion=2：原 profile/数据库物理路径由数据所属桌面检查，路径与 EXE 纳入随机挑战 HMAC；客户端在发送 bearer 前验证，且不得回退 v1。这样 MSIX 客户端不需要打开数据库，也不会误用其 LocalCache 映射。旧 v1 配对继续保留原本的客户端路径保护。

**以下 npm/PowerShell/JSON 内容仅供高级手动排错，不是 GUI 用户步骤。**

Windows + Node.js >=22 + Windows PowerShell 5.1。本地 stdio 客户端按需启动；没有服务、自启或公网监听。源码采用根目录 MIT，尚未在 npm 发布；这不自动创建配对或授权。

## 功能与兼容

只有 connection_status、search_assets、get_asset、list_folders、import_file 五个工具。使用正式导入器保留名称、类型、SHA-256 去重、assetId；不访问数据库，不带 LSH、终端、调度或私人 Gateway 管理能力。

**只支持 materials-mcp-scoped-v1。** 服务端将权限固定到配对时的单一库，不跟随 UI 当前库；30 天到期，在桌面撤权。candidate.1 的 native 授权读取已删除，不提供回退。

|环境|要求或状态|
|---|---|
|Windows 本地 stdio 客户端|一次配置，使用时自动启动，断开关闭进程|
|LuckyRay 桌面|需包含专用 materials-mcp-scoped-v1 协议、GUI 配对与物理 profile 身份证明；本仓库候选源码已包含|
|旧桌面/缺专用授权|明确拒绝，不读取旧 native 凭据|
|Codex MSIX|新 GUI v2 配对由桌面证明原 profile；旧 v1 配对仍会拒绝客户端路径重定向|
|网页 ChatGPT|仍需官方隧道与真实网页验收，不能使用 localhost/stdio 代替|
|macOS/Linux|当前不支持本机实例验证|

## 安装、一次授权与安全配对

1. 从已核对的源码运行 `npm pack --ignore-scripts`，记录 tgz SHA-256，在专用安装目录执行 `npm install --ignore-scripts --no-audit --no-fund <tgz绝对路径>`。不要从不明来源复制配置或凭据。
2. 在目标 LuckyRay **设置 → 存储 → 素材 MCP 授权**，选择一个合成测试库，客户端命名为你信任的本地客户端，确认搜索、读取、文件夹读取和导入四项权限。30 天到期，可随时撤权。不要选择日常真实资料库进行本轮导入验收。
3. 在**普通 Windows PowerShell**运行下面的入口。Destination 必须是新的本地私有目录，不要放进项目、Git 或同步盘。它会明确询问是否保存本机绑定；不自动授权桌面。

```powershell
powershell.exe -NoProfile -STA -File "C:/YOUR_INSTALL/node_modules/@luckyray/materials-mcp/src/Pair-MaterialsMcp.ps1" -Destination "C:/YOUR_PRIVATE_BINDING"
```

4. 在桌面复制一次性配对 JSON，在本机配对小窗点击 **Import pairing JSON from clipboard**。不用把多行 JSON 粘贴进终端；不会显示密钥。确认显示的客户端、库、EXE、profile 和到期时间。成功后只清除此份仍未变化的剪贴板内容。
5. 生成 `connection.json` 和 `credential.dpapi`。整个配对对象由 Windows 当前用户 DPAPI 加密，目录 ACL 限制为当前用户；公共配置改动与加密身份不一致时拒绝。密钥不进入参数、stdout、错误或 Git。不能迁移到其他电脑/用户，要重新正式配对。
6. 把下面配置加入支持 stdio 的客户端，替换路径。客户端配置内没有密钥。

```json
{"mcpServers":{"luckyray-materials":{"command":"C:/Program Files/nodejs/node.exe","args":["C:/YOUR_INSTALL/node_modules/@luckyray/materials-mcp/src/server.mjs","--config","C:/YOUR_PRIVATE_BINDING/connection.json"]}}}
```

检查在线状态：`node <安装目录>/src/server.mjs --config <私有目录>/connection.json --check`；也可运行包内 Check-MaterialsMcp.ps1，传 -ConfigPath 和 -Pause。它明确显示 ONLINE 或错误状态。客户端日常按需拉起，无需额外常驻窗口。

## 真实验收（需用户明确同意导入）

包内 Run-Acceptance.ps1 使用**实际 stdio 子进程**，只有输入 YES 才导入两份公开测试文件（固定 scanny/python-pptx 提交中的 PNG 6111 字节和 minimal.pptx 15802 字节）。它不会修改 Main 源码、重启桌面或删除素材。来源见 examples/acceptance-fixtures.json；本包不捆绑这些第三方文件。

```powershell
powershell.exe -NoProfile -File "C:/YOUR_INSTALL/node_modules/@luckyray/materials-mcp/src/Run-Acceptance.ps1" -ConfigPath "C:/YOUR_PRIVATE_BINDING/connection.json" -ReportPath "C:/YOUR_PRIVATE_BINDING/import-receipt.json"
```

检查配对/搜索/文件夹 → PNG/PPTX 导入 → inspect 和搜索回查原名/kind/assetId → 重复导入同 assetId。报告不含密钥。首次如果库里已存在同内容不同名称的文件，去重正确但名称断言可能失败，需按已有素材解释，不能为测试改写原名。

随后在桌面正式入口撤销该客户端，再运行同一命令加 `-ExpectRevoked`、另选新报告名；必须得到 not-authorized。需要继续使用时由用户重新正式配对到新的私有目录。新 stdio 进程会重新核对 PID、端口和 proof。实际桌面重启/端口变动须另做真实验证，合成测试不能替代。

## 保护与故障

每次请求先核对 EXE/PID/创建时间、物理 profile、配对到期和当前进程所拥有的 transport 端口，再调用无 bearer 的 materials/proof。HMAC 绑定 clientId/libraryId/expiry/port/两个 nonce，验证后复核进程才发送凭据；端口变化只在同一明确 EXE 的监听中重新证明，不跨 profile 搜索。配置与已加密配对身份也必须一致。

下载只允许公共 HTTPS 443、无用户口令/fragment/IP 字面量/私有域名，文件名严格校验。桌面正式下载器继续执行每跳 DNS/重定向目标检查、64MiB/120秒/3跳限制。ZIP 单文件保存，不自动解压。导入超时可能已提交，应先搜索核对，不盲目重试。

- scoped-pairing-required：旧配置不可用，使用桌面正式配对。
- authorization-unavailable：当前 Windows 用户无法解密、文件缺失或 ACL 过宽；不要复制其他用户凭据。
- pairing-binding-mismatch：公共配置与加密配对不一致，使用原配置或重新正式配对。
- pairing-expired / not-authorized：已过期、撤权或主密钥轮换，需显式重新配对。
- target-not-running / target-ambiguous：所选实例未运行或同路径多实例；不自动换实例或杀进程。
- profile-identity-unverified：物理路径保护拒绝（包括 MSIX 重定向），从普通 Windows 客户端运行，不复制数据库。
- wrong-instance / target-changed：身份证明失败或进程变化，本次拒绝发送业务请求。
- version-unsupported：目标桌面缺专用协议/接口，由桌面维护者更新。
- import-outcome-unknown：可能已入库，先查结果；response-library-mismatch：回执库不匹配，停止并调查。

## 卸载与回退

先在桌面撤销授权，客户端禁用此 MCP 并关闭连接，运行 `npm uninstall @luckyray/materials-mcp --ignore-scripts --no-audit --no-fund`，最后自行删除专用配对目录。进程随 stdio EOF 退出，没有服务需要卸载。不删除桌面素材或 profile。保留 candidate.1 仅作历史源码回退点，**不要恢复其广权限 native 连接方式**。

## 验证边界

安装/真实 stdio 生命周期、合成授权契约、安全负例、DPAPI/ACL 往返单独记录。尚无用户正式授权时，真实配对、PNG/PPTX E2E、撤权和网页链路必须记为未验收。测试通过不等于普通用户真实导入通过。
