// Production sidebar/titlebar/page with populated explicit native transport fixtures.
// No user profile/native process is opened; final main-dev integration belongs to original Sol.
import { createRoot } from "react-dom/client";
import { AppSidebar, AppTitlebar } from "../../src/app/AppSidebar";
import MaterialsPage from "../../src/features/materials/MaterialsPage";
import { I18nProvider } from "../../src/core/i18n/index";
import { materialLibrarySession, type MaterialLibraryRegistry } from "../../src/core/services/materialLibraryContext";
import { materialLibraryTransfers, type MaterialTransferTask } from "../../src/core/services/materialLibraryTransfers";
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore, useApplicationModalIsolationSnapshot } from "../../src/app/applicationModalIsolation";
import { ExperienceOverlayProvider } from "../../src/components/ExperienceOverlay";
import type { MaterialAsset } from "../../src/core/services/materialCatalog";
import "../../src/core/theme/themeTokens.css";
import "../../src/app/appShell.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";
localStorage.setItem("luckyray-sidebar-collapsed-v1", params.has("collapsed") ? "1" : "0");
localStorage.setItem("luckyray-settings-v1", JSON.stringify({ "materials.importModePromptSeen": true }));
const A = "library-default-000001", B = "library-second-000002", C = "library-offline-000003", D = "library-other-000004";
const registry: MaterialLibraryRegistry = { legacyId: A, activeId: A, libraries: [
  { id: A, name: "默认素材库", rootPath: null, state: "ready" },
  { id: B, name: "项目参考", rootPath: "D:/fixture/project", state: "ready" },
  { id: C, name: "离线参考", rootPath: "E:/fixture/offline", state: "offline" },
  { id: D, name: "项目参考", rootPath: "D:/fixture/other-project", state: "ready" },
].map(library => ({ ...library, state: library.state as "ready" | "offline", storageMode: "managed", visible: true, version: 0, preferences: {} })) };
const folders = (owner: string) => [{ id: `folder-${owner}-1`, name: owner === A ? "脚本图" : "项目场景", parentId: null, open: false, children: [] }, { id: `folder-${owner}-2`, name: "灵感参考", parentId: null, open: false, children: [] }];
function image(index: number) {
  const colors = ["#546486", "#ac8d73", "#778d6c", "#d7c6a9", "#59797d", "#957c88"];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${index % 2 ? 680 : 820}" viewBox="0 0 600 820"><rect width="600" height="820" fill="${colors[index % colors.length]}"/><path d="M0 560L300 170L600 560V820H0Z" fill="#f5eee0" opacity=".45"/><circle cx="460" cy="180" r="85" fill="#f5eee0" opacity=".6"/><path d="M0 720L220 430L470 720L600 560V820H0Z" fill="#182c39" opacity=".65"/></svg>`)}`;
}
const assets = new Map<string, MaterialAsset[]>();
for (const owner of [A, B, D]) assets.set(owner, Array.from({ length: owner === A ? 8 : 3 }, (_, i) => ({ id: `asset-${owner}-${i}`, name: `${owner === A ? "视觉参考" : "项目素材"} ${i + 1}.png`, originalPath: image(i), libraryPath: image(i), storageMode: "managed", kind: "image", mimeType: "image/png", sizeBytes: 2048, thumbnailUrl: image(i), description: "工程检查素材", rating: 0, dominantColor: "#546486", folderId: `folder-${owner}-${i % 2 + 1}`, importedAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", contentHash: `fixture-${owner}-${i}` })));
const tasks = new Map<string, MaterialTransferTask>(); const commands: any[] = []; const folderSelections: unknown[] = [];
const copiedTexts: string[] = [], revealedPaths: string[] = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copiedTexts.push(text); } } });
let chosenRoot = "D:/fixture/project", pendingPicker: ((value: string) => void) | null = null, holdPicker = false;
window.addEventListener("luckyray:folder-select", event => folderSelections.push(structuredClone((event as CustomEvent).detail)));
const fixture = {
  A, B, C, D, commands, folderSelections, copiedTexts, revealedPaths,
  snapshot: () => structuredClone(materialLibraryTransfers.getSnapshot()),
  registry: () => structuredClone(registry),
  assetCounts: () => Object.fromEntries([...assets.entries()].map(([owner, items]) => [owner, items.length])),
  select: (owner: string) => materialLibrarySession.select(owner),
  addLibraries: async (count: number) => { for (let i = 0; i < count; i++) registry.libraries.push({ ...registry.libraries[1], id: `library-many-${i}`, name: `参考资料 ${i + 1}`, rootPath: `D:/fixture/many/摄影与设计/归档系列/${i + 1}`, preferences: {} }); await materialLibrarySession.refresh(true); },
  rename: async (owner: string, name: string) => { registry.libraries.find(l => l.id === owner)!.name = name; await materialLibrarySession.refresh(); },
  chooseRoot: (path: string) => { chosenRoot = path; },
  holdPicker: () => { holdPicker = true; },
  resolvePicker: () => { pendingPicker?.(chosenRoot); pendingPicker = null; holdPicker = false; },
  complete: async (id: string) => { const task = tasks.get(id)!; task.phase = "completed"; task.completed = task.total; task.copied = task.total; task.retryable = false; task.items.forEach(item => item.state = "copied"); await materialLibraryTransfers.refresh(); },
};
(window as any).__MATERIAL_NAV_FIXTURE__ = fixture;
(window as any).__LUCKYRAY_BRIDGE_READINESS__ = { generation: 1, bridgeInstalled: true, databaseReady: true };
(window as any).__LUCKYRAY__ = { listAssets: async () => [], listAssetsFiltered: async () => [], listFolders: async () => [], getAssetsByIds: async () => [], getMaterialChangeState: async () => null, getAssetPreviewUrl: async (path: string) => path, openDirectory: async (path: string) => { revealedPaths.push(path); }, setCurrentContext: async () => {}, getCurrentContext: async () => ({}) };
const callbacks = new Map<number, unknown>(); let callbackId = 0;
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:dialog|open") return holdPicker ? new Promise<string>(resolve => { pendingPicker = resolve; }) : args.options.directory ? chosenRoot : "D:/fixture/archive.lrlibrary";
    if (command === "plugin:dialog|save") return "D:/fixture/backup.lrlibrary";
    if (command === "plugin:event|listen") return ++callbackId;
    if (command === "plugin:event|unlisten") return null;
    if (command === "plugin:window|is_maximized") return false;
    if (command === "set_current_context" || command === "agent_context_set") return null;
    if (command !== "material_library_command") throw new Error("Unexpected fixture command: " + command);
    const { libraryId, action } = args.request; commands.push(structuredClone(args.request));
    const current = registry.libraries.find(library => library.id === libraryId);
    switch (action.op) {
      case "registry": return structuredClone({ ...registry, libraries: registry.libraries.filter(library => action.include_hidden || library.visible) });
      case "select": if (current?.state !== "ready") throw new Error("library-offline: 素材库位置不可用"); registry.activeId = libraryId; return null;
      case "list": return structuredClone((assets.get(libraryId) ?? []).filter(asset => !action.filter?.folderId || asset.folderId === action.filter.folderId));
      case "get": return structuredClone((assets.get(libraryId) ?? []).filter(asset => action.ids.includes(asset.id)));
      case "update": { const asset = assets.get(libraryId)?.find(asset => asset.id === action.id); if (!asset) return null; Object.assign(asset, action.patch); return structuredClone(asset); }
      case "folders": return structuredClone(folders(libraryId));
      case "change": return { version: 1, reason: "fixture", affectedIds: [], foldersChanged: false, occurredAt: "2026-09-29T00:00:00Z" };
      case "tags": case "favorites": case "assetTags": case "missing": return [];
      case "tasks": return { exports: [], csv: [] };
      case "preferences": current!.preferences = action.value; return null;
      case "create": { const id = `library-new-${registry.libraries.length}`; const created = { id, name: action.name, rootPath: action.root, state: "ready" as const, storageMode: action.storageMode, visible: true, version: 0, preferences: {} }; registry.libraries.push(created); assets.set(id, []); return structuredClone(created); }
      case "renameLibrary": current!.name = action.name; return null;
      case "reopen": { const library = registry.libraries.find(library => library.rootPath === action.root); if (!library) throw new Error("所选目录未在本机登记"); library.visible = true; return structuredClone(library); }
      case "hide": current!.visible = false; return null;
      case "show": current!.visible = true; return null;
      case "relocateLibrary": current!.state = "ready"; current!.rootPath = action.root; return null;
      case "transferList": return structuredClone([...tasks.values()].filter(task => task.sourceLibraryId === libraryId && (!action.unresolvedOnly || task.phase !== "completed")));
      case "transferCopy": case "transferExport": case "transferRestore": {
        const selected = (assets.get(libraryId) ?? []).filter(asset => !action.selection?.assetIds || action.selection.assetIds.includes(asset.id)).filter(asset => !action.selection?.folderId || asset.folderId === action.selection.folderId);
        const task: MaterialTransferTask = { taskId: action.requestId, sourceLibraryId: libraryId, targetLibraryId: action.targetLibraryId ?? null, sourceName: current!.name, targetName: registry.libraries.find(l => l.id === action.targetLibraryId)?.name ?? null, kind: action.op === "transferCopy" ? "copy" : action.op === "transferExport" ? "export" : "restore", phase: "staging", currentFile: selected[0]?.name ?? null, currentBytes: 0, currentTotalBytes: 2048, total: selected.length, completed: 0, copied: 0, skipped: 0, failed: 0, error: null, outputPath: action.destination ?? null, retryable: true, items: selected.map(asset => ({ assetId: asset.id, name: asset.name, state: "pending", targetAssetId: null, error: null })) };
        tasks.set(task.taskId, task); return structuredClone(task);
      }
      case "transferStatus": case "transferCancel": case "transferRetry": {
        const task = tasks.get(action.taskId)!; if (task.sourceLibraryId !== libraryId) throw new Error("owner changed");
        if (action.op === "transferCancel") task.phase = "cancelled";
        if (action.op === "transferRetry") task.phase = "staging";
        return structuredClone(task);
      }
      default: throw new Error("Unexpected fixture operation: " + action.op);
    }
  },
};
const modalStore = createApplicationModalIsolationStore();
function Layout() {
  const isolated = useApplicationModalIsolationSnapshot(modalStore);
  return <div className="react-nav-shell" data-route="materials"><ExperienceOverlayProvider>
    <AppSidebar route="materials" onNavigate={() => {}} applicationModalIsolated={isolated} />
    <div className="main"><AppTitlebar route="materials" onOpenSearch={() => {}} applicationModalIsolated={isolated}/><div className="content-wrap"><div className="content"><MaterialsPage/></div></div></div>
  </ExperienceOverlayProvider></div>;
}
await materialLibrarySession.initialize();
const root = createRoot(document.getElementById("root")!);
root.render(<I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={modalStore}><Layout/></ApplicationModalIsolationProvider></I18nProvider>);
import.meta.hot?.dispose(() => root.unmount());
