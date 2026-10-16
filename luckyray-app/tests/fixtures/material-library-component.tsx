// Browser-only production-component fixture. No profile, database or native app is opened.
import { createRoot } from "react-dom/client";
import { MaterialLibrarySwitcher } from "../../src/features/materials/MaterialLibrarySwitcher";
import { materialLibrarySession, type MaterialLibraryRegistry } from "../../src/core/services/materialLibraryContext";
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from "../../src/app/applicationModalIsolation";
import "../../src/features/materials/materials.css";
import "../../src/core/theme/themeTokens.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") || "light";
const registry: MaterialLibraryRegistry = {
  legacyId: "library-default-000001", activeId: "library-default-000001",
  libraries: [
    { id: "library-default-000001", name: "设计素材", rootPath: null, state: "ready", visible: true },
    { id: "library-second-000002", name: "设计素材", rootPath: "D:/个人资料/素材与灵感/项目参考库", state: "ready", visible: true },
    { id: "library-offline-000003", name: "离线参考库", rootPath: "E:/" + "长期项目的视觉参考与归档素材/".repeat(8), state: "offline", visible: true },
    { id: "library-hidden-000004", name: "隐藏资料", rootPath: "F:/设计素材", state: "ready", visible: false },
  ].map(item => ({ ...item, storageMode: "managed", version: 0, preferences: {} })) as MaterialLibraryRegistry["libraries"],
};
let chosenRoot = "D:/fixture/empty-library";
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  if (command === "plugin:dialog|open") return chosenRoot;
  if (command !== "material_library_command") throw new Error("Unexpected fixture command: " + command);
  const { libraryId, action } = args.request;
  const library = registry.libraries.find(item => item.id === libraryId);
  switch (action.op) {
    case "registry": return structuredClone({ ...registry, libraries: registry.libraries.filter(item => action.include_hidden || item.visible) });
    case "select": registry.activeId = libraryId; return null;
    case "renameLibrary": library!.name = action.name; return null;
    case "hide": library!.visible = false; return null;
    case "show": library!.visible = true; return null;
    case "relocateLibrary": library!.rootPath = action.root; library!.state = "ready"; return structuredClone(library);
    case "reopen": { const existing = registry.libraries.find(item => item.rootPath === action.root); if (!existing) throw new Error("所选目录未在本机登记"); existing.visible = true; return structuredClone(existing); }
    case "create": {
      await new Promise(resolve => setTimeout(resolve, 250));
      const created = { id: "library-new-000005", name: action.name, rootPath: action.root, state: "ready" as const, visible: true, storageMode: action.storageMode, version: 0, preferences: {} };
      registry.libraries.push(created); return structuredClone(created);
    }
    default: throw new Error("Unexpected fixture operation: " + action.op);
  }
} };
(window as any).__MATERIAL_COMPONENT_FIXTURE__ = { chooseRoot: (value: string) => { chosenRoot = value; } };
await materialLibrarySession.initialize();
createRoot(document.getElementById("root")!).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><MaterialLibrarySwitcher /></ApplicationModalIsolationProvider>);
