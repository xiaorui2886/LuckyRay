type Bounds = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };

/** Keep the complete toolbar inside the visible clipping ancestors, without
 * enlarging an intrinsic-size image or dropping any of its actions. */
export function placeNoteMediaActions(media: Bounds, actions: Size, clip: Bounds) {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  return {
    left: clamp(media.right - Math.min(8, (media.right - media.left) / 2) - actions.width, clip.left, Math.max(clip.left, clip.right - actions.width)) - media.left,
    top: clamp(media.top + Math.min(8, (media.bottom - media.top) / 2), clip.top, Math.max(clip.top, clip.bottom - actions.height)) - media.top,
  };
}

export function attachNoteMediaActions(root: HTMLElement, actions: HTMLElement) {
  const owner = root.ownerDocument;
  const window = owner.defaultView;
  if (!window) return () => {};
  let frame: number | undefined;
  let disposed = false;
  const observed = new Set<Element>();
  const properties = ["left", "right", "top", "max-width"];
  const previous = properties.map(name => [name, actions.style.getPropertyValue(name), actions.style.getPropertyPriority(name)] as const);
  const observe = (element: Element) => {
    if (!observed.has(element)) { observed.add(element); observer.observe(element); }
  };
  const update = () => {
    if (disposed || !root.isConnected || !actions.isConnected) return;
    const media = root.getBoundingClientRect();
    if (!media.width || !media.height) return;
    const clip: Bounds = { left: 0, top: 0,
      right: Math.min(window.innerWidth, owner.documentElement.clientWidth || window.innerWidth),
      bottom: Math.min(window.innerHeight, owner.documentElement.clientHeight || window.innerHeight) };
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      const textColumn = parent.matches(".note-preview,.cm-content");
      if (!x && !y && !textColumn) continue;
      observe(parent);
      const rect = parent.getBoundingClientRect();
      const sx = parent.offsetWidth ? rect.width / parent.offsetWidth : 1;
      const sy = parent.offsetHeight ? rect.height / parent.offsetHeight : 1;
      if (x) { clip.left = Math.max(clip.left, rect.left + parent.clientLeft * sx); clip.right = Math.min(clip.right, rect.left + (parent.clientLeft + parent.clientWidth) * sx); }
      // Keep controls out of CodeMirror gutters and the reading pane's padding.
      if (textColumn) {
        clip.left = Math.max(clip.left, rect.left + (parent.clientLeft + (parseFloat(style.paddingLeft) || 0)) * sx);
        clip.right = Math.min(clip.right, rect.left + (parent.clientLeft + parent.clientWidth - (parseFloat(style.paddingRight) || 0)) * sx);
      }
      if (y) { clip.top = Math.max(clip.top, rect.top + parent.clientTop * sy); clip.bottom = Math.min(clip.bottom, rect.top + (parent.clientTop + parent.clientHeight) * sy); }
    }
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    const sx = root.offsetWidth ? media.width / root.offsetWidth : 1;
    const sy = root.offsetHeight ? media.height / root.offsetHeight : 1;
    const maxWidth = `${(clip.right - clip.left) / sx}px`;
    if (actions.style.maxWidth !== maxWidth) actions.style.maxWidth = maxWidth;
    const size = actions.getBoundingClientRect();
    const placement = placeNoteMediaActions(media, size, clip);
    // Convert viewport offsets back to the root's local CSS coordinates.
    actions.style.right = "auto";
    actions.style.left = `${placement.left / sx}px`;
    actions.style.top = `${placement.top / sy}px`;
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => { frame = undefined; update(); });
  };
  const observer = new ResizeObserver(schedule);
  const onScroll = () => {
    // Hidden toolbars remeasure on pointer/focus entry; ordinary scrolling must
    // not read every image's layout in a long note.
    if (root.matches(":hover,:focus-within") || window.matchMedia("(hover: none)").matches) schedule();
  };
  observe(root);
  observe(actions);
  root.addEventListener("pointerenter", update);
  root.addEventListener("focusin", update);
  owner.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", schedule);
  schedule();
  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    observer.disconnect();
    root.removeEventListener("pointerenter", update);
    root.removeEventListener("focusin", update);
    owner.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", schedule);
    for (const [name, value, priority] of previous) {
      if (value) actions.style.setProperty(name, value, priority); else actions.style.removeProperty(name);
    }
  };
}
