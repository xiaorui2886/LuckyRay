import type { BridgeCanvasFile, BridgeCanvasListEntry } from "../bridge/bridgeTypes";

/** Fixed, read-only endpoints on the authenticated canvas carrier. A detail
 * must be a server projection, never the older native-only canonical payload. */
export function createCanvasRemoteReadClient(fetcher: typeof fetch = fetch) {
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetcher(path, {
      method: "GET", mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`canvas-remote-http-${response.status}`);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") || "")) {
      throw new Error("canvas-remote-invalid-response");
    }
    const maxResponseBytes = 9 * 1024 * 1024;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) {
      await response.body?.cancel();
      throw new Error("canvas-remote-response-too-large");
    }
    // Check each streamed chunk before retaining it, not after response.text()
    // has already allocated an unbounded body.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("canvas-remote-invalid-response");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "", bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new Error("canvas-remote-response-too-large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    try { return JSON.parse(text); } catch { throw new Error("canvas-remote-invalid-response"); }
  }
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const validCanvasId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[^a-zA-Z0-9_-]/.test(value);
  const nonnegativeInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const safeCover = (value: unknown) => value === null || (typeof value === "string" && value.startsWith("/canvas/media/") && validCanvasId(value.slice("/canvas/media/".length)));
  return {
    async listCanvases(signal?: AbortSignal): Promise<BridgeCanvasListEntry[]> {
      const value = await get("/canvas/api/v1/canvases", signal);
      if (!record(value) || !Array.isArray(value.canvases)) throw new Error("canvas-remote-invalid-response");
      const ids = new Set<string>();
      return value.canvases.map((row: unknown) => {
        if (!record(row) || typeof row.id !== "string" || !validCanvasId(row.id) || ids.has(row.id) || typeof row.name !== "string" ||
            typeof row.createdAt !== "string" || typeof row.updatedAt !== "string" ||
            !nonnegativeInteger(row.nodeCount) || !nonnegativeInteger(row.edgeCount) ||
            !nonnegativeInteger(row.coverVersion) || !nonnegativeInteger(row.revision) || typeof row.contentDigest !== "string" ||
            !(row.coverKind === null || row.coverKind === "image" || row.coverKind === "video") ||
            !safeCover(row.coverUrl) || !safeCover(row.coverPoster)) throw new Error("canvas-remote-invalid-response");
        ids.add(row.id);
        return row as BridgeCanvasListEntry;
      });
    },
    async loadCanvas(canvasId: string, signal?: AbortSignal): Promise<BridgeCanvasFile> {
      if (!validCanvasId(canvasId)) throw new Error("canvas-remote-invalid-id");
      const value = await get(`/canvas/api/v1/canvases/${encodeURIComponent(canvasId)}`, signal);
      if (!record(value) || value.remoteProjectionVersion !== 1 || !nonnegativeInteger(value.remoteUnavailableMediaCount) || value.canvasId !== canvasId || typeof value.name !== "string" ||
          typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
          !nonnegativeInteger(value.schemaVersion) || value.schemaVersion === 0 || !nonnegativeInteger(value.revision) ||
          typeof value.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.contentDigest) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) ||
          !(value.generationHistory == null || Array.isArray(value.generationHistory)) ||
          !record(value.viewport) || ![value.viewport.x,value.viewport.y,value.viewport.zoom].every(x=>typeof x === "number" && Number.isFinite(x)) || (value.viewport.zoom as number) <= 0) {
        throw new Error("canvas-remote-invalid-response");
      }
      return { ...value, generationHistory: value.generationHistory ?? [] } as BridgeCanvasFile;
    },
  };
}
