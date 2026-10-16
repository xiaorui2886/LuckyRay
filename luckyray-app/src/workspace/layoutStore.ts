import { createLayout, decodeLayout, encodeLayout, reduceLayout, type LayoutCommand, type WorkspaceLayout } from './layout';

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;
const windowStores=new Map<string,LayoutStore>();
/** One presentation authority per actual application window. Sidebar and the
 * content route share it; separate instances would overwrite each other's UI. */
export function windowLayoutStore(windowId:string){let store=windowStores.get(windowId);if(!store){store=new LayoutStore(windowId,localStorage);windowStores.set(windowId,store);}return store;}
export class LayoutStore {
  private current: WorkspaceLayout;
  private listeners = new Set<() => void>();
  private past: WorkspaceLayout[] = [];
  private future: WorkspaceLayout[] = [];
  readonly key: string;
  storageError: string | null = null;
  readonly windowId: string;
  private storage?: LayoutStorage;
  constructor(windowId: string, storage?: LayoutStorage) {
    this.windowId = windowId; this.storage = storage;
    this.key = `luckyray-workspace-v1:${windowId}`;
    this.current = this.read(this.key) ?? this.read(`${this.key}:backup`) ?? createLayout(windowId);
  }
  private read(key: string) {
    try { const raw = this.storage?.getItem(key); return raw ? decodeLayout(JSON.parse(raw), this.windowId) : null; } catch { return null; }
  }
  getSnapshot = () => this.current;
  retainedViews() { return Object.values(Object.assign({}, ...this.past.map(item => item.views), ...this.future.map(item => item.views), this.current.views)) as import('./layout').ViewRef[]; }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  dispatch(command: LayoutCommand) {
    const next = reduceLayout(this.current, command);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    // Selection is not a structural move and must not crowd out layout undo.
    if (command.type !== 'activate') { this.past.push(this.current); this.past = this.past.slice(-30); this.future = []; }
    this.publish(next);
  }
  undo(accept?: (next: WorkspaceLayout) => boolean) {
    const next = this.past[this.past.length - 1];
    if (!next || (accept && !accept(next))) return false;
    this.past.pop(); this.future.push(this.current); this.publish(next); return true;
  }
  redo(accept?: (next: WorkspaceLayout) => boolean) {
    const next = this.future[this.future.length - 1];
    if (!next || (accept && !accept(next))) return false;
    this.future.pop(); this.past.push(this.current); this.publish(next); return true;
  }
  restore(value: unknown) {
    const next = decodeLayout(value, this.windowId); if (!next) return false;
    this.past.push(this.current); this.past = this.past.slice(-30); this.future = []; this.publish(next); return true;
  }
  /** Preset application needs a storage-first commit: a failed write must not
   * change the live shell after other page adapters have been prepared. */
  applyPresentation(presentation: import('./presentation').WorkspacePresentation): boolean {
    const next = reduceLayout(this.current, { type: 'presentation', presentation });
    try {
      if (this.storage) {
        this.storage.setItem(`${this.key}:backup`, encodeLayout(this.current));
        this.storage.setItem(this.key, encodeLayout(next));
      }
    } catch { this.storageError = '布局未保存，当前视图保持不变。请释放存储空间后重试。'; return false; }
    this.storageError = null;
    this.past.push(this.current); this.past = this.past.slice(-30); this.future = [];
    this.current = next; for (const callback of this.listeners) callback();
    return true;
  }
  private publish(next: WorkspaceLayout) {
    try {
      if (this.storage) { this.storage.setItem(`${this.key}:backup`, encodeLayout(this.current)); this.storage.setItem(this.key, encodeLayout(next)); }
      this.storageError = null;
    } catch { this.storageError = '布局暂未保存，当前视图仍保留。请释放存储空间后重试。'; }
    this.current = next; for (const callback of this.listeners) callback();
  }
}
