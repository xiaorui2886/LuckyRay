import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { materialLibrarySession } from "../../core/services/materialLibraryContext";
import { isMaterialTransferRunning, materialLibraryTransfers } from "../../core/services/materialLibraryTransfers";
import { FolderAllIcon } from "../folders/FolderTree";
import { MATERIAL_LIBRARY_NAVIGATION_BUSY_EVENT, materialLibraryDisplayName, requestMaterialLibraryNavigation } from "./materialLibraryNavigationProtocol";
import { MaterialLibraryMenu } from "./MaterialLibraryMenu";
import { MaterialLibraryOperations } from "./MaterialLibraryOperations";

export function MaterialLibraryNavigation({ onViewAll }: { onViewAll: () => void }) {
  const session = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const transfers = useSyncExternalStore(materialLibraryTransfers.subscribe, materialLibraryTransfers.getSnapshot);
  const [open, setOpen] = useState(false);
  const [hostsBusy, setHostsBusy] = useState({ manager: false, transfer: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const name = materialLibraryDisplayName(session.libraryId, session.registry);
  const current = session.registry?.libraries.find(library => library.id === session.libraryId);
  const busy = hostsBusy.manager || hostsBusy.transfer || ["idle", "loading", "switching"].includes(session.status);
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) anchor?.focus({ preventScroll: true }); };
  useEffect(() => {
    const update = (event: Event) => { const { host, busy } = (event as CustomEvent<{ host: "manager" | "transfer"; busy: boolean }>).detail; setHostsBusy(previous => ({ ...previous, [host]: busy })); };
    window.addEventListener(MATERIAL_LIBRARY_NAVIGATION_BUSY_EVENT, update);
    return () => window.removeEventListener(MATERIAL_LIBRARY_NAVIGATION_BUSY_EVENT, update);
  }, []);
  return <>
    <button ref={root} type="button" className="folder-root-select" title={`${name} · 右键切换或管理素材库`} aria-label={`${name} · 全部素材`} disabled={busy}
      aria-haspopup="menu" aria-expanded={open && anchor === root.current}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setAnchor(event.currentTarget); setOpen(true); }}
      onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setAnchor(event.currentTarget); setOpen(true); } }}
      onClick={event => { event.stopPropagation(); close(false); onViewAll(); }}>
      <span className="folder-icon all"><FolderAllIcon scope="materials"/></span><span className="folder-name">{name}</span>
    </button>
    <button ref={trigger} type="button" className="material-library-menu-trigger material-library-switch-trigger" title="切换素材库"
      aria-label={`切换素材库：${name}`} aria-haspopup="menu" aria-expanded={open} disabled={busy}
      onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget); setOpen(value => !value); }}
      onKeyDown={event => { event.stopPropagation(); if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setAnchor(event.currentTarget); setOpen(true); } }}>
      <svg className="material-library-switch-indicator" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3-3 3 3M5 10l3 3 3-3"/></svg>
    </button>
    {current && <MaterialLibraryOperations library={current} legacyId={session.registry!.legacyId} currentId={session.libraryId} busy={busy} running={transfers.tasks.filter(isMaterialTransferRunning).length}/>}
    {open && anchor && <MaterialLibraryMenu anchor={anchor} label="切换素材库" onClose={close}>
      <div role="group" aria-label="素材库列表" className="material-library-menu-libraries">
        {session.registry?.libraries.filter(library => library.visible).map(library => <button key={library.id} type="button" role="menuitemradio" aria-checked={library.id === session.libraryId} disabled={busy}
          title={library.name}
          onClick={() => { close(); if (library.id === session.libraryId) onViewAll(); else void materialLibrarySession.select(library.id).catch(() => {}); }}>
          <span className="material-library-menu-check" aria-hidden="true">{library.id === session.libraryId ? "✓" : ""}</span>
          <span className="material-library-menu-name">{library.name}</span>
        </button>)}
      </div>
      <div role="group" aria-label="管理"><button type="button" role="menuitem" disabled={busy} onClick={() => { close(); requestMaterialLibraryNavigation({ action: "manage", libraryId: session.libraryId, name }); }}>管理素材库…</button></div>
    </MaterialLibraryMenu>}
  </>;
}
