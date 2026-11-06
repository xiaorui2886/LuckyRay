import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { CanvasDialogPortal } from "./CanvasDialogScope";
import "./canvasSettingsDialog.css";

export type CanvasSettingsSection = "generation" | "connections" | "appearance";

type Props = {
  open: boolean;
  english: boolean;
  section: CanvasSettingsSection;
  onSectionChange: (section: CanvasSettingsSection) => void;
  onClose: () => void;
  children: ReactNode;
  hasDraft?: boolean;
};

/** Mount on first open, then retain drafts and keys across closes. */
export function CanvasSettingsDialog({ open, english, section, onSectionChange, onClose, children, hasDraft = false }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const backdropPress = useRef(false);
  const hasOpened = useRef(open);
  if (open) hasOpened.current = true;
  const contentId = useId();
  const tabs: { id: CanvasSettingsSection; label: string }[] = [
    { id: "generation", label: english ? "Generation" : "生成配置" },
    { id: "connections", label: english ? "Connections" : "连接设置" },
    { id: "appearance", label: english ? "Appearance" : "画布外观" },
  ];

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const restoreFocus = () => {
      // Navigation outside the canvas remains usable; never steal its focus.
      if ((dialog.contains(document.activeElement) || document.activeElement === document.body) && openerRef.current?.isConnected) {
        openerRef.current.focus({ preventScroll: true });
      }
    };
    if (!open) { restoreFocus(); return; }
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Wait for the shared portal to measure its canvas before moving focus.
    const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    // Cancelling an editor removes its focused button and leaves focus on body.
    // Escape should still close, without intercepting an outside navigation key.
    const escapeFromBody = (event: KeyboardEvent) => {
      if (document.activeElement === document.body && event.key === "Escape" && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); onClose();
      }
    };
    document.addEventListener("keydown", escapeFromBody);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escapeFromBody);
      // Run after React's own focus restoration on close/unmount.
      queueMicrotask(restoreFocus);
    };
  }, [open]);

  // On the initial CanvasInner commit the parent host ref is not attached yet.
  // First open happens after that commit; retaining the portal from then on
  // preserves drafts without measuring a permanently empty initial host.
  if (!hasOpened.current) return null;

  return (
    <CanvasDialogPortal><div
      className="canvas-settings-backdrop nodrag nopan nowheel"
      hidden={!open}
      onPointerDown={event => {
        event.stopPropagation();
        // Dismiss only if the gesture STARTS on the backdrop, never when a text
        // selection that began in a field happens to finish outside the dialog.
        backdropPress.current = event.target === event.currentTarget && event.button === 0 && event.isPrimary;
      }}
      onPointerUp={event => {
        event.stopPropagation();
        backdropPress.current = backdropPress.current && event.target === event.currentTarget;
      }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={event => {
        event.stopPropagation();
        // Consume the full pointer sequence before closing so pointerup cannot
        // land on the now-uncovered canvas and start a selection or action.
        if (backdropPress.current && event.target === event.currentTarget) onClose();
        backdropPress.current = false;
      }}
      onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') || [])
            .filter(control => !control.closest('[hidden],[inert]') && control.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
      onKeyUp={event => event.stopPropagation()}
    >
    <div ref={dialogRef} role="dialog" className="canvas-settings-dialog" aria-label={english ? "Canvas settings" : "画布设置"}>
      <div className="canvas-settings-dialog-layout">
        <nav className="canvas-settings-dialog-nav" aria-label={english ? "Settings sections" : "设置分类"}>
          {tabs.map(tab => (
            <button key={tab.id} type="button" aria-current={section === tab.id ? "page" : undefined} aria-controls={contentId} onClick={() => onSectionChange(tab.id)}>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="canvas-settings-dialog-main">
          <div className="canvas-settings-dialog-toolbar">
            <button ref={closeRef} type="button" className="canvas-settings-dialog-close" onClick={onClose} aria-label={english ? "Close canvas settings" : "关闭画布设置"} title={english ? "Close · Esc" : "关闭 · Esc"}>
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div id={contentId} className="canvas-settings-dialog-content" tabIndex={-1}>
            {children}
          </div>
        </div>
      </div>
      <footer className="canvas-settings-dialog-footer">
        <span>{hasDraft ? (english ? "Draft kept when closed · Save to apply" : "关闭保留草稿 · 保存后生效") : (section === "appearance" ? (english ? "Appearance changes apply immediately" : "外观设置即时生效") : "")}</span>
        <span className="canvas-settings-dialog-keyhint"><kbd>Esc</kbd> {english ? "Close" : "关闭"}</span>
      </footer>
    </div></div></CanvasDialogPortal>
  );
}
