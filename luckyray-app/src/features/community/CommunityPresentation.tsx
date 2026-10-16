import { createContext, useContext, useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { useMessages } from "../../core/i18n/index";
import { COMMUNITY_UI_MESSAGES } from "./communityMessages";

type IconName = "plugin" | "checklist" | "theme" | "note" | "workflow" | "tag" | "search" | "copy" | "arrow" | "close" | "refresh" | "info" | "browser" | "plus";
// Small, currentColor glyphs from the approved community preview. No brand asset changes.
const ICONS: Record<IconName, ReactNode> = {
  checklist: <><path d="m3 6 1 1 2-2M9 6h12M3 12l1 1 2-2M9 12h12M3 18l1 1 2-2M9 18h12" /></>,
  plugin: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8 9h8M8 13h4M15 13l2 2-2 2" /></>,
  theme: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16M12 4a8 8 0 0 1 0 16Z" /></>,
  note: <><rect x="6" y="3" width="12" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  workflow: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M6 9v7a2 2 0 0 0 2 2h7M15 15l3-3V9M12 6h6v3" /></>,
  tag: <><path d="M3 4h9l9 9-8 8-10-10Z" /><circle cx="8" cy="9" r="1" /></>,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.1" /></>,
  browser: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M8 6.5h.1M12 12v5m-3-3 3 3 3-3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
};
export function CommunityIcon({ name, tile = false }: { name: IconName; tile?: boolean }) {
  const glyph = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
  return tile ? <span className="community-tile">{glyph}</span> : glyph;
}

const CommunityDrawerHost = createContext<HTMLDivElement | null | undefined>(undefined);

/** A non-scrolling overlay sibling: page scrolling cannot move the drawer over shell chrome. */
export function CommunityDrawerBoundary({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <CommunityDrawerHost.Provider value={host}>
    <div className="community-viewport">
      {children}
      <div className="community-drawer-host" ref={setHost} />
    </div>
  </CommunityDrawerHost.Provider>;
}

type CommunityDrawerProps = {
  title: string; label: string; icon?: IconName; children: ReactNode; footer?: ReactNode;
  onClose: () => void; dismissible?: boolean;
};

/** Community presentation only; the application keeps its existing modal lease/focus authority. */
export function CommunityDrawer(props: CommunityDrawerProps) {
  const host = useContext(CommunityDrawerHost);
  // Wait for the local portal host before acquiring focus. Standalone package
  // surfaces (outside CommunityPage) retain their existing application portal.
  return host === null ? null : <CommunityDrawerSurface {...props} host={host} />;
}

function CommunityDrawerSurface({ title, label, icon = "plugin", children, footer, onClose, dismissible = true, host }: CommunityDrawerProps & { host?: HTMLDivElement }) {
  const { t } = useMessages(COMMUNITY_UI_MESSAGES);
  const titleId = useId();
  const { surfaceRef, onSurfaceKeyDown, onBackdropPointerDown } = useApplicationModalSurface<HTMLDivElement>(true, onClose, { closeOnEscape: dismissible, closeOnBackdrop: dismissible });
  useLayoutEffect(() => {
    // A completed action can remove its focused button while all controls are
    // disabled. Returning focus after that busy state keeps Escape and Tab local.
    const surface = surfaceRef.current;
    if (dismissible && surface && !surface.contains(document.activeElement)) {
      surface.focus({ preventScroll: true });
    }
  }, [dismissible, surfaceRef]);
  return createPortal(<div className="community-drawer-backdrop" style={host ? undefined : { position: "fixed" }} onPointerDown={onBackdropPointerDown}>
    <div ref={surfaceRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="community-drawer" onKeyDown={onSurfaceKeyDown}>
      <header className="community-drawer-top"><span><CommunityIcon name={icon} />{label}</span><button type="button" className="community-icon-button" aria-label={t("community.close")} disabled={!dismissible} onClick={onClose} data-modal-initial-focus><CommunityIcon name="close" /></button></header>
      <div className="community-drawer-scroll"><div className="community-drawer-title"><CommunityIcon name={icon} tile /><h2 id={titleId}>{title}</h2></div>{children}</div>
      {footer && <footer className="community-drawer-footer">{footer}</footer>}
    </div>
  </div>, host ?? document.body);
}

export function CommunityState({ kind, message, action }: { kind: "loading" | "empty" | "no-match" | "error"; message?: string; action?: ReactNode }) {
  const { t } = useMessages(COMMUNITY_UI_MESSAGES);
  if (kind === "loading") return <div role="status" className="community-loading"><p><CommunityIcon name="refresh" />{message ?? t("community.loading")}</p><div className="community-skeleton-grid" aria-hidden="true">{[0, 1].map(key => <div className="community-skeleton-card" key={key}><i /><span /><span /><span /></div>)}</div></div>;
  return <div className="community-empty" role={kind === "error" ? "alert" : "status"}><CommunityIcon name={kind === "no-match" ? "search" : kind === "error" ? "info" : "plugin"} tile /><h3>{message ?? t("community.noMatch")}</h3>{kind === "no-match" && <p>{t("community.noMatchHint")}</p>}{action}</div>;
}

export type CommunityStatusFilter = "all" | "enabled" | "disabled";
export function communityMatchesStatus(enabled: boolean, filter: CommunityStatusFilter): boolean {
  return filter === "all" || enabled === (filter === "enabled");
}

export function CommunityFilters<T extends string>({ options, value, onChange }: { options: ReadonlyArray<{ id: T; label: string; count?: number }>; value: T; onChange: (value: T) => void }) {
  const { t } = useMessages(COMMUNITY_UI_MESSAGES);
  return <div className="community-filters" role="group" aria-label={t("community.filters")}>{options.map(option => <button type="button" className="community-filter" key={option.id} aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}{option.count !== undefined && <span>{option.count}</span>}</button>)}</div>;
}
