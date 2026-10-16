import { createContext, useContext, useLayoutEffect, useRef } from "react";

export type FilenameActions = { rename: (id: string, name: string) => Promise<void | string>; namingId: string | null; busyId?: string | null; finish: (id: string) => void; focusBody?: () => void };
export const NoteFilenameContext = createContext<FilenameActions | null>(null);
export function filenameForNote(id: string | null | undefined, fallback: string) {
  return id?.startsWith("real-vault:") ? id.slice(11).replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/i, "") : fallback;
}

type FilenameUpdate = (id: string, title: string, actions: () => FilenameActions | null, focus: boolean) => boolean;
const controllers = new WeakMap<HTMLElement, FilenameUpdate>();
export function updateFilenameDOM(host: HTMLElement, id: string, title: string, actions: () => FilenameActions | null, focus: boolean) {
  const update = controllers.get(host);
  if (!update) return false;
  return update(id, title, actions, focus);
}

/** Retain the input and uncommitted text across filename/parent updates. */
export function filenameDOM(id: string, title: string, actions: () => FilenameActions | null, focus: boolean, done?: () => void) {
  const host = document.createElement("div"), input = document.createElement("input"), error = document.createElement("span");
  host.className = "note-filename"; host.contentEditable = "false";
  input.value = title; input.setAttribute("aria-label", "笔记文件名"); input.spellcheck = false;
  input.readOnly = !actions(); error.className = "note-filename-error"; error.setAttribute("role", "alert");
  let original = title, cancelled = false, requested = false, focusRequested = false;
  let pending: Promise<void> | null = null;
  const selectName = (wanted: boolean) => {
    if (wanted && !focusRequested) requestAnimationFrame(() => {
      if (input.isConnected && focusRequested) { input.focus({ preventScroll: true }); input.select(); }
    });
    focusRequested = wanted;
  };
  const commit = (): Promise<void> => {
    if (cancelled || !actions()) return Promise.resolve();
    requested = true;
    if (pending) return pending;
    pending = (async () => {
      while (requested) {
        requested = false;
        const api = actions();
        if (!api) return;
        const name = input.value.trim();
        if (!name) { input.value = original; api.finish(id); return; }
        if (name === original) { api.finish(id); return; }
        error.textContent = "";
        try {
          const renamedId = await api.rename(id, name);
          if (typeof renamedId === "string") id = renamedId;
          original = name;
          // finish only this input's naming request, never a newly opened note.
          api.finish(id);
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : String(reason);
          requested = false;
        }
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  input.addEventListener("blur", () => { void commit(); });
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void commit().then(() => { if (input.isConnected && !error.textContent && input.value.trim() === original) (actions()?.focusBody || done)?.(); });
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (pending) return;
      cancelled = true; input.value = original; error.textContent = ""; actions()?.finish(id); input.blur(); cancelled = false;
      (actions()?.focusBody || done)?.();
    }
  });
  input.addEventListener("pointerdown", event => event.stopPropagation());
  host.append(input, error);
  controllers.set(host, (nextId, nextTitle, nextActions, wanted) => {
    // Navigation during a pending rename needs a separate input/controller.
    // Only the confirmed rename target may inherit the in-flight draft.
    if (pending && nextId !== id && nextActions()?.busyId !== nextId) return false;
    const untouched = input.value === original;
    const switched = nextId !== id && !pending;
    id = nextId; actions = nextActions;
    if (switched || (!pending && untouched)) { original = nextTitle; input.value = nextTitle; }
    input.readOnly = !actions();
    selectName(wanted);
    return true;
  });
  selectName(focus);
  return host;
}

export function InlineFilename({ id, title, className = "note-inline-title" }: { id?: string | null; title: string; className?: string }) {
  const actions = useContext(NoteFilenameContext), ref = useRef<HTMLDivElement>(null), actionsRef = useRef(actions);
  actionsRef.current = actions;
  const name = filenameForNote(id, title);
  const naming = className === "note-inline-title" && actions?.namingId === id;
  useLayoutEffect(() => {
    if (!ref.current || !id) return;
    const existing = ref.current.firstElementChild as HTMLElement | null;
    if (existing && updateFilenameDOM(existing, id, name, () => actionsRef.current, naming)) return;
    ref.current.replaceChildren(filenameDOM(id, name, () => actionsRef.current, naming));
  }, [id, name, naming]);
  return <div className={className} ref={ref} />;
}
