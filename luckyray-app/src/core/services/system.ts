// D124: 系统/设置服务薄封装
// 只封装已存在的 bridge 能力，不新增任何 IPC

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getLuckyRayBridgeSync } from "../bridge/luckyRayBridge";

// ========== 窗口控制 ==========

export async function hideWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("hide_window");
}

export async function showWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("show_window");
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("close_window");
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("minimize_window");
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke("toggle_maximize_window");
}

// ========== 开机自启 ==========

export async function getAutoLaunchEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  return await invoke<boolean>("get_auto_launch_enabled");
}

export async function setAutoLaunchEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_auto_launch_enabled", { enabled });
}

// ========== 数据目录 ==========

export async function openDataDir(path: string): Promise<void> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.openDirectory) throw new Error("当前环境不支持打开目录");
  await bridge.openDirectory(path);
}

export async function openExternalUrl(url: string): Promise<void> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.openExternalUrl) throw new Error("当前环境不支持打开链接");
  await bridge.openExternalUrl(url);
}

// ========== 备份与导出 ==========

export type BackupInfo = {
  id: string;
  path: string;
  manifest?: {
    created_at?: string;
    app_version?: string;
    asset_count?: number;
    note_count?: number;
    tag_count?: number;
  };
};

export type ExportResult = { path: string; count: number };
export type ImportNotesResult = { count: number; importedAttachments?: number };

export async function createBackup(): Promise<BackupInfo> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.createBackup) throw new Error("当前环境不支持创建备份");
  return bridge.createBackup();
}

export async function restoreBackup(backupId: string): Promise<string> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.restoreBackup) throw new Error("当前环境不支持恢复备份");
  return bridge.restoreBackup(backupId);
}

export async function exportNotes(): Promise<ExportResult> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.exportNotesMarkdown) throw new Error("当前环境不支持导出笔记");
  return bridge.exportNotesMarkdown();
}

export async function importNotes(): Promise<ImportNotesResult> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.importNotesMarkdown) throw new Error("当前环境不支持导入笔记");
  const result = await bridge.importNotesMarkdown();
  if (result.notes?.[0]?.id) {
    window.dispatchEvent(new CustomEvent("luckyray:notes-imported", {
      detail: {
        noteIds: result.notes.map((note) => note.id),
        importedAttachments: result.importedAttachments || 0,
      },
    }));
  }
  return { count: result.count, importedAttachments: result.importedAttachments || 0 };
}

export async function exportAssetManifest(): Promise<ExportResult> {
  const bridge = getLuckyRayBridgeSync();
  if (!bridge?.exportAssetsIndex) throw new Error("当前环境不支持导出素材清单");
  return bridge.exportAssetsIndex();
}

// ========== 缓存清理 ==========

export type ClearCacheResult = {
  backup_id: string;
  cleared_tables: string[];
  removed_bytes: number;
  removed_files: number;
};

export async function clearCache(): Promise<ClearCacheResult> {
  if (!isTauri()) return { backup_id: "browser-preview", cleared_tables: [], removed_bytes: 0, removed_files: 0 };
  return await invoke<ClearCacheResult>("clear_thumbnail_cache");
}

export async function clearAllData(): Promise<ClearCacheResult> {
  if (!isTauri()) return { backup_id: "browser-preview", cleared_tables: [], removed_bytes: 0, removed_files: 0 };
  return await invoke<ClearCacheResult>("clear_all_data");
}
