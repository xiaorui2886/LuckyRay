import { useEffect, useRef, type DragEvent } from "react";
import { dedupeDroppedLocalPaths } from "./externalDropPaths";

let diagnosticCount = 0;
const diagnose = (stage: string, count = 0, hit = true) => {
  if (!import.meta.env.DEV || diagnosticCount++ >= 40) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("notes_drop_diagnostic", { stage, count, hit }),
    )
    .catch(() => {});
};

type DropOptions = {
  enabled: boolean;
  owner: unknown;
  defaultParent: string | null;
  classify: (
    paths: string[],
  ) => Promise<{ path: string; isFile: boolean; isDir: boolean }[]>;
  importPaths: (parent: string | null, paths: string[]) => Promise<void>;
  insertFiles: (files: File[]) => void;
  rejected: (message: string) => void;
};
const markdown = (path: string) => /\.(md|markdown)$/i.test(path);
const parentAt = (element: Element | null, fallback: string | null) => {
  const target = element?.closest<HTMLElement>("[data-folder-drop-id]");
  return target
    ? target.dataset.folderDropId === "__root__"
      ? null
      : target.dataset.folderDropId || fallback
    : fallback;
};

/** One Knowledge-page owner routes native drops before editor attachment handling.
 * Native enter starts a new gesture, so a repeated user drop is never time-throttled. */
export function useVaultFileDrop(options: DropOptions) {
  const current = useRef(options);
  current.current = options;
  const nativeActive = useRef(false),
    nativeDelivered = useRef(false);
  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false,
      unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "leave") {
            nativeActive.current = false;
            return;
          }
          const element = document.elementFromPoint(
            payload.position.x / (window.devicePixelRatio || 1),
            payload.position.y / (window.devicePixelRatio || 1),
          );
          const root = document.getElementById("page-notes");
          if (payload.type === "enter") {
            diagnose(
              "enter",
              payload.paths.length,
              !!element && !!root?.contains(element),
            );
            nativeDelivered.current = false;
            nativeActive.current = !!element && !!root?.contains(element);
            return;
          }
          if (payload.type !== "drop") return;
          nativeActive.current = false;
          diagnose(
            "drop",
            payload.paths.length,
            !!element && !!root?.contains(element),
          );
          if (!element || !root?.contains(element)) return;
          nativeDelivered.current = true;
          const own = current.current,
            owner = own.owner;
          const parent = parentAt(element, own.defaultParent);
          void own
            .classify(dedupeDroppedLocalPaths(payload.paths))
            .then(async (items) => {
              if (disposed || current.current.owner !== owner) return;
              diagnose("classified", items.length);
              const notes = items.filter(
                (item) => item.isDir || (item.isFile && markdown(item.path)),
              );
              if (notes.length)
                await own.importPaths(
                  parent,
                  notes.map((item) => item.path),
                );
              if (disposed || current.current.owner !== owner) return;
              const media = items.filter(
                (item) => item.isFile && !markdown(item.path),
              );
              if (media.length && !element.closest("[data-folder-drop-id]")) {
                // Tauri supplies filesystem paths instead of browser File bytes. The
                // existing publication path validates the source and its size natively.
                own.insertFiles(
                  media.map((item) =>
                    Object.assign(
                      new File(
                        [],
                        item.path.split(/[\\/]/).pop() || "attachment",
                      ),
                      { path: item.path },
                    ),
                  ),
                );
              }
            })
            .catch((error) => {
              if (!disposed && current.current.owner === owner)
                own.rejected(
                  error instanceof Error ? error.message : "无法读取拖入文件。",
                );
            });
        }),
      )
      .then((dispose) => {
        diagnose("listener-ready");
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        if (disposed) return;
        diagnose("listener-failed");
        console.warn("[notes-drop] listener failed", error);
        current.current.rejected("拖入文件暂不可用，请使用导入按钮。");
      });
    return () => {
      disposed = true;
      unlisten?.();
      nativeActive.current = false;
      nativeDelivered.current = false;
    };
  }, [options.enabled, options.owner]);
  return {
    onDropCapture: (event: DragEvent<HTMLElement>) => {
      if (!current.current.enabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (
        (nativeActive.current || nativeDelivered.current) &&
        (files.length || Array.from(event.dataTransfer.types).includes("Files"))
      ) {
        event.preventDefault();
        event.stopPropagation();
        nativeDelivered.current = false;
        return;
      }
      const directory = Array.from(event.dataTransfer.items).some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory,
      );
      if (!directory && !files.some((file) => markdown(file.name))) return;
      event.preventDefault();
      event.stopPropagation();
      const paths = dedupeDroppedLocalPaths(
        files.map((file) => (file as File & { path?: string }).path),
      );
      if (!paths.length) {
        current.current.rejected("未取得拖入笔记的本地路径，请重试拖入。");
        return;
      }
      const own = current.current,
        owner = own.owner,
        element = event.target as Element;
      const parent = parentAt(element, own.defaultParent);
      void own
        .classify(paths)
        .then(async (items) => {
          if (current.current.owner !== owner) return;
          const notes = items.filter(
            (item) => item.isDir || (item.isFile && markdown(item.path)),
          );
          if (notes.length)
            await own.importPaths(
              parent,
              notes.map((item) => item.path),
            );
          if (current.current.owner !== owner) return;
          if (!element.closest("[data-folder-drop-id]")) {
            const media = files.filter(
              (file) =>
                !markdown(file.name) &&
                !items.some(
                  (item) =>
                    item.isDir &&
                    dedupeDroppedLocalPaths([
                      (file as File & { path?: string }).path,
                    ]).includes(item.path),
                ),
            );
            if (media.length) own.insertFiles(media);
          }
        })
        .catch((error) => {
          if (current.current.owner === owner)
            own.rejected(
              error instanceof Error ? error.message : "无法读取拖入文件。",
            );
        });
    },
    onDragEnterCapture: (event: DragEvent<HTMLElement>) => {
      // A fresh DOM gesture must not inherit a native-only drop's delivery flag.
      if (
        !nativeActive.current &&
        !event.currentTarget.contains(event.relatedTarget as Node | null)
      )
        nativeDelivered.current = false;
    },
    onDragOverCapture: (event: DragEvent<HTMLElement>) => {
      if (
        current.current.enabled &&
        Array.from(event.dataTransfer.types).includes("Files")
      )
        event.preventDefault();
    },
  };
}
