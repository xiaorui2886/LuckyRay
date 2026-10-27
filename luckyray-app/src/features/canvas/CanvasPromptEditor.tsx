import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReferenceEntry } from "../../core/canvas/referencePlan";
import {
  encodeReferenceMention,
  encodeFocusReferenceMention,
  type ReferenceFocus,
  parseReferenceMentions,
} from "../../core/canvas/referenceMentions";
import { referencePreviewUrl } from "./CanvasReferencePreview";
import { CanvasPromptReferenceHover } from "./CanvasPromptReferenceHover";
import "./canvasPromptEditor.css";

export type CanvasPromptEditorHandle = {
  insertReference: (key: string) => void;
  insertFocusReference: (key: string, focus: ReferenceFocus) => void;
  focus: () => void;
};
export type CanvasPromptEditorProps = {
  value: string;
  onChange: (value: string) => void;
  entries: readonly ReferenceEntry[];
  placeholder?: string;
  onFocus?: () => void;
  owner?: string;
  className?: string;
  ariaLabel?: string;
};
type Bookmark = { start: number; end: number };
type EditSnapshot = { value: string; selection: Bookmark };
const rawToken = (node: Node) =>
  node instanceof HTMLElement ? node.dataset.referenceToken : undefined;
/** Display names are independent from the canonical keys and backend numbering. */
function referenceDisplayName(entry: ReferenceEntry | undefined): string {
  if (!entry) return "引用已移除";
  // Canvas text cards store their body as the label. Keep that body in the
  // preview, rather than turning a paragraph into the inline token's name.
  if (entry.reference.kind === "text" &&
      entry.reference.label.trim() === entry.reference.text?.trim()) return "文本";
  return (
    entry.reference.label.trim() ||
    (entry.reference.kind === "image"
      ? "未命名图片"
      : entry.reference.kind === "video"
        ? "未命名视频"
        : "未命名文本")
  );
}
function tokenIcon(document: Document, kind: string, className: string) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "remove" ? "m4 4 8 8m0-8-8 8"
    : kind === "image" ? "M2.5 2.5h11v11h-11zM3 11l3-3 2 2 2-3 3 4M6 5h.01"
      : kind === "video" ? "m5 3 7 5-7 5z" : "M3 4h10M3 8h7M3 12h10");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  return icon;
}
function displayNames(entries: readonly ReferenceEntry[]) {
  return new Map(
    entries.map((entry) => [entry.key, referenceDisplayName(entry)]),
  );
}
/** Only DOM text is read. Never insert user HTML into the editor. */
function serialize(node: Node): string {
  const token = rawToken(node);
  if (token !== undefined) return token;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeName === "BR") return "\n";
  // A solitary BR in an editable block is a browser caret placeholder, not
  // a user newline. This also covers <div><br></div>/<p><br></p> after deletion
  // and cloned Range fragments used to measure the caret. Real empty lines
  // between sibling blocks still contribute the block separator below.
  const children = Array.from(node.childNodes).filter(
    (child) => child.nodeType !== Node.TEXT_NODE || child.textContent !== "",
  );
  if (children.length === 1 && children[0].nodeName === "BR") return "";
  return children
    .map((child, index) => {
      const block = child.nodeName === "DIV" || child.nodeName === "P";
      return (block && index > 0 ? "\n" : "") + serialize(child);
    })
    .join("");
}
function getBookmark(root: HTMLElement): Bookmark | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const containingToken = (node: Node) => {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const token = element?.closest<HTMLElement>("[data-reference-token]");
    return token && root.contains(token) ? token : null;
  };
  const startToken = containingToken(range.startContainer),
    endToken = containingToken(range.endContainer);
  // Native selection APIs can point inside a non-editable token (e.g. assistive
  // selection or dragging). Expand selections to whole atoms; snap a caret after it.
  if (range.collapsed && startToken) {
    range.setStartAfter(startToken);
    range.collapse(true);
  } else {
    if (startToken) range.setStartBefore(startToken);
    if (endToken) range.setEndAfter(endToken);
  }
  const offset = (node: Node, at: number) => {
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(node, at);
    return serialize(prefix.cloneContents()).length;
  };
  return {
    start: offset(range.startContainer, range.startOffset),
    end: offset(range.endContainer, range.endOffset),
  };
}
function restoreBookmark(root: HTMLElement, bookmark: Bookmark) {
  const point = (target: number): [Node, number] => {
    let left = Math.max(0, target);
    for (let i = 0; i < root.childNodes.length; i++) {
      const node = root.childNodes[i];
      const length = serialize(node).length;
      if (left <= length) {
        if (node.nodeType === Node.TEXT_NODE) return [node, left];
        return [root, i + (left > 0 ? 1 : 0)];
      }
      left -= length;
    }
    return [root, root.childNodes.length];
  };
  const range = root.ownerDocument.createRange();
  range.setStart(...point(bookmark.start));
  range.setEnd(...point(bookmark.end));
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const CanvasPromptEditor = forwardRef<
  CanvasPromptEditorHandle,
  CanvasPromptEditorProps
>(function CanvasPromptEditor(
  {
    value,
    onChange,
    entries,
    placeholder,
    onFocus,
    owner,
    className = "",
    ariaLabel = "提示词",
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const [previewToken, setPreviewToken] = useState<HTMLElement | null>(null);
  const previewTokenRef = useRef<HTMLElement | null>(null);
  const bookmark = useRef<Bookmark | null>(null);
  const composing = useRef(false);
  const latest = useRef({ value, entries, onChange });
  latest.current = { value, entries, onChange };
  const rendered = useRef("");
  const renderedLabels = useRef("");
  const labelSignature = () =>
    JSON.stringify(
      latest.current.entries.map((entry) => [
        entry.key,
        entry.reference.kind,
        entry.reference.label,
        entry.issue,
        entry.reference.thumbnailUrl,
        entry.reference.mediaUrl,
        entry.reference.text,
      ]),
    );
  const currentOwner = useRef(owner);
  const queued = useRef<string[]>([]);
  const history = useRef<{ past: EditSnapshot[]; future: EditSnapshot[] }>({
    past: [],
    future: [],
  });
  const beforeEdit = useRef<EditSnapshot | null>(null);
  function closePreview() {
    const token = previewTokenRef.current;
    if (!token) return;
    token.removeAttribute("aria-describedby");
    token.querySelector("button")?.removeAttribute("aria-describedby");
    previewTokenRef.current = null;
    setPreviewToken(null);
  }
  function showPreview(token: HTMLElement | null) {
    if (!token || composing.current || previewTokenRef.current === token) return;
    closePreview();
    if (!latest.current.entries.some(entry => entry.key === token.dataset.referenceKey)) return;
    token.setAttribute("aria-describedby", previewId);
    token.querySelector("button")?.setAttribute("aria-describedby", previewId);
    previewTokenRef.current = token;
    setPreviewToken(token);
  }
  function tokenAt(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    const token = element?.closest<HTMLElement>("[data-reference-token]");
    return token && rootRef.current?.contains(token) ? token : null;
  }
  function removeToken(token: HTMLElement) {
    const root = rootRef.current;
    if (!root || !root.contains(token) || composing.current) return;
    const raw = rawToken(token);
    if (!raw) return;
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(root);
    prefix.setEndBefore(token);
    const start = serialize(prefix.cloneContents()).length;
    const current = serialize(root);
    // Resolve the specific DOM occurrence, never replace every matching key.
    if (current.slice(start, start + raw.length) !== raw) return;
    captureBeforeEdit();
    root.focus();
    commit(current.slice(0, start) + current.slice(start + raw.length), { start, end: start });
  }
  function captureBeforeEdit() {
    const root = rootRef.current;
    if (root)
      beforeEdit.current = {
        value: serialize(root),
        selection: getBookmark(root) ||
          bookmark.current || { start: 0, end: 0 },
      };
  }
  function remember(previous: string) {
    const snapshot =
      beforeEdit.current?.value === previous
        ? beforeEdit.current
        : {
            value: previous,
            selection: bookmark.current || {
              start: previous.length,
              end: previous.length,
            },
          };
    const past = history.current.past;
    if (past[past.length - 1]?.value !== snapshot.value) past.push(snapshot);
    if (past.length > 100) past.shift();
    history.current.future = [];
    beforeEdit.current = null;
  }
  function travelHistory(redo: boolean) {
    const root = rootRef.current;
    if (!root) return;
    const from = redo ? history.current.future : history.current.past;
    const to = redo ? history.current.past : history.current.future;
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push({
      value: serialize(root),
      selection: getBookmark(root) || bookmark.current || { start: 0, end: 0 },
    });
    bookmark.current = snapshot.selection;
    beforeEdit.current = null;
    draw(snapshot.value, snapshot.selection);
    latest.current.value = snapshot.value;
    latest.current.onChange(snapshot.value);
  }

  function draw(text: string, selection?: Bookmark | null) {
    const root = rootRef.current;
    if (!root) return;
    closePreview();
    const labels = displayNames(latest.current.entries);
    const byKey = new Map(
      latest.current.entries.map((entry) => [entry.key, entry]),
    );
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const part of parseReferenceMentions(text)) {
      if (part.type === "text") {
        fragment.append(root.ownerDocument.createTextNode(part.text));
        continue;
      }
      const entry = byKey.get(part.key);
      const token = root.ownerDocument.createElement("span");
      token.className =
        "canvas-prompt-token" + (!entry || entry.issue ? " is-invalid" : "");
      token.dataset.referenceToken = part.raw;
      token.dataset.referenceKey = part.key;
      token.contentEditable = "false";
      const name = entry
        ? part.focus?.label || labels.get(part.key)!
        : "引用已移除";
      const remove = root.ownerDocument.createElement("button");
      remove.type = "button";
      remove.className = "canvas-prompt-token-remove";
      remove.setAttribute("aria-label", `移除提示词引用：${name}`);
      remove.append(tokenIcon(root.ownerDocument, entry?.reference.kind || "text", "canvas-prompt-token-icon"));
      remove.append(tokenIcon(root.ownerDocument, "remove", "canvas-prompt-token-cross"));
      token.append(remove);
      const label = root.ownerDocument.createElement("span");
      label.className = "canvas-prompt-token-label";
      label.textContent = name;
      token.append(label);
      token.setAttribute("aria-label", name);
      if (entry?.reference.kind === "image" || entry?.reference.kind === "video") {
        const urls = [...new Set([
          entry.reference.thumbnailUrl,
          entry.reference.kind === "image" ? entry.reference.mediaUrl : undefined,
        ].map(referencePreviewUrl).filter(Boolean))];
        if (urls.length) {
          let imageIndex = 0;
          const thumb = root.ownerDocument.createElement("img");
          thumb.src = urls[imageIndex];
          thumb.alt = "";
          thumb.draggable = false;
          thumb.onerror = () => {
            if (++imageIndex < urls.length) thumb.src = urls[imageIndex];
            else thumb.remove();
          };
          thumb.className = "canvas-prompt-token-thumb";
          remove.prepend(thumb);
        }
      }
      fragment.append(token);
    }
    // A text landing point after the final atom works consistently in Chromium/WebKit.
    fragment.append(root.ownerDocument.createTextNode(""));
    root.replaceChildren(fragment);
    root.dataset.empty = String(!text);
    rendered.current = text;
    renderedLabels.current = labelSignature();
    if (selection) restoreBookmark(root, selection);
  }
  function commit(text: string, next: Bookmark) {
    if (text !== rendered.current) remember(rendered.current);
    bookmark.current = next;
    draw(text, next);
    latest.current.value = text;
    latest.current.onChange(text);
  }
  function insert(text: string) {
    const root = rootRef.current;
    if (!root) return;
    captureBeforeEdit();
    const current = serialize(root);
    const selected = getBookmark(root) ||
      bookmark.current || { start: current.length, end: current.length };
    const start = Math.min(selected.start, current.length),
      end = Math.min(selected.end, current.length);
    root.focus();
    const next = start + text.length;
    commit(current.slice(0, start) + text + current.slice(end), {
      start: next,
      end: next,
    });
  }
  useImperativeHandle(ref, () => ({
    insertReference(key) {
      if (!latest.current.entries.some((entry) => entry.key === key)) return;
      if (composing.current) {
        queued.current.push(encodeReferenceMention(key));
        return;
      }
      insert(encodeReferenceMention(key));
    },
    insertFocusReference(key, focus) {
      if (!latest.current.entries.some((entry) => entry.key === key)) return;
      const text = encodeFocusReferenceMention(key, focus);
      if (composing.current) {
        queued.current.push(text);
        return;
      }
      insert(text);
    },
    focus() {
      rootRef.current?.focus();
      if (rootRef.current && bookmark.current)
        restoreBookmark(rootRef.current, bookmark.current);
    },
  }));
  useLayoutEffect(() => {
    const root = rootRef.current;
    const changedOwner = currentOwner.current !== owner;
    if (composing.current && !changedOwner) return;
    if (changedOwner) {
      composing.current = false;
      queued.current = [];
    }
    currentOwner.current = owner;
    if (changedOwner) bookmark.current = null;
    if (changedOwner || value !== rendered.current) {
      history.current = { past: [], future: [] };
      beforeEdit.current = null;
    }
    if (
      !changedOwner &&
      root &&
      serialize(root) === value &&
      renderedLabels.current === labelSignature()
    )
      return;
    const focused = root?.ownerDocument.activeElement === root;
    const selected = changedOwner
      ? null
      : (root && getBookmark(root)) || bookmark.current;
    draw(value, focused ? selected : null);
  }, [value, entries, owner]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const save = () => {
      const selected = getBookmark(root);
      if (selected) bookmark.current = selected;
    };
    root.ownerDocument.addEventListener("selectionchange", save);
    return () =>
      root.ownerDocument.removeEventListener("selectionchange", save);
  }, []);
  useEffect(() => {
    if (!previewToken) return;
    const dismiss = (event: Event) => {
      if (tokenAt(event.target) !== previewToken) closePreview();
    };
    const document = previewToken.ownerDocument;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing.current || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closePreview();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    document.defaultView?.addEventListener("blur", closePreview);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
      document.defaultView?.removeEventListener("blur", closePreview);
    };
  }, [previewToken]);
  const publish = () => {
    const root = rootRef.current;
    if (!root || composing.current) return;
    const text = serialize(root);
    bookmark.current = getBookmark(root) || bookmark.current;
    root.dataset.empty = String(!text);
    if (text !== rendered.current) {
      closePreview();
      remember(rendered.current);
      rendered.current = text;
      latest.current.value = text;
      latest.current.onChange(text);
    }
  };
  const previewEntry = previewToken && entries.find(entry => entry.key === previewToken.dataset.referenceKey);
  return (<>
    <div
      ref={rootRef}
      className={`canvas-prompt-editor nodrag nowheel ${className}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-placeholder={placeholder}
      spellCheck
      onFocus={(event) => {
        onFocus?.();
        showPreview(tokenAt(event.target));
      }}
      onBlur={(event) => {
        if (rootRef.current)
          bookmark.current = getBookmark(rootRef.current) || bookmark.current;
        if (!previewTokenRef.current?.contains(event.relatedTarget)) closePreview();
      }}
      onPointerOver={(event) => {
        if (event.pointerType !== "touch") showPreview(tokenAt(event.target));
      }}
      onPointerOut={(event) => {
        const token = tokenAt(event.target);
        if (token && !token.contains(event.relatedTarget as Node | null) &&
            !token.contains(token.ownerDocument.activeElement)) closePreview();
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest(".canvas-prompt-token-remove")) {
          // Clicking × must not move the native caret into a non-editable atom.
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        if ((event.target as Element).closest(".canvas-prompt-token-remove")) {
          event.preventDefault();
          event.stopPropagation();
          const token = tokenAt(event.target);
          if (token) removeToken(token);
        }
      }}
      onBeforeInput={() => {
        if (!composing.current) captureBeforeEdit();
      }}
      onInput={publish}
      onCompositionStart={() => {
        closePreview();
        captureBeforeEdit();
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        publish();
        const root = rootRef.current;
        if (root) draw(serialize(root), getBookmark(root));
        for (const text of queued.current.splice(0)) insert(text);
      }}
      onCopy={(event) => {
        const root = rootRef.current;
        const selected = root && getBookmark(root);
        if (!root || !selected) return;
        const labels = displayNames(latest.current.entries);
        const text = parseReferenceMentions(
          serialize(root).slice(selected.start, selected.end),
        )
          .map((part) =>
            part.type === "text"
              ? part.text
              : labels.has(part.key)
                ? part.focus?.label || labels.get(part.key)!
                : "引用已移除",
          )
          .join("");
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
      }}
      onCut={(event) => {
        const root = rootRef.current;
        const selected = root && getBookmark(root);
        if (!root || !selected || composing.current) return;
        const text = serialize(root);
        const labels = displayNames(latest.current.entries);
        event.preventDefault();
        event.clipboardData.setData(
          "text/plain",
          parseReferenceMentions(text.slice(selected.start, selected.end))
            .map((part) =>
              part.type === "text"
                ? part.text
                : labels.has(part.key)
                  ? part.focus?.label || labels.get(part.key)!
                  : "引用已移除",
            )
            .join(""),
        );
        commit(text.slice(0, selected.start) + text.slice(selected.end), {
          start: selected.start,
          end: selected.start,
        });
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData
          .getData("text/plain")
          .replace(/\r\n?/g, "\n");
        if (composing.current) {
          queued.current.push(text);
          return;
        }
        insert(text);
      }}
      onDrop={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        const isComposing =
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229;
        if (event.key === "Escape" && !isComposing) {
          if (previewTokenRef.current) {
            event.preventDefault();
            event.stopPropagation();
            closePreview();
          }
          return;
        }
        event.stopPropagation();
        if (isComposing) return;
        if ((event.target as Element).closest(".canvas-prompt-token-remove") &&
            ["Enter", " ", "Backspace", "Delete"].includes(event.key)) {
          event.preventDefault();
          const token = tokenAt(event.target);
          if (token) removeToken(token);
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
        ) {
          event.preventDefault();
          travelHistory(event.key.toLowerCase() === "y" || event.shiftKey);
          return;
        }
        captureBeforeEdit();
        if (event.key === "Enter") {
          event.preventDefault();
          insert("\n");
          return;
        }
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        const root = rootRef.current;
        if (!root) return;
        const selected = getBookmark(root);
        if (!selected) return;
        const text = serialize(root);
        if (selected.start !== selected.end) {
          if (
            parseReferenceMentions(
              text.slice(selected.start, selected.end),
            ).some((part) => part.type === "reference")
          ) {
            event.preventDefault();
            commit(text.slice(0, selected.start) + text.slice(selected.end), {
              start: selected.start,
              end: selected.start,
            });
          }
          return;
        }
        let offset = 0;
        for (const part of parseReferenceMentions(text)) {
          const length =
            part.type === "text" ? part.text.length : part.raw.length;
          if (
            part.type === "reference" &&
            ((event.key === "Backspace" &&
              selected.start === offset + length) ||
              (event.key === "Delete" && selected.start === offset))
          ) {
            event.preventDefault();
            commit(text.slice(0, offset) + text.slice(offset + length), {
              start: offset,
              end: offset,
            });
            return;
          }
          offset += length;
        }
      }}
    />
    {previewToken && previewEntry ? <CanvasPromptReferenceHover
      id={previewId} anchor={previewToken} entry={previewEntry}
    /> : null}
    </>
  );
});
