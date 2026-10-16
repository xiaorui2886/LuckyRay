import { createContext, useContext, useRef, useState, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
const OverlayContext = createContext<HTMLElement | null>(null);

/** Themed shell sibling, outside retained-page clipping/transform contexts. */
export function ExperienceOverlayProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <OverlayContext.Provider value={host}>{children}
    <div ref={setHost} className="experience-overlay-root" data-experience-overlay />
  </OverlayContext.Provider>;
}
export function ExperienceOverlay({ children }: { children: ReactNode }) {
  const host = useContext(OverlayContext);
  return host ? createPortal(children, host) : <>{children}</>;
}
export type ExperienceNotice = { id: number; message: string; tone: "status" | "error" };
/** Page-owned notices, not another global service. Duplicate messages rearm by ID. */
export function useExperienceNotices() {
  const serial = useRef(0);
  const [notices, setNotices] = useState<ExperienceNotice[]>([]);
  const notify = useCallback((message: string, tone: ExperienceNotice["tone"] = "status") => {
    if (!message) { setNotices([]); return; }
    const id = ++serial.current;
    setNotices(current => [...current.filter(n => n.message !== message), { id, message, tone }].slice(-2));
  }, []);
  const dismiss = useCallback((id: number) => setNotices(current => current.filter(n => n.id !== id)), []);
  return { notices, notify, dismiss };
}
function OrdinaryNotice({ notice, onDismiss, hidden }: { notice: ExperienceNotice; onDismiss: () => void; hidden: boolean }) {
  const remaining = useRef(notice.tone === "error" || notice.message.length > 120 ? 5000 : 3000);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0), hovering = useRef(false), focused = useRef(false);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const resume = () => {
    if (hovering.current || focused.current || timer.current !== null) return;
    started.current = Date.now(); timer.current = setTimeout(() => dismiss.current(), remaining.current);
  };
  const pause = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current); timer.current = null;
      remaining.current = Math.max(0, remaining.current - (Date.now() - started.current));
    }
  };
  useEffect(() => { resume(); return () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }; }, []);
  useEffect(() => { if (hidden) { hovering.current = false; focused.current = false; resume(); } }, [hidden]);
  return <div hidden={hidden} aria-hidden={hidden || undefined} className={`experience-toast experience-ordinary-notice experience-ordinary-notice--${notice.tone}`}
    role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}
    onMouseEnter={() => { hovering.current = true; pause(); }} onMouseLeave={() => { hovering.current = false; resume(); }}
    onFocusCapture={() => { focused.current = true; pause(); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused.current = false; resume(); } }}>
    <svg className="experience-notice-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" />
      {notice.tone === "error" ? <path d="M10 5v6m0 3v.1" /> : <path d="m6 10 3 3 5-6" />}</svg>
    <span>{notice.message}</span>
  </div>;
}
export function ExperienceNotices({ notices, dismiss, maxVisible = 2 }: { notices: ExperienceNotice[]; dismiss: (id: number) => void; maxVisible?: number }) {
  return <ExperienceOverlay><div className="experience-ordinary-notices">
    {notices.map((notice, index) => <OrdinaryNotice key={notice.id} notice={notice} hidden={index < notices.length - maxVisible} onDismiss={() => dismiss(notice.id)} />)}
  </div></ExperienceOverlay>;
}
