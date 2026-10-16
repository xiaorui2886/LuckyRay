import {NoteRouteVisibilityContext} from "../noteRouteVisibility";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Decoration, EditorView, WidgetType, lineNumbers } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import "./noteDisplay.css";
import { filenameDOM, updateFilenameDOM, type FilenameActions } from "./noteFilename";

export type NoteDisplay = { limitWidth: boolean; lineNumbers: boolean; inlineTitle: boolean };
const storageKey = "luckyray.notes.display.v1";
const defaults: NoteDisplay = { limitWidth: false, lineNumbers: false, inlineTitle: false };
function read(): NoteDisplay {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof saved?.[key] === "boolean" ? saved[key] : value])) as NoteDisplay;
  } catch { return defaults; }
}
let current = read();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const sync = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    current = read(); listeners.forEach(notify => notify());
  };
  window.addEventListener("storage", sync);
  return () => { listeners.delete(listener); window.removeEventListener("storage", sync); };
}
export function useNoteDisplay() { return useSyncExternalStore(subscribe, () => current, () => defaults); }
function toggle(key: keyof NoteDisplay) {
  current = { ...current, [key]: !current[key] };
  try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* Session preference still works in restricted storage. */ }
  listeners.forEach(notify => notify());
}

/** Content padding and the outer constrained-width margins, never a media/text hit. */
export function isNoteMargin(event: { clientX: number; target: EventTarget | null }, content: HTMLElement) {
  if (event.target instanceof Element && event.target.closest(".note-media,button,a,input,.cm-gutters")) return false;
  const rect = content.getBoundingClientRect(), style = getComputedStyle(content);
  return event.clientX < rect.left + parseFloat(style.paddingLeft || "0")
    || event.clientX > rect.right - parseFloat(style.paddingRight || "0");
}

export function useNoteDisplayMenu() {
  const visible = useContext(NoteRouteVisibilityContext);
  const preferences = useNoteDisplay();
  const [position, setPosition] = useState<{ x: number; y: number; restore: HTMLElement | null } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible || !position || !ref.current) return;
    const menu = ref.current, bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(position.x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(position.y, innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [position, visible]);
  useEffect(() => {
    if (!visible || !position) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setPosition(null); };
    const close = () => setPosition(null);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", close); };
  }, [position, visible]);
  useEffect(() => { if (!visible) setPosition(null); }, [visible]);
  const closeAndRestore = () => { if (visible) position?.restore?.focus({ preventScroll: true }); setPosition(null); };
  const labels: [keyof NoteDisplay, string][] = [["limitWidth", "限制行宽"], ["lineNumbers", "行号"], ["inlineTitle", "页面内标题"]];
  const menu = visible && position ? createPortal(<div ref={ref} className="note-display-menu" role="menu" aria-label="笔记显示设置"
    style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); closeAndRestore(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    }}>
    {labels.map(([key, label]) => <button key={key} type="button" role="menuitemcheckbox" aria-checked={preferences[key]}
      onClick={() => { toggle(key); closeAndRestore(); }}><span>{label}</span><span aria-hidden="true">{preferences[key] ? "✓" : ""}</span></button>)}
  </div>, document.body) : null;
  return { preferences, menu, open(event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) {
    if (!visible) return;
    event.preventDefault(); event.stopPropagation();
    setPosition({ x: event.clientX, y: event.clientY, restore: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  } };
}

class InlineTitle extends WidgetType {
  constructor(readonly title: string, readonly id: string, readonly actions: () => FilenameActions | null, readonly focus: boolean) { super(); }
  eq(other: InlineTitle) { return this.title === other.title && this.id === other.id && this.focus === other.focus; }
  updateDOM(dom: HTMLElement) { return updateFilenameDOM(dom, this.id, this.title, this.actions, this.focus); }
  toDOM(view: EditorView) {
    const title = filenameDOM(this.id, this.title, this.actions, this.focus, () => { if (view.dom.isConnected) view.focus(); });
    title.className = "note-inline-title";
    return title;
  }
}
export function noteDisplayExtension(preferences: NoteDisplay, title: string, id = "", actions: () => FilenameActions | null = () => null, focus = false) {
  return [
    EditorView.editorAttributes.of({ "data-limit-width": String(preferences.limitWidth) }),
    preferences.lineNumbers ? lineNumbers() : [],
    preferences.inlineTitle || focus ? StateField.define({
      create: () => Decoration.set([Decoration.widget({ widget: new InlineTitle(title, id, actions, focus), block: true, side: -1 }).range(0)]),
      update: value => value,
      provide: field => EditorView.decorations.from(field),
    }) : [],
  ];
}
