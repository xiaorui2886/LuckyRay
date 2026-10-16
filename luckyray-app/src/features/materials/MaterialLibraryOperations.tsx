import { useRef, useState } from "react";
import type { MaterialLibrary } from "../../core/services/materialLibraryContext";
import { materialLibraryActions } from "./materialLibraryActions";
import { requestMaterialLibraryNavigation, type MaterialLibraryNavigationAction } from "./materialLibraryNavigationProtocol";
import { MaterialLibraryMenu } from "./MaterialLibraryMenu";

export function MaterialLibraryOperations({ library, legacyId, currentId, busy, running = 0, fromManagement = false }: {
  library: MaterialLibrary; legacyId: string; currentId: string | null; busy: boolean; running?: number; fromManagement?: boolean;
}) {
  const [target, setTarget] = useState<MaterialLibrary | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus = true) => { setTarget(null); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); };
  const open = () => setTarget(previous => previous ? null : { ...library });
  return <>
    <button ref={trigger} type="button" className="material-library-menu-trigger" title={`${library.name} · 素材库操作${running ? ` · ${running} 个任务进行中` : ""}`}
      aria-label={`素材库操作：${library.name}`} aria-haspopup="menu" aria-expanded={Boolean(target)} disabled={busy}
      onClick={event => { event.stopPropagation(); open(); }} onKeyDown={event => { event.stopPropagation(); if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setTarget({ ...library }); } }}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/></svg>
      {running > 0 && <span className="material-library-task-count" aria-hidden="true">{running}</span>}
    </button>
    {target && trigger.current && <MaterialLibraryMenu anchor={trigger.current} label={`${target.name}的素材库操作`} onClose={close}>
      <div className="material-library-menu-heading" title={target.name}>{target.name}</div>
      {(["browse", "manage", "transfer"] as const).map(group => <div key={group} role="group" aria-label={group === "browse" ? "浏览" : group === "manage" ? "整理素材库" : "复制、备份与任务"}>
        {materialLibraryActions(target, legacyId, currentId).filter(action => action.group === group).map(action => <button key={action.id} type="button" role="menuitem"
          className={action.danger ? "material-library-action-danger" : undefined} disabled={busy || Boolean(action.disabledReason)} title={action.disabledReason}
          onClick={() => { const frozen = target; close(); requestMaterialLibraryNavigation({ action: action.id, libraryId: frozen.id, name: frozen.name, fromManagement }); }}>
          <LibraryActionIcon action={action.id}/><span className="material-library-action-label">{action.label}{action.disabledReason && <small>{action.disabledReason}</small>}</span>
        </button>)}
      </div>)}
    </MaterialLibraryMenu>}
  </>;
}

function LibraryActionIcon({ action }: { action: MaterialLibraryNavigationAction }) {
  const paths: Partial<Record<MaterialLibraryNavigationAction, string>> = {
    view: "M2 2h4v4H2z M10 2h4v4h-4z M2 10h4v4H2z M10 10h4v4h-4z",
    copyId: "M6 6h7v8H6z M10 6V2H2v8h4", copyLibrary: "M6 6h7v8H6z M10 6V2H2v8h4",
    rename: "M10 2l4 4-8 8H2v-4z M8 4l4 4", reveal: "M2 5V3h4l2 2h6v8H2z",
    relocate: "M2 5V3h4l2 2h6v8H2z M5 9h6 M9 7l2 2-2 2",
    hide: "M4 4l8 8 M12 4l-8 8", show: "M8 3v10 M3 8h10",
    export: "M8 2v8 M5 7l3 3 3-3 M2 11v3h12v-3", restore: "M8 11V3 M5 6l3-3 3 3 M2 11v3h12v-3",
    moveLibrary: "M2 8h8 M7 5l3 3-3 3 M14 5v6",
    mergeLibrary: "M3 3v4a4 4 0 0 0 4 4h6 M9 8l3 3-3 3 M3 13h4",
    tasks: "M6 3h8 M6 8h8 M6 13h8 M2 3h1 M2 8h1 M2 13h1",
  };
  return <svg className="material-library-action-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d={paths[action]}/></svg>;
}
