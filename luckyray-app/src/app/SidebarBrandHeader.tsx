import type { CSSProperties } from "react";
import sidebarCollapseIconUrl from "../assets/icons/lightseek-ui-v2/sidebar-collapse.svg";
import sidebarExpandIconUrl from "../assets/icons/lightseek-ui-v2/sidebar-expand.svg";

/** One stable keyboard target in both layouts; hovering never changes navigation state. */
export function SidebarBrandHeader({ collapsed, onToggle, expandLabel, collapseLabel }: {
  collapsed: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const label = collapsed ? expandLabel : collapseLabel;
  return (
    <div className="sidebar-header" data-collapsed={collapsed ? "true" : "false"}>
      <div className="logo-mark sidebar-expanded-brand" aria-hidden="true">
        <img src="/luckyray-logo.png" alt="" draggable={false} />
      </div>
      <span className="logo-text">luckyray</span>
      <button
        type="button"
        className="sidebar-brand-toggle"
        onClick={onToggle}
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls="main-sidebar-navigation"
        title={label}
        data-tauri-no-drag="true"
      >
        <span className="logo-mark sidebar-toggle-brand" aria-hidden="true">
          <img src="/luckyray-logo.png" alt="" draggable={false} />
        </span>
        <span
          className="sidebar-masked-icon sidebar-brand-toggle-icon"
          style={{ "--sidebar-icon-url": `url("${collapsed ? sidebarExpandIconUrl : sidebarCollapseIconUrl}")` } as CSSProperties}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
