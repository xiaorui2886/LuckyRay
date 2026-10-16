// D93: shared useFolders hook
// 负责 listFolders / createFolder / reloadFolders，支持 materials / notes scope

import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from "react";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import {
  createFolderReloadCoordinator,
  type FolderBridgeReadiness,
  type FolderReloadCoordinator,
} from "./folderReloadCoordinator";

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  open: boolean;
  children: Folder[];
};

const folderCache = new Map<string, Folder[]>();

function getBridge(): any {
  return (window as any).__LUCKYRAY__ || null;
}

function notifyFoldersChanged(scope: "materials" | "notes") {
  window.dispatchEvent(new CustomEvent("luckyray:folders-changed", { detail: { scope } }));
}

export function useFolders(scope: "materials" | "notes") {
  const session = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const libraryId = scope === "materials" ? session.libraryId : null;
  const generation = scope === "materials" ? session.generation : 0;
  const cacheKey = libraryId ? `${scope}:${libraryId}` : scope;
  const scopedBridge = useMemo(() => {
    if (!libraryId) return null;
    const request = <T,>(op: string, fields: Record<string, unknown> = {}) => materialLibrarySession.request<T>({ op, ...fields }, libraryId);
    return {
      listFolders: () => request<Folder[]>("folders"),
      createFolder: (input: { parentId: string | null; name: string }) => request("createFolder", { input: { parentId: input.parentId, name: input.name } }),
      renameFolder: (id: string, name: string) => request("renameFolder", { id, name }),
      deleteFolder: (id: string) => request("deleteFolder", { id }),
      moveFolder: (input: { id: string; targetId: string | null; position: string }) => request("moveFolder", { input }),
    };
  }, [libraryId, generation]);
  const readBridge = useCallback(() => scopedBridge ?? getBridge(), [scopedBridge]);
  const cachedFolders = folderCache.get(cacheKey);
  const [folders, setFolders] = useState<Folder[]>(() => cachedFolders || []);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(Boolean(cachedFolders));
  const coordinatorRef = useRef<FolderReloadCoordinator | null>(null);

  const reloadFolders = useCallback(() => (
    coordinatorRef.current?.reload() || Promise.resolve()
  ), []);

  const createFolder = useCallback(async (parentId: string | null, name: string) => {
    const bridge = readBridge();
    if (!bridge?.createFolder) return;
    try {
      await bridge.createFolder({ scope, parentId, name });
      await reloadFolders();
      notifyFoldersChanged(scope);
    } catch (e) {
      console.warn("[useFolders] createFolder failed", e);
    }
  }, [scope, reloadFolders, readBridge]);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const bridge = readBridge();
    if (!bridge?.renameFolder) return;
    try {
      await bridge.renameFolder(id, name);
      await reloadFolders();
      notifyFoldersChanged(scope);
    } catch (e) {
      console.warn("[useFolders] renameFolder failed", e);
    }
  }, [scope, reloadFolders, readBridge]);

  const deleteFolder = useCallback(async (id: string) => {
    const bridge = readBridge();
    if (!bridge?.deleteFolder) return;
    try {
      await bridge.deleteFolder(id);
      await reloadFolders();
      notifyFoldersChanged(scope);
    } catch (e) {
      console.warn("[useFolders] deleteFolder failed", e);
    }
  }, [scope, reloadFolders, readBridge]);

  const moveFolder = useCallback(async (id: string, targetId: string | null) => {
    const bridge = readBridge();
    if (!bridge?.moveFolder) return;
    try {
      await bridge.moveFolder({ id, targetId, position: "inside" });
      await reloadFolders();
      notifyFoldersChanged(scope);
    } catch (e) {
      console.warn("[useFolders] moveFolder failed", e);
    }
  }, [scope, reloadFolders, readBridge]);

  useEffect(() => {
    setFolders(scope === "materials" ? [] : folderCache.get(cacheKey) ?? []);
    setLoaded(false);
    const context = materialLibrarySession.capture();
    const coordinator = createFolderReloadCoordinator<Folder>({
      scope,
      events: window,
      getBridge: readBridge,
      getReadiness: () => (
        (window as unknown as { __LUCKYRAY_BRIDGE_READINESS__?: FolderBridgeReadiness })
          .__LUCKYRAY_BRIDGE_READINESS__ || null
      ),
      onResult: (nextFolders) => {
        if (scope === "materials" && !materialLibrarySession.isCurrent(context)) return;
        folderCache.set(cacheKey, nextFolders);
        setFolders(nextFolders);
        setLoaded(true);
      },
      onLoading: setLoading,
      onError: (error) => {
        setLoaded(false);
        console.warn(`[useFolders] listFolders(${scope}) failed`, error);
      },
    });
    coordinatorRef.current = coordinator;
    coordinator.start();
    return () => {
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      coordinator.dispose();
    };
  }, [scope, cacheKey, generation, readBridge]);

  return { folders, loading, loaded, reloadFolders, createFolder, renameFolder, deleteFolder, moveFolder };
}

/** 将树形文件夹展平为带深度的列表 */
export function flattenFolders(folders: Folder[], depth = 0): Array<{ folder: Folder; depth: number }> {
  return folders.flatMap((folder) => [
    { folder, depth },
    ...flattenFolders(folder.children || [], depth + 1),
  ]);
}
