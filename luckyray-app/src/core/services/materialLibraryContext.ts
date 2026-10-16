export type MaterialLibrary = {
  id: string; name: string; rootPath: string | null; storageMode: "managed" | "linked" | "source";
  visible: boolean; state: "ready" | "creating" | "offline" | "conflict";
  preferences: Record<string, unknown>; version: number;
};
export type MaterialLibraryRegistry = { libraries: MaterialLibrary[]; legacyId: string; activeId: string };
export type MaterialLibrarySnapshot = {
  registry: MaterialLibraryRegistry | null; libraryId: string | null; generation: number;
  status: "idle" | "loading" | "switching" | "ready" | "error"; error: string | null;
};
export type MaterialLibraryRequest = { libraryId: string | null; vaultId?: string; action: Record<string, unknown> };
export type MaterialLibraryTransport = <T>(request: MaterialLibraryRequest) => Promise<T>;
const nativeTransport: MaterialLibraryTransport = async <T>(request: MaterialLibraryRequest) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>("material_library_command", { request });
};
type PreferenceSave = {
  values: Record<string, unknown>; version: number; inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null; error: string | null; needsBase: boolean;
};

export class MaterialLibrarySession {
  private state: MaterialLibrarySnapshot = { registry: null, libraryId: null, generation: 0, status: "idle", error: null };
  private listeners = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private selectionCommits = 0;
  private initializing: Promise<MaterialLibraryRegistry> | null = null;
  private preferenceSaves = new Map<string, PreferenceSave>();
  private preferenceCommits = new Map<string, number>();
  private transport: MaterialLibraryTransport;
  constructor(transport: MaterialLibraryTransport = nativeTransport) { this.transport = transport; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  capture() { return { libraryId: this.state.libraryId, generation: this.state.generation }; }
  isCurrent(context: ReturnType<MaterialLibrarySession["capture"]>) { return context.libraryId === this.state.libraryId && context.generation === this.state.generation; }
  request<T>(action: Record<string, unknown>, libraryId = this.state.libraryId) {
    // Identity is copied before any dialog/network/IO promise can yield.
    return this.transport<T>({ libraryId, action }).then(value => {
      if (typeof window !== "undefined" && libraryId && (action.op === "videoFrame" || catalogMutations.has(String(action.op)))) window.dispatchEvent(new CustomEvent("luckyray:material-library-change", { detail: { libraryId } }));
      return value;
    }).catch(error => {
      if (libraryId && libraryId === this.state.libraryId && /library-(unavailable|offline|conflict)/.test(message(error))) {
        void this.refresh().catch(() => {});
      }
      throw error;
    });
  }
  initialize(): Promise<MaterialLibraryRegistry> {
    if (this.state.registry && this.state.status !== "error") return Promise.resolve(this.state.registry);
    if (this.initializing) return this.initializing;
    this.initializing = (this.state.registry ? this.refresh() : this.initializeRegistry()).finally(() => { this.initializing = null; });
    return this.initializing;
  }
  private async initializeRegistry() {
    const sequence = ++this.sequence;
    this.publish({ status: "loading", error: null });
    try {
      const registry = await this.readRegistry(false);
      if (sequence !== this.sequence) return registry;
      this.publish({ registry, libraryId: registry.activeId, generation: this.state.generation + 1, status: "ready", error: null });
      return registry;
    } catch (error) { if (sequence === this.sequence) this.publish({ status: "error", error: message(error) }); throw error; }
  }
  async refresh(includeHidden = false) {
    const sequence = this.sequence;
    const registry = await this.readRegistry(includeHidden);
    if (sequence === this.sequence) {
      if (this.state.status === "switching") this.publish({ registry: { ...registry, activeId: this.state.libraryId ?? registry.activeId } });
      else this.publish({ registry, libraryId: registry.activeId,
        generation: this.state.generation + (this.state.libraryId === registry.activeId ? 0 : 1),
        status: "ready", error: this.preferenceSaves.get(registry.activeId)?.error ?? (this.state.status === "error" ? null : this.state.error) });
    }
    return registry;
  }
  select(libraryId: string) {
    const sequence = ++this.sequence;
    let committed = false;
    this.publish({ generation: this.state.generation + 1, status: "switching", error: null });
    const operation = this.serial.catch(() => {}).then(async () => {
      await this.request({ op: "select" }, libraryId);
      committed = true;
      this.selectionCommits++;
      // Even a superseded selection has really committed. A later failure must
      // retain that identity, rather than showing the identity from before it.
      this.publish({ libraryId, registry: this.state.registry && { ...this.state.registry, activeId: libraryId } });
      const registry = await this.readRegistry(false);
      if (sequence === this.sequence) this.publish({ registry, libraryId: registry.activeId, status: "ready", error: this.preferenceSaves.get(registry.activeId)?.error ?? null });
      return registry;
    });
    this.serial = operation;
    return operation.catch(error => { if (sequence === this.sequence) this.publish({ status: committed ? "error" : "ready", error: message(error) }); throw error; });
  }
  private async readRegistry(includeHidden: boolean): Promise<MaterialLibraryRegistry> {
    const sequence = this.sequence;
    const selectionCommits = this.selectionCommits;
    const commits = new Map(this.preferenceCommits);
    const result = await this.request<MaterialLibraryRegistry>({ op: "registry", include_hidden: includeHidden }, null);
    if (sequence !== this.sequence) return result;
    if (selectionCommits !== this.selectionCommits) return this.readRegistry(includeHidden);
    const registry = { ...result, libraries: result.libraries.map(library => {
      // A read begun before a save ACK cannot restore its older preferences.
      const current = this.state.registry?.libraries.find(item => item.id === library.id);
      return current && (this.preferenceCommits.get(library.id) ?? 0) !== (commits.get(library.id) ?? 0)
        ? { ...library, preferences: current.preferences } : library;
    }) };
    this.restorePreferences(registry);
    return registry;
  }
  private restorePreferences(registry: MaterialLibraryRegistry) {
    if (typeof localStorage === "undefined") return;
    for (const library of registry.libraries) {
      if (this.preferenceSaves.has(library.id)) continue;
      for (const [key, value] of Object.entries(library.preferences)) {
        if ((key.startsWith("luckyray-materials-") || key.startsWith("luckyray-material-watch-")) && typeof value === "string") localStorage.setItem(materialLibraryStorageKey(key, library.id), value);
      }
    }
  }
  writePreference(key: string, value: string, id = this.state.libraryId) {
    if (typeof localStorage !== "undefined") localStorage.setItem(materialLibraryStorageKey(key, id), value);
    if (!id) return;
    let save = this.preferenceSaves.get(id);
    if (!save) {
      const library = this.state.registry?.libraries.find(library => library.id === id);
      save = { values: { ...library?.preferences }, version: 0, timer: null, inFlight: false, error: null, needsBase: !library };
      this.preferenceSaves.set(id, save);
    }
    save.values = { ...save.values, [key]: value }; save.version++;
    if (save.timer !== null) clearTimeout(save.timer);
    const batch = save;
    batch.timer = setTimeout(() => { batch.timer = null; void this.savePreferences(id, batch); }, 180);
  }
  private async savePreferences(id: string, save: PreferenceSave) {
    if (save.inFlight || save.timer !== null || this.preferenceSaves.get(id) !== save) return;
    const version = save.version; let values = { ...save.values };
    save.inFlight = true;
    try {
      // A frozen background target may have been hidden from the latest list.
      // Fetch its authority before replacing the full JSON, rather than using {}.
      if (save.needsBase) {
        const registry = await this.readRegistry(true);
        const library = registry.libraries.find(item => item.id === id);
        if (!library) throw new Error("任务所属素材库未登记");
        values = { ...library.preferences, ...values };
        save.values = { ...library.preferences, ...save.values }; save.needsBase = false;
        if (this.state.registry && !this.state.registry.libraries.some(item => item.id === id)) this.publish({ registry: { ...this.state.registry, libraries: [...this.state.registry.libraries, library] } });
      }
      await this.request({ op: "preferences", value: values }, id);
      this.preferenceCommits.set(id, (this.preferenceCommits.get(id) ?? 0) + 1);
      const registry = this.state.registry && { ...this.state.registry, libraries: this.state.registry.libraries.map(library => library.id === id ? { ...library, preferences: values } : library) };
      const error = this.state.libraryId === id && this.state.error === save.error ? null : this.state.error;
      if (save.version === version) this.preferenceSaves.delete(id);
      save.error = null;
      this.publish({ registry, error });
    } catch (error) {
      save.error = `保存素材库偏好失败：${message(error)}；下次调整时将重试未保存的偏好。`;
      if (this.state.libraryId === id) this.publish({ error: save.error });
      console.error("保存素材库偏好失败", error);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("luckyray:material-library-error", { detail: save.error }));
    } finally {
      save.inFlight = false;
      // Newer changes wait for this request; failures keep their full merged
      // snapshot until a new change retries it. Other libraries never wait here.
      if (this.preferenceSaves.get(id) === save && save.version !== version && save.timer === null) void this.savePreferences(id, save);
    }
  }
  private publish(update: Partial<MaterialLibrarySnapshot>) { this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(); }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
const catalogMutations = new Set(["importPaths", "importBytes", "importFolder", "update", "delete", "relocate", "renameFile", "createFolder", "renameFolder", "deleteFolder", "moveFolder", "move", "createTag", "updateTag", "deleteTag", "setTags", "favoriteAdd", "favoriteRemove", "favoriteNotes", "smartCreate", "smartUpdate", "smartDelete"]);
export const materialLibrarySession = new MaterialLibrarySession();
export function materialLibraryStorageKey(key: string, id = materialLibrarySession.getSnapshot().libraryId) {
  return id ? `${key}:${id}` : key;
}
export function readMaterialLibraryPreference(key: string, id = materialLibrarySession.getSnapshot().libraryId) {
  const stored = localStorage.getItem(materialLibraryStorageKey(key, id));
  return stored ?? (id === materialLibrarySession.getSnapshot().registry?.legacyId ? localStorage.getItem(key) : null);
}
export function writeMaterialLibraryPreference(key: string, value: string, id = materialLibrarySession.getSnapshot().libraryId) {
  materialLibrarySession.writePreference(key, value, id);
}
