/** Public LuckyRay SDK V1. Available in the isolated runtime; no imports needed. */
type LRJson = null | boolean | number | string | LRJson[] | { [key: string]: LRJson };
interface LRMaterial { id: string; name: string; kind: string; mimeType: string; revision: string; storageMode: "managed" | "source" | "linked"; tagIds: string[]; }
interface LRNote { documentRef: { vaultId: string; relativePath: string }; title: string; content: string; revision: string; }
interface LRData { schemaVersion: number; revision: number; settings: LRJson; cache: LRJson; }
interface LRGraph { id: string; name: string; digest: string; revision: number; snapshot: "saved"; attachments: "excluded"; nodes: { id: string; type: string; title: string; x: number; y: number }[]; edges: { id: string; source: string; target: string }[]; }
interface LRApi {
 "materials.list": { input: {}; output: LRMaterial[] };
 "materials.read": { input: { id: string }; output: LRMaterial };
 "materials.image.open": { input: { id: string; revision: string }; output: { handle: string; width: number; height: number; format: "rgba8" } };
 "materials.image.read": { input: { handle: string }; output: { width: number; height: number; rgba: number[] } };
 "materials.image.release": { input: { handle: string }; output: null };
 "materials.tags": { input: { id: string; revision: string; tags: string[] }; output: Omit<LRMaterial, "storageMode"> };
 "knowledge.read": { input: { path: string }; output: LRNote };
 "knowledge.selection": { input: {}; output: { documentRef: LRNote["documentRef"]; revision: string; selection: string | null; cursorOffset: number | null } };
 "knowledge.create": { input: { title: string; content: string }; output: LRNote };
 "knowledge.insert": { input: { path: string; revision: string; offset: number; text: string }; output: { document: LRNote; indexWarning?: { code: string; message: string }; indexStale: boolean } };
 "canvas.read": { input: { id: string }; output: LRGraph };
 "canvas.export": { input: { id: string; digest: string }; output: { format: "svg"; bytes: number; nodes: number; edges: number } };
 "data.get": { input: {}; output: LRData };
 "data.set": { input: LRData; output: LRData };
 "ui.theme": { input: {}; output: Record<string, string> };
 "log": { input: { message: string }; output: null };
}
interface LREvent { input: { contribution: string; action: string; fields: Record<string, string> }; capabilities: string[]; objects: { materials: string[]; knowledge: { vaultId: string; documents: string[] } | null; canvases: string[] }; theme: Record<string, string>; }
/** A `page` contribution opens as a real main-area page in the host shell (EXT-PAGE); the handler returns the same bounded UI schema on every visit and the host keeps the user's in-progress fields for the session. */
interface LRUi { title: string; text?: string; fields?: { id: string; label: string; value: string }[]; actions?: { id: string; label: string }[]; }
declare const LuckyRay: { readonly apiVersion: 1; register(handler: (event: LREvent) => LRUi | Promise<LRUi>): void; call<K extends keyof LRApi>(method: K, params?: LRApi[K]["input"]): Promise<LRApi[K]["output"]> };
