# LuckyRay App

正式开发工程的第一版技术 spike。

## 当前目标

- 使用 Tauri 2 + React + TypeScript 建立正式工程骨架。
- 以仓库根目录的 `luckyray-ui.html` 为 1:1 UI 蓝本，不重新设计界面。
- 先迁移 LuckyRay 的应用外壳、素材库、知识库基础布局。
- 接入官方 Tauri dialog / sql / opener 插件，验证文件导入和 SQLite 写入路径。

## 常用命令

```powershell
pnpm install
pnpm dev
pnpm dev:desktop
pnpm build
pnpm tauri build
```

`pnpm dev:desktop` is the only full desktop-development entry. It launches
Tauri with the isolated `com.luckyray.desktop.dev` identifier, so its database,
Companion identity/pairings, DSH state, materials, knowledge, and settings stay
outside the production `com.luckyray.desktop` application-data root. A bare
`pnpm tauri dev` intentionally fails before Vite starts; `pnpm dev` remains a
frontend-only Vite command and does not open a desktop runtime.

`pnpm tauri build` is the standard Windows release-build entry. Its Tauri
before-build hook prepares the media runtime, all registered native sidecars,
and the frontend in that order; no separate sidecar command is required before
it. `pnpm build` remains a frontend-only build.

## Browser extension release identity

The tracked [release origin configuration](config/release-extension-origins.json)
is the single default allowlist for a private LuckyRay browser-extension
release. It is bound to the public Chromium SubjectPublicKeyInfo in
`browser-extension-prototype/manifest.json`; the private signing key is never
stored, copied, or recovered from this repository.

- A bare `pnpm tauri build` uses that private-release identity.
- CI or a future store release may provide a strict exact
  `LUCKYRAY_EXTENSION_ORIGINS` override for the whole Tauri build. Empty,
  malformed, duplicate, or non-Chromium origins fail before staging.
- Development keeps its separate explicit debug origin. It never falls back to
  the private-release identity; use `LUCKYRAY_DEV_EXTENSION_ORIGINS` only for a
  deliberate debug override.
- The private signing key is held by the release administrator in restricted
  secret storage outside the repository, build output, recovery material, and
  cloud-synchronized directories. Grant access only to the release
  administrator and required system service accounts. Losing the key prevents
  future private releases from retaining the same extension identity, so make
  an offline encrypted backup before relying on it.

## 重要约束

- UI 视觉、布局、颜色、间距要尽量还原 `..\luckyray-ui.html`。
- React 组件化只改变实现方式，不主动改变观感。
- 如果正式数据模型导致必须改 UI，需要先说明原因和影响。
