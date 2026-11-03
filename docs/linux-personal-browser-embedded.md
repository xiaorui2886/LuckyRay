# PersonalBrowser 内嵌宿主的 Linux 摸底与设计（T29，文档；未改产品代码）

状态：**设计稿**。本文记录 Windows v1.9.9 的 PersonalBrowser 行为（源码行号为证）、Linux 现状、X11 首个实现切片的设计与验收方式、以及需要用户拍板的 Wayland 选项。**本任务没有实现任何产品代码**。

## 1. Windows v1.9.9 行为（源码为证）

| 方面 | 行为 | 证据 |
|---|---|---|
| 两种模式 | **独立模式**：broker 启动独立宿主 exe（`HostProcess::spawn(&self.host_path,…)`），父进程经 stdin/stdout 帧协议通信；**内嵌模式**：WebView2 **在主进程内**创建，子窗口嵌进 LuckyRay 窗口 | `browser_broker/mod.rs:154-181`（`open_personal` → `HostProcess::spawn`）、`:183+`（`open_personal_embedded`）、`browser_broker/poc_client.rs:1-8`（"standalone R4-A2 host POC"，feature 门禁、不是 Tauri 命令、绝不接受调用方给的 exe 路径） |
| 嵌入方式 | `CreateWindowExW` 建 `WS_CHILD|WS_CLIPCHILDREN|WS_CLIPSIBLINGS` 子窗口 → `ICoreWebView2Controller`（COM `APARTMENTTHREADED`）→ `SetWindowPos` 按视口定位；父窗口 HWND 由 Tauri 命令传入 | `browser_host_poc/mod.rs:1376-1378`（imports）、`:2033`（`WS_CHILD…`）、`:1836`（`SetWindowPos`）；`lib.rs:3678-3685`（`caller.window().hwnd()` → `parent_window: isize`） |
| 入口命令 | `browser_personal_open(viewport?)`：`(Some(viewport), Some(parent))` → 内嵌；`(None,None)` → 独立；混合 → `browser-viewport-unavailable`；**Linux 上 `parent_window` 恒为 `None`（cfg），内嵌模式结构性不可达** | `lib.rs:3674-3701` |
| 生命周期 | broker 持 per-session 状态（`BrowserProcesses`，session_id → `HostProcess`），navigate/close 带 `expected_generation`（代际校验，防旧回调）；打开时先 `try_wait` 复活检查再复用或重建 | `browser_broker/mod.rs:22-58`、`lib.rs:3703-3720`（`browser_personal_navigate`）、`:183+`（embedded 里 `retain(… try_wait …)`） |
| 崩溃/退出 | `add_BrowserProcessExited` 事件（两处：fixture 与 production）+ `Controller.Close()`/`DestroyWindow` 的 Drop 清理；profile 目录用 `ProfileLease(HANDLE)` 持有（独占租约） | `browser_host_poc/mod.rs:2181-2182`、`:3397-3398`、`Controller`/`ProfileLease` 的 `impl Drop` |
| 配置目录 | broker `initialize(app_data)` 建 app-data 目录（`browser-app-data-unavailable`）；WebView2 user-data folder 在 `FOLDERID_LocalAppData` 下按 profile 隔离 | `browser_broker/mod.rs:120-121`、`browser_host_poc/mod.rs:1384-1390`（`SHGetKnownFolderPath(FOLDERID_LocalAppData)` imports） |
| broker/扩展/native-messaging | broker 只管 PersonalBrowser 会话；扩展与 native-messaging 走 `local_transport`/`native_messaging`（T19/T21），与 PersonalBrowser 无共享状态；`poc_client` 是 R4-A2 独立宿主的内部父子通道 | `browser_broker/poc_client.rs` 头注释 |
| 用户可见文案 | 全部 `browser-host-*` 错误码，前端 `BrowserPage.tsx:426-432` 映射（`error.unavailable`/`error.terminated`/`error.embed` 等） | `browser_host_poc/mod.rs`（`browser-host-close-incomplete`、`-com-unavailable`、`-controller-unavailable`、`-environment-unavailable`、`-navigation-failed`、`-page-probe-failed`、`-platform-unsupported`、`-profile-unavailable`、`-readiness-probe-failed` 等）+ `BrowserPage.tsx:426+` |

## 2. Linux 现状对照表

| 方面 | Windows v1.9.9 | Linux 现状 | X11 对等做法 | Wayland 下的问题 | 新依赖 |
|---|---|---|---|---|---|
| 独立模式宿主 exe | `HostProcess::spawn(host_path)`，stdin/stdout 帧 | `exact_browser_host_path()` 在 Linux 上无产物 → `browser-host-platform-unsupported` | 打包阶段出 Linux 宿主 exe（WebKitGTK 版），用 `owned_process::spawn_in_owned_job`（进程组）替代 Windows 的归属方式 | 同左（进程归属与显示无关） | 无（webkit2gtk 已在 Cargo.lock） |
| 内嵌 | WebView2 子窗口 + COM 控制器 | `open_production_webview` 直接 `browser-host-platform-unsupported`；`lib.rs` 里 `parent_window=None` 使内嵌结构性不可达 | 复用 DSH native surface 的既有接缝（`dsh_native_surface_linux.rs`：主窗口 GtkFixed/Overlay 上加 WebKitGTK 子 webview，`set_bounds` 定位）——**同一主窗口已验证的嵌入路径** | WebKitGTK 子 webview 在 Wayland 下作为子表面通常可行（同进程 GTK 窗口内），但跨进程嵌入不行；边界/输入法行为需实测 | 无 |
| 生命周期 | broker 代际 + `try_wait` 复活检查 | broker 代码平台中立，已编译进 Linux（状态机可用），只是底层宿主不可用 | 不变（复用 broker） | 不变 | 无 |
| 崩溃/退出清理 | `BrowserProcessExited` 事件 + Drop 清理 + ProfileLease | 无宿主，无从谈起 | WebKitGTK 子 webview 在主进程内：退出即随进程消失；独立 exe 模式用 `owned_process`（组 SIGKILL + 等待组静默，T19/T23 已验证） | WebKit 网络进程是 App 的子进程，App 死亡后其 IPC 断开而退出；独立 exe 同左 | 无 |
| 配置目录 | app-data + LocalAppData user-data folder | app-data 目录 broker 已创建 | user-data folder 放 app-data 下（WebKitGTK `data_directory`），按 profile id 隔离 | 同左 | 无 |
| 错误文案 | `browser-host-*` | 前端映射已就绪（`BrowserPage.tsx:426+`）；Linux 现在只会看到 `browser-host-platform-unsupported` | 实现后沿用同一批码；新增码只能是更细的（如 `browser-host-graphics-unavailable`） | 同左 | 无 |

## 3. X11 首个实现切片（设计）

**切片范围**：只做**内嵌模式**的 Linux 最小闭环 —— `browser_personal_open(Some(viewport))` 在 Linux 上创建一个 WebKitGTK 子 webview（独立 user-data 目录、指定 URL），放进主窗口 overlay 并按 viewport 定位；navigate/close 复用 broker 状态机。独立模式（宿主 exe）等打包，保持 `browser-host-platform-unsupported`。

**要点**：
1. 新模块 `browser_host_linux.rs`（Linux-only，`mod` 由 `lib.rs` cfg 声明）：照 `dsh_native_surface_linux.rs` 的 overlay 接缝创建 `webkit2gtk::WebView`，`data_directory` = `app_data/personal-browser/<profile_id>`（绝不复用 DSH/主 webview 的目录）。
2. 安全边界照抄 DSH surface 的先例：子 webview 不进主 DOM、不接受 IPC 权限、导航范围校验（与 Windows 的 navigation denial 一致）。
3. **验收（CI 真实 UI 冒烟，证明"嵌在窗口里"而非外部窗口）**：
   - 前置：`browser_personal_open` 前，用 App 内 debug-only 命令（或 GTK `Window::list_toplevels()`）记录本进程拥有的顶层窗口数与 webview 子控件数；
   - 打开后断言：①顶层窗口数**不变**（没有出现第二个顶层窗口——外部模式必然多一个）；②overlay 的子控件列表里出现新的 WebKitGTK WebView，且其分配边界 == 请求的 viewport；③WebDriver 截图对该 viewport 区域采样，出现源页面独有的已知内容（T11 的像素采样先例）；
   - 关闭后：子控件消失、顶层窗口数回到基线、user-data 目录留存（配置不丢）。
4. **进程残留保护**：内嵌模式无独立进程（WebKit 子进程随 App 进程组消亡）；独立 exe 模式必须走 `owned_process::spawn_in_owned_job`（进程组 SIGKILL + 组静默等待，T19/T23 已验证），并考虑 `PR_SET_PDEATHSIG`——任何这类 libc 代码必须先在 `/workspace/linux-port/probes/` 下独立 crate 编译并真实运行（像 T26 的 exdev probe 一样）。
5. 错误码：复用 `browser-host-*`；新增只能是更细（例如拿不到 overlay 时 `browser-host-overlay-unavailable`），文案以「未做任何修改」结尾。

## 4. Wayland 选项（需要用户拍板，本任务不选）

| 选项 | 做法 | 代价 | 与 Windows 行为差异 |
|---|---|---|---|
| W1 强制 XWayland | 启动时设 `GDK_BACKEND=x11`（仅 LuckyRay 自己），内嵌走 §3 的 X11 路径 | 失去原生 Wayland 缩放/IME 的部分行为；桌面会话必须装 XWayland（绝大多数发行版默认有）；App 自身的其它窗口也变成 X11 | 视觉与交互基本对齐；最接近"完全对齐" |
| W2 降级外部窗口（现状） | Linux 永远走独立模式/或保持不可用 | 没有内嵌体验；用户看到独立浏览器窗口 | 与 Windows 差异最大（无 viewport 集成） |
| W3 Wayland 子表面方案 | 研究 GTK4/zwlr foreign-toplevel 或让 WebKitGTK 渲染进子表面 | 工程量大、合成器行为不一致、IME/输入未定；风险与收益比最差 | 不确定能对齐 |
| W4 混合：XWayland 会话自动内嵌、纯 Wayland 会话自动外部 | 运行时探测 `GDK_BACKEND`/`WAYLAND_DISPLAY` + `XDG_SESSION_TYPE` | 两套行为并存，QA 面翻倍；用户在不同会话下看到不同形态 | 部分对齐，行为可预期性差 |

**没有替你选**。若选 W1/W4，§3 的切片可直接用；若选 W2，Linux 保持现状并把内嵌命令显式返回一个更明确的码即可。

## 5. 还缺什么

1. Windows 侧的精确行号引用在实现前应再核对一遍（本文的行号取自当前 `a5fd973…72ce119` 线）。
2. §3 的切片实现（新模块 + 命令接线 + 冒烟）是下一个任务；其中任何新 libc（`PR_SET_PDEATHSIG` 等）必须先过 probe crate。
3. 独立模式宿主的 Linux 打包（node/WebKit 运行时）未规划，属安装包范畴。
