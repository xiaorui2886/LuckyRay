/** Public LuckyRay SDK V1. Available in the isolated runtime; no imports needed. */
type LRJson = null | boolean | number | string | LRJson[] | { [key: string]: LRJson };
type LRModule = "materials" | "knowledge" | "canvas";
type LRPermission = "materials.read" | "materials.image" | "materials.tags" | "knowledge.read" | "knowledge.create" | "knowledge.insert" | "canvas.read" | "canvas.export";
interface LRContribution { id: string; label: string; kind: "command" | "menu" | "panel" | "settings" | "page"; }
interface LRPluginConfig { id: string; name: string; version: string; minHostVersion?: string; requiredModules?: LRModule[]; optionalModules?: LRModule[]; requiredPermissions?: LRPermission[]; optionalPermissions?: LRPermission[]; dataVersion?: number; contributions: LRContribution[]; }
type LREmptyParams = Record<string, never>;
interface LRMaterial { id: string; name: string; kind: string; mimeType: string; revision: string; storageMode: "managed" | "source" | "linked"; tagIds: string[]; }
interface LRNote { documentRef: { vaultId: string; relativePath: string }; title: string; content: string; revision: string; }
interface LRData { schemaVersion: number; revision: number; settings: LRJson; cache: LRJson; }
interface LRGraph { id: string; name: string; digest: string; revision: number; snapshot: "saved"; attachments: "excluded"; nodes: { id: string; type: string; title: string; x: number; y: number }[]; edges: { id: string; source: string; target: string }[]; }
interface LRLibraryMaterialResult { consumerVersion: 1; libraryId: string; requestId: string; asset: LRMaterial; }
interface LRApi {
 /** Additive explicit library consumer; requires a host-confirmed library/object scope. Legacy methods keep their legacy default scope. */
 "materials.library.list": { input: { libraryId: string; requestId: string }; output: { consumerVersion: 1; libraryId: string; requestId: string; items: LRMaterial[] } };
 "materials.library.read": { input: { libraryId: string; requestId: string; id: string }; output: LRLibraryMaterialResult };
 "materials.list": { input: LREmptyParams; output: LRMaterial[] };
 "materials.read": { input: { id: string }; output: LRMaterial };
 "materials.image.open": { input: { id: string; revision: string }; output: { handle: string; width: number; height: number; format: "rgba8" } };
 "materials.image.read": { input: { handle: string }; output: { width: number; height: number; rgba: number[] } };
 "materials.image.release": { input: { handle: string }; output: null };
 "materials.tags": { input: { id: string; revision: string; tags: string[] }; output: Omit<LRMaterial, "storageMode"> };
 "knowledge.read": { input: { path: string }; output: LRNote };
 "knowledge.selection": { input: LREmptyParams; output: { documentRef: LRNote["documentRef"]; revision: string; selection: string | null; cursorOffset: number | null } };
 "knowledge.create": { input: { title: string; content: string }; output: LRNote };
 "knowledge.insert": { input: { path: string; revision: string; offset: number; text: string }; output: { document: LRNote; indexWarning?: { code: string; message: string }; indexStale: boolean } };
 "canvas.read": { input: { id: string }; output: LRGraph };
 "canvas.export": { input: { id: string; digest: string }; output: { format: "svg"; bytes: number; nodes: number; edges: number } };
 "data.get": { input: LREmptyParams; output: LRData };
 "data.set": { input: LRData; output: LRData };
 "ui.theme": { input: LREmptyParams; output: Record<string, string> };
 "log": { input: { message: string }; output: null };
}
interface LREvent { input: { contribution: string; action: string; fields: Record<string, string> }; capabilities: string[]; objects: { materials: string[]; materialLibraryId?: string | null; knowledge: { vaultId: string; documents: string[] } | null; canvases: string[] }; theme: Record<string, string>; }
/** A `page` contribution opens as a real main-area page in the host shell (EXT-PAGE); the handler returns the same bounded UI schema on every visit and the host keeps the user's in-progress fields for the session. */
interface LRUi { title: string; text?: string; fields?: { id: string; label: string; value: string }[]; actions?: { id: string; label: string }[]; }
type LRNoParamsMethod = "materials.list" | "knowledge.selection" | "data.get" | "ui.theme";
type LRCallArgs<K extends keyof LRApi> = K extends LRNoParamsMethod ? [params?: LRApi[K]["input"]] : [params: LRApi[K]["input"]];
declare const LuckyRay: { readonly apiVersion: 1; register(handler: (event: LREvent) => LRUi | Promise<LRUi>): void; call<K extends keyof LRApi>(method: K, ...params: LRCallArgs<K>): Promise<LRApi[K]["output"]> };
