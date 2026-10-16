import type { EditorView } from "@codemirror/view";

/** Retains view-owned undo/selection/media only. Saved text and drafts remain with NotesPage. */
export class RetainedEditorViews {
  private readonly views = new Map<string, EditorView>();
  private readonly scroll = new WeakMap<EditorView, { effect: ReturnType<EditorView["scrollSnapshot"]>; top: number; left: number }>();
  private active = "";
  private readonly onMediaLoad = () => this.trim(this.active);
  constructor(
    private readonly capacity = 4,
    private readonly bytes = 96 * 1024 * 1024,
  ) {}
  take(key: string) {
    this.active = key;
    const view = this.views.get(key);
    if (view) {
      this.views.delete(key);
      this.views.set(key, view);
    }
    return view;
  }
  rename(from: string, to: string) {
    if (from === to) return;
    const view = this.views.get(from);
    if (!view) return;
    const obsolete = this.views.get(to);
    if (obsolete && obsolete !== view) this.dispose(obsolete);
    this.views.delete(from);
    this.views.set(to, view);
    if (this.active === from) this.active = to;
  }
  keep(key: string, view: EditorView) {
    this.active = key;
    view.dom.addEventListener("load", this.onMediaLoad, true);
    this.views.delete(key);
    this.views.set(key, view);
    this.trim(key);
  }
  detach(view: EditorView) {
    if (view.scrollDOM.scrollTop || view.scrollDOM.scrollLeft) this.scroll.set(view, {
      effect: view.scrollSnapshot(), top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft,
    });
    else this.scroll.delete(view);
    view.dom.querySelectorAll("video").forEach((video) => {
      video
        .closest(".lr-live-asset-card")
        ?.dispatchEvent(new MouseEvent("mouseleave"));
      video.pause();
    });
    view.contentDOM.blur();
    view.dom.remove();
  }
  restoreScroll(view: EditorView) {
    const snapshot = this.scroll.get(view);
    if (snapshot) {
      this.scroll.delete(view);
      view.scrollDOM.scrollTop = snapshot.top; view.scrollDOM.scrollLeft = snapshot.left;
      view.dispatch({ effects: snapshot.effect });
    }
  }
  trim(active: string) {
    const weight = (view: EditorView) =>
      view.state.doc.length * 2 +
      Array.from(view.dom.querySelectorAll("img")).reduce(
        (sum, image) => sum + image.naturalWidth * image.naturalHeight * 4,
        0,
      );
    let size = Array.from(this.views.values()).reduce(
      (sum, view) => sum + weight(view),
      0,
    );
    for (const [key, view] of this.views) {
      if (this.views.size <= this.capacity && size <= this.bytes) break;
      if (key === active) continue;
      size -= weight(view);
      this.views.delete(key);
      this.dispose(view);
    }
  }
  private dispose(view: EditorView) {
    view.dom.removeEventListener("load", this.onMediaLoad, true);
    view.destroy();
  }
  destroy() {
    this.views.forEach((view) => this.dispose(view));
    this.views.clear();
  }
}
