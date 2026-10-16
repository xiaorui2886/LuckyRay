import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { materialLibrarySession, type MaterialLibrary, type MaterialLibraryRegistry } from "../../core/services/materialLibraryContext";
import { toMaterialCatalogError } from "../../core/services/materialCatalog";
import { openDataDir } from "../../core/services/system";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { MATERIAL_LIBRARY_NAVIGATION_EVENT, publishMaterialLibraryNavigationBusy, requestMaterialLibraryNavigation, type MaterialLibraryNavigationIntent } from "./materialLibraryNavigationProtocol";
import { isMaterialLibraryTransferAction, materialLibraryActions, materialLibraryLocation, materialLibraryStateLabel } from "./materialLibraryActions";
import { MaterialLibraryOperations } from "./MaterialLibraryOperations";
import "./materialLibraries.css";

type LibraryDialog = { kind: "manage" } | { kind: "create"; returnToManagement?: boolean }
  | { kind: "rename" | "relocate" | "hide"; library: MaterialLibrary; returnToManagement: boolean };
async function chooseRoot(title = "选择素材库目录") {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}
export function MaterialLibrarySwitcher({ showControls = true }: { showControls?: boolean }) {
  const snapshot = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState("");
  const [name, setName] = useState(""), [root, setRoot] = useState(""), [storageMode, setStorageMode] = useState("managed");
  const [pendingTransfer, setPendingTransfer] = useState<MaterialLibraryNavigationIntent | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef(false);
  const cancelEdit = () => setDialog(dialog && "returnToManagement" in dialog && dialog.returnToManagement ? { kind: "manage" } : null);
  const modalSurface = useApplicationModalSurface<HTMLDialogElement>(Boolean(dialog), () => { if (!busy) cancelEdit(); }, { closeOnEscape: !busy, closeOnBackdrop: !busy });
  const execute = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice("");
    try { await work(); return true; } catch (e) { setError(toMaterialCatalogError(e).message); return false; } finally { setBusy(false); }
  };
  useEffect(() => {
    if (dialog) {
      if (!modal.current?.open) modal.current?.showModal();
      if (dialog.kind === "create" || dialog.kind === "rename") modal.current?.querySelector<HTMLInputElement>("form input:not([readonly])")?.focus();
    } else modal.current?.close();
  }, [dialog]);
  useEffect(() => {
    if (dialog || !pendingTransfer) return;
    // Close management and release its inert lease before the existing transfer host opens.
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".material-library-switch-trigger")?.focus({ preventScroll: true });
      requestMaterialLibraryNavigation({ ...pendingTransfer, fromManagement: false }); setPendingTransfer(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [dialog, pendingTransfer]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2400); return () => clearTimeout(timer); }, [notice]);
  const manage = () => { setDialog({ kind: "manage" }); void execute(() => materialLibrarySession.refresh(true)); };
  const create = (returnToManagement = false) => { setName(""); setRoot(""); setStorageMode("managed"); setError(null); setDialog({ kind: "create", returnToManagement }); };
  const reopen = () => execute(async () => {
    const target = await chooseRoot(); if (!target) return;
    const library = await materialLibrarySession.request<MaterialLibrary>({ op: "reopen", root: target }, null);
    await materialLibrarySession.refresh(true); await materialLibrarySession.select(library.id); setDialog(null);
  });
  const requested = (intent: MaterialLibraryNavigationIntent) => {
    if (busy) return;
    if (isMaterialLibraryTransferAction(intent.action)) {
      if (intent.fromManagement) { setDialog(null); setPendingTransfer(intent); }
      return;
    }
    if (intent.action === "create") { create(); return; }
    if (intent.action === "manage") { manage(); return; }
    if (intent.action === "reopen") { void reopen(); return; }
    if (!intent.libraryId) return;
    void execute(async () => {
      const live = materialLibrarySession.getSnapshot();
      const registry = live.registry?.libraries.some(library => library.id === intent.libraryId) ? live.registry
        : await materialLibrarySession.request<MaterialLibraryRegistry>({ op: "registry", include_hidden: true }, null);
      const library = registry?.libraries.find(library => library.id === intent.libraryId);
      if (!library || !registry) throw new Error("找不到此素材库，请重新打开菜单");
      const action = materialLibraryActions(library, registry.legacyId, materialLibrarySession.getSnapshot().libraryId).find(action => action.id === intent.action);
      if (!action || action.disabledReason) throw new Error(action?.disabledReason ?? "此操作不可用");
      if (intent.action === "view") {
        if (library.id !== materialLibrarySession.getSnapshot().libraryId) await materialLibrarySession.select(library.id);
        else {
          window.dispatchEvent(new CustomEvent("luckyray:folder-reveal", { detail: { scope: "materials", folderId: null } }));
          window.dispatchEvent(new CustomEvent("luckyray:folder-select", { detail: { scope: "materials", folderId: null } }));
        }
        setDialog(null);
      } else if (intent.action === "copyId") { await navigator.clipboard.writeText(library.id); setNotice("已复制素材库 ID"); }
      else if (intent.action === "reveal") await openDataDir(library.rootPath!);
      else if (intent.action === "show") { await materialLibrarySession.request({ op: "show" }, library.id); await materialLibrarySession.refresh(true); }
      else if (intent.action === "rename" || intent.action === "relocate" || intent.action === "hide") {
        setName(library.name); setRoot(""); setDialog({ kind: intent.action, library: { ...library }, returnToManagement: Boolean(intent.fromManagement) });
      }
    });
  };
  useEffect(() => {
    const listener = (event: Event) => requested((event as CustomEvent<MaterialLibraryNavigationIntent>).detail);
    window.addEventListener(MATERIAL_LIBRARY_NAVIGATION_EVENT, listener);
    return () => window.removeEventListener(MATERIAL_LIBRARY_NAVIGATION_EVENT, listener);
  }, [busy]);
  useEffect(() => { publishMaterialLibraryNavigationBusy("manager", busy); return () => publishMaterialLibraryNavigationBusy("manager", false); }, [busy]);
  const finishEdit = async (owner: string, action: Record<string, unknown>, returnToManagement: boolean) => {
    await materialLibrarySession.request(action, owner); await materialLibrarySession.refresh(true);
    setDialog(returnToManagement ? { kind: "manage" } : null);
  };
  const heading = dialog?.kind === "create" ? "新建素材库" : dialog?.kind === "rename" ? "重命名素材库" : dialog?.kind === "relocate" ? "重新定位已有库" : dialog?.kind === "hide" ? "从列表中移除" : "管理素材库";
  return <>
    {showControls && <div className="material-library-switcher" aria-label="素材库切换">
      <select aria-label="当前素材库" value={snapshot.libraryId ?? ""} disabled={busy || snapshot.status === "switching"} onChange={event => { void execute(() => materialLibrarySession.select(event.target.value)); }}>
        {!snapshot.libraryId && <option value="">正在读取素材库…</option>}
        {snapshot.registry?.libraries.filter(library => library.visible).map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
      </select><button type="button" onClick={() => create()} disabled={busy}>新建库</button><button type="button" onClick={() => { void reopen(); }} disabled={busy}>打开已有库</button><button type="button" onClick={manage} disabled={busy}>管理素材库</button>
    </div>}
    {!dialog && (error || snapshot.error) && <p className="material-library-error" role="alert">{error || snapshot.error}</p>}
    {!dialog && notice && <p className="material-library-notice" role="status">{notice}</p>}
    <dialog ref={element => { modal.current = element; modalSurface.surfaceRef.current = element; }} className={`material-library-dialog${dialog?.kind === "manage" ? " material-library-management" : ""}`}
      onPointerDown={event => {
        const box = event.currentTarget.getBoundingClientRect();
        backdropPointer.current = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
      }}
      onPointerUp={event => {
        const box = event.currentTarget.getBoundingClientRect();
        const outside = event.target === event.currentTarget && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
        if (backdropPointer.current && outside && !busy) cancelEdit();
        backdropPointer.current = false;
      }}
      onKeyDown={modalSurface.onSurfaceKeyDown} onCancel={event => { event.preventDefault(); if (!busy) cancelEdit(); }} onClose={() => { if (!busy) setDialog(null); }}>
      <header><h2>{heading}</h2><button type="button" aria-label="关闭" disabled={busy} onClick={() => setDialog(null)}>×</button></header>
      {dialog?.kind === "manage" && <>
        <div className="material-library-list" aria-label="本机素材库">
          {snapshot.registry?.libraries.map(library => <section key={library.id} className="material-library-row" aria-label={library.name}>
            <div className="material-library-row-summary"><strong title={library.name}>{library.name}</strong>
              <p className="material-library-location" title={materialLibraryLocation(library)}>{materialLibraryLocation(library)}</p>
              <span className="material-library-row-state">{materialLibraryStateLabel[library.state]}{library.id === snapshot.libraryId ? " · 当前" : ""}{library.id === snapshot.registry!.legacyId ? " · 默认兼容库" : ""}{!library.visible ? " · 已从列表移除" : ""}</span>
            </div><MaterialLibraryOperations library={library} legacyId={snapshot.registry!.legacyId} currentId={snapshot.libraryId} busy={busy} fromManagement/>
          </section>)}
        </div>
        <footer className="material-library-management-footer"><div><button type="button" disabled={busy} onClick={() => create(true)}>新建素材库…</button><button type="button" disabled={busy} onClick={() => { void reopen(); }}>打开已有素材库…</button></div><button type="button" disabled={busy} onClick={() => setDialog(null)}>完成</button></footer>
      </>}
      {dialog?.kind === "create" && <form onSubmit={event => { event.preventDefault(); const frozen = dialog; void execute(async () => {
        const library = await materialLibrarySession.request<MaterialLibrary>({ op: "create", name, root, storageMode }, null);
        await materialLibrarySession.refresh(true); await materialLibrarySession.select(library.id); setDialog(frozen.returnToManagement ? { kind: "manage" } : null);
      }); }}>
        <label>库名称<input maxLength={120} value={name} onChange={event => setName(event.target.value)} required disabled={busy}/></label>
        <label>托管位置<div className="material-library-directory"><input value={root} readOnly placeholder="选择一个现有空目录"/><button type="button" disabled={busy} onClick={() => { void execute(async () => { const selected = await chooseRoot(); if (selected) setRoot(selected); }); }}>选择目录…</button></div></label>
        <label>默认存储方式<select value={storageMode} onChange={event => setStorageMode(event.target.value)} disabled={busy}><option value="managed">托管副本</option><option value="linked">链接原文件</option><option value="source">管理原文件</option></select></label>
        <p className="material-library-help">素材、分类、标签与搜索独立保存。创建素材库不会切换知识库或当前 LightSeek 会话。</p>
        <footer><button type="button" disabled={busy} onClick={cancelEdit}>取消</button><button type="submit" disabled={busy || !root || !name.trim()}>创建素材库</button></footer>
      </form>}
      {dialog?.kind === "rename" && <form onSubmit={event => { event.preventDefault(); const frozen = dialog; void execute(() => finishEdit(frozen.library.id, { op: "renameLibrary", name }, frozen.returnToManagement)); }}>
        <p className="material-library-help" title={dialog.library.name}>{dialog.library.name}</p>
        <label>新名称<input maxLength={120} value={name} onChange={event => setName(event.target.value)} required disabled={busy}/></label>
        <footer><button type="button" disabled={busy} onClick={cancelEdit}>取消</button><button type="submit" disabled={busy || !name.trim() || name === dialog.library.name}>保存名称</button></footer>
      </form>}
      {dialog?.kind === "relocate" && <>
        <p className="material-library-help">请先在应用外移动完整库目录，再选择已移动后的现有库位置。此操作只更新本机位置登记，不搬运文件；所选目录必须仍是同一个素材库。</p>
        <p className="material-library-location" title={materialLibraryLocation(dialog.library)}>原登记位置：{materialLibraryLocation(dialog.library)}</p>
        <label>已有库的新位置<div className="material-library-directory"><input value={root} readOnly/><button type="button" disabled={busy} onClick={() => { void execute(async () => { const selected = await chooseRoot("选择已移动后的同一素材库目录"); if (selected) setRoot(selected); }); }}>选择已有库目录…</button></div></label>
        <footer><button type="button" disabled={busy} onClick={cancelEdit}>取消</button><button type="button" disabled={busy || !root} onClick={() => { const frozen = dialog; void execute(() => finishEdit(frozen.library.id, { op: "relocateLibrary", root }, frozen.returnToManagement)); }}>更新登记位置</button></footer>
      </>}
      {dialog?.kind === "hide" && <>
        <p className="material-library-help">仅从本机列表隐藏「{dialog.library.name}」，磁盘目录和素材保留。之后可在管理素材库中重新加入列表，或打开已有目录。</p>
        <footer><button type="button" disabled={busy} onClick={cancelEdit}>取消</button><button type="button" disabled={busy} onClick={() => { const frozen = dialog; void execute(async () => {
          const live = materialLibrarySession.getSnapshot();
          if (frozen.library.id === live.libraryId || frozen.library.id === live.registry?.legacyId) throw new Error("当前库或默认兼容库必须保留，请先切换到其他库");
          await finishEdit(frozen.library.id, { op: "hide" }, frozen.returnToManagement);
        }); }}>仅从列表移除</button></footer>
      </>}
      {error && <p className="material-library-error" role="alert">{error}</p>}{notice && <p className="material-library-notice" role="status">{notice}</p>}
    </dialog>
  </>;
}
