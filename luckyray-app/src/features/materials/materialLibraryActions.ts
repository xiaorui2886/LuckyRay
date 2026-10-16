import type { MaterialLibrary } from "../../core/services/materialLibraryContext";
import type { MaterialLibraryNavigationAction } from "./materialLibraryNavigationProtocol";

export const materialLibraryStateLabel = { ready: "可用", offline: "位置不可用", conflict: "身份冲突", creating: "创建未完成" };
export const defaultMaterialLibraryLocation = "默认存储 · 沿用既有素材目录，无独立库根目录";
export const materialLibraryLocation = (library: MaterialLibrary) => library.rootPath ?? defaultMaterialLibraryLocation;
export const isMaterialLibraryTransferAction = (action: MaterialLibraryNavigationAction) => ["export", "restore", "copyLibrary", "moveLibrary", "mergeLibrary", "tasks"].includes(action);
export type MaterialLibraryAction = { id: MaterialLibraryNavigationAction; label: string; group: "browse" | "manage" | "transfer"; disabledReason?: string; danger?: boolean };

/** One action/availability definition for the sidebar and every management row. */
export function materialLibraryActions(library: MaterialLibrary, legacyId: string, currentId: string | null): MaterialLibraryAction[] {
  const unavailable = library.state !== "ready" ? materialLibraryStateLabel[library.state] : undefined;
  const noRoot = library.rootPath === null ? "默认兼容库未登记独立根目录" : undefined;
  return [
    { id: "view", label: library.id === currentId ? "查看全部素材" : "打开此素材库", group: "browse", disabledReason: unavailable },
    { id: "copyId", label: "复制素材库 ID", group: "browse" },
    { id: "rename", label: "重命名…", group: "manage" },
    { id: "reveal", label: "在资源管理器中显示", group: "manage", disabledReason: noRoot ?? unavailable },
    { id: "relocate", label: "重新定位已有库…", group: "manage", disabledReason: noRoot },
    library.visible
      ? { id: "hide", label: "从列表中移除…", group: "manage", danger: true, disabledReason: library.id === legacyId ? "默认兼容库必须保留" : library.id === currentId ? "请先切换到其他素材库" : undefined }
      : { id: "show", label: "重新加入列表", group: "manage" },
    { id: "export", label: "备份完整库包…", group: "transfer", disabledReason: unavailable },
    { id: "restore", label: "从库包恢复新库…", group: "transfer" },
    { id: "copyLibrary", label: "复制到其他素材库…", group: "transfer", disabledReason: unavailable },
    { id: "moveLibrary", label: "移动整库到新位置…", group: "transfer", disabledReason: noRoot ?? unavailable },
    { id: "mergeLibrary", label: "合并其他素材库到此库…", group: "transfer", disabledReason: unavailable },
    { id: "tasks", label: "库任务", group: "transfer" },
  ];
}
