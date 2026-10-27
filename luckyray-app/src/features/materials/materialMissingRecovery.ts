import {
  getMaterialCatalogErrorCode,
  SOURCE_RELOCATE_CONTENT_MISMATCH_CODE,
  toMaterialCatalogError,
  type MaterialRelocateOptions,
} from "../../core/services/materialCatalog";

export type MaterialMissingItem = {
  id: string;
  name: string;
  libraryPath: string;
};

export type MaterialMissingScanReason = "initial" | "focus" | "visibility" | "data-change" | "manual";

/** Freeze the confirmed IDs; reuse the canonical record-only operation, never file deletion. */
export async function removeMissingMaterialRecords({ ids, scanMissing, removeRecord, canContinue, onRemoved }: {
  ids: readonly string[];
  scanMissing: () => Promise<readonly { id: string }[]>;
  removeRecord: (id: string) => Promise<{ success: boolean }>;
  canContinue: () => boolean;
  onRemoved?: (id: string) => void;
}) {
  const candidates = [...new Set(ids)];
  const removedIds: string[] = [], skippedIds: string[] = [];
  const result = (remainingIds: string[], stopped = false, failure: { id: string; error: unknown } | null = null) => ({ removedIds, skippedIds, remainingIds, stopped, failure });
  if (candidates.length === 0) return result([]);
  if (!canContinue()) return result(candidates, true);
  const missing = new Set((await scanMissing()).map((item) => item.id));
  for (const [index, id] of candidates.entries()) {
    if (!canContinue()) return result(candidates.slice(index), true);
    if (!missing.has(id)) { skippedIds.push(id); continue; }
    try {
      const response = await removeRecord(id);
      if (response.success !== true) throw new Error("missing-record-removal-not-confirmed");
      removedIds.push(id);
      if (canContinue()) onRemoved?.(id);
    } catch (error) {
      return result(candidates.slice(index), false, { id, error });
    }
  }
  return result([], !canContinue());
}

type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

type ConfirmDialogLike = { onCancel?: () => void };
type ConfirmDialogRef<TDialog extends ConfirmDialogLike> = { current: TDialog | null };

export function closeCurrentConfirmDialog<TDialog extends ConfirmDialogLike>(
  dialogRef: ConfirmDialogRef<TDialog>,
  clearDialog: () => void,
  disposition: "cancel",
): boolean;
export function closeCurrentConfirmDialog<TDialog extends ConfirmDialogLike>(
  dialogRef: ConfirmDialogRef<TDialog>,
  clearDialog: () => void,
  disposition: "action",
): TDialog | false;
export function closeCurrentConfirmDialog<TDialog extends ConfirmDialogLike>(
  dialogRef: ConfirmDialogRef<TDialog>,
  clearDialog: () => void,
  disposition: "cancel" | "action",
): boolean | TDialog {
  const dialog = dialogRef.current;
  if (!dialog) return false;
  dialogRef.current = null;
  if (disposition === "cancel") dialog.onCancel?.();
  clearDialog();
  return disposition === "cancel" ? true : dialog;
}

export function replaceCurrentConfirmDialog<TDialog extends ConfirmDialogLike>(
  dialogRef: ConfirmDialogRef<TDialog>,
  installDialog: (dialog: TDialog) => void,
  nextDialog: TDialog,
): { installed: boolean; cancelError?: unknown } {
  const previousDialog = dialogRef.current;
  if (previousDialog === nextDialog) return { installed: false };

  dialogRef.current = nextDialog;
  let cancelError: unknown;
  let cancelFailed = false;
  try {
    previousDialog?.onCancel?.();
  } catch (error) {
    cancelFailed = true;
    cancelError = error;
  }
  installDialog(nextDialog);
  return cancelFailed ? { installed: true, cancelError } : { installed: true };
}

export function attachMaterialMissingScanTriggers({
  windowTarget,
  documentTarget,
  getVisibilityState,
  schedule,
}: {
  windowTarget: EventTargetLike;
  documentTarget: EventTargetLike;
  getVisibilityState: () => string;
  schedule: (reason: MaterialMissingScanReason) => void;
}) {
  const onFocus = () => schedule("focus");
  const onVisibility = () => {
    if (getVisibilityState() === "visible") schedule("visibility");
  };
  const onDataChange = () => schedule("data-change");
  windowTarget.addEventListener("focus", onFocus);
  documentTarget.addEventListener("visibilitychange", onVisibility);
  windowTarget.addEventListener("luckyray:materials-data-changed", onDataChange);
  schedule("initial");
  return () => {
    windowTarget.removeEventListener("focus", onFocus);
    documentTarget.removeEventListener("visibilitychange", onVisibility);
    windowTarget.removeEventListener("luckyray:materials-data-changed", onDataChange);
  };
}

export function createMaterialMissingScanCoordinator<T>({
  scan,
  onResult,
  onError,
  debounceMs = 120,
}: {
  scan: () => Promise<T[]>;
  onResult: (items: T[]) => void;
  onError: (error: unknown) => void;
  debounceMs?: number;
}) {
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingGeneration: number | null = null;
  let drainPromise: Promise<void> | null = null;
  const idleWaiters = new Set<() => void>();

  const resolveIdleWaiters = () => {
    if (drainPromise !== null || pendingGeneration !== null || timer !== null) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drain = async () => {
    while (!disposed) {
      const requestGeneration = pendingGeneration;
      pendingGeneration = null;
      if (requestGeneration === null) break;
      if (requestGeneration !== generation) continue;
      try {
        const result = await scan();
        if (!disposed && requestGeneration === generation) onResult(result);
      } catch (error) {
        if (!disposed && requestGeneration === generation) onError(error);
      }
    }
  };

  const startDrain = () => {
    if (disposed || drainPromise !== null || pendingGeneration === null) return;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      resolveIdleWaiters();
    });
  };

  const schedule = (_reason: MaterialMissingScanReason, delay = debounceMs) => {
    if (disposed) return;
    generation += 1;
    const requestGeneration = generation;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed || requestGeneration !== generation) {
        resolveIdleWaiters();
        return;
      }
      pendingGeneration = requestGeneration;
      startDrain();
    }, Math.max(0, delay));
  };

  const scanNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    generation += 1;
    const requestGeneration = generation;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingGeneration = requestGeneration;
    const completed = new Promise<void>((resolve) => idleWaiters.add(resolve));
    startDrain();
    return completed;
  };

  const dispose = () => {
    disposed = true;
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingGeneration = null;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  return { schedule, scanNow, dispose };
}

export function notifyMaterialMissingCount(notify: (count: number) => void, count: number) {
  notify(Math.max(0, Math.trunc(count)));
}

export async function runMaterialRelocationWithConfirmation<TAsset extends { id: string }>({
  assetId,
  selectPath,
  relocate,
  confirmSourceContentChange,
}: {
  assetId: string;
  selectPath: () => Promise<string | null>;
  relocate: (assetId: string, path: string, options?: MaterialRelocateOptions) => Promise<TAsset | null>;
  confirmSourceContentChange: (actualContentHash: string) => Promise<boolean>;
}): Promise<
  | { status: "cancelled" }
  | { status: "failed"; error: unknown }
  | { status: "succeeded"; asset: TAsset }
> {
  let path: string | null;
  try {
    path = await selectPath();
  } catch (error) {
    return { status: "failed", error };
  }
  if (!path) return { status: "cancelled" };

  try {
    const asset = await relocate(assetId, path);
    return asset
      ? { status: "succeeded", asset }
      : { status: "failed", error: new Error("重新定位后未返回素材记录") };
  } catch (error) {
    if (getMaterialCatalogErrorCode(error) !== SOURCE_RELOCATE_CONTENT_MISMATCH_CODE) {
      return { status: "failed", error };
    }
    const catalogError = toMaterialCatalogError(error);
    const actualContentHash = catalogError.details?.actualContentHash;
    if (typeof actualContentHash !== "string" || !/^[a-f0-9]{64}$/i.test(actualContentHash)) {
      return { status: "failed", error: catalogError };
    }
    let confirmed: boolean;
    try {
      confirmed = await confirmSourceContentChange(actualContentHash);
    } catch (confirmationError) {
      return { status: "failed", error: confirmationError };
    }
    if (!confirmed) return { status: "cancelled" };
    try {
      const asset = await relocate(assetId, path, {
        allowSourceContentChange: true,
        expectedSourceContentHash: actualContentHash,
      });
      return asset
        ? { status: "succeeded", asset }
        : { status: "failed", error: new Error("重新定位后未返回素材记录") };
    } catch (overrideError) {
      return { status: "failed", error: overrideError };
    }
  }
}

export async function recoverMissingMaterialAsset<
  TItem extends MaterialMissingItem,
  TAsset extends { id: string },
>({
  item,
  list,
  selectPath,
  relocate,
}: {
  item: TItem;
  list: TItem[];
  selectPath: () => Promise<string | null>;
  relocate: (assetId: string, path: string) => Promise<TAsset | null>;
}): Promise<
  | { status: "cancelled"; list: TItem[] }
  | { status: "failed"; list: TItem[]; error: unknown }
  | { status: "succeeded"; list: TItem[]; asset: TAsset }
> {
  try {
    const path = await selectPath();
    if (!path) return { status: "cancelled", list };
    const asset = await relocate(item.id, path);
    if (!asset) {
      return { status: "failed", list, error: new Error("重新定位后未返回素材记录") };
    }
    return {
      status: "succeeded",
      list: list.filter((candidate) => candidate.id !== item.id),
      asset,
    };
  } catch (error) {
    return { status: "failed", list, error };
  }
}

export async function resolveMaterialPathAction<TItem extends { id: string }>({
  assetId,
  attempt,
  scanMissing,
}: {
  assetId: string;
  attempt: () => Promise<boolean>;
  scanMissing: () => Promise<TItem[]>;
}): Promise<
  | { status: "opened"; missingAssets: TItem[]; scanFailed: false }
  | { status: "missing"; missingAssets: TItem[]; scanFailed: false; error?: unknown }
  | { status: "failed"; missingAssets: TItem[]; scanFailed: boolean; error?: unknown }
> {
  let actionError: unknown;
  try {
    if (await attempt()) return { status: "opened", missingAssets: [], scanFailed: false };
  } catch (error) {
    actionError = error;
  }
  try {
    const missingAssets = await scanMissing();
    if (missingAssets.some((asset) => asset.id === assetId)) {
      return { status: "missing", missingAssets, scanFailed: false, error: actionError };
    }
    return { status: "failed", missingAssets, scanFailed: false, error: actionError };
  } catch (scanError) {
    return {
      status: "failed",
      missingAssets: [],
      scanFailed: true,
      error: actionError ?? scanError,
    };
  }
}
