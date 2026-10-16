import { MaterialError } from "../../materials-mcp/src/transport.mjs";
const protocols = ["2025-11-25", "2025-06-18"];
const modernProtocol = "2026-07-28";
const supported = [modernProtocol, ...protocols];
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export async function serve(materials, input = process.stdin, output = process.stdout, options = {}) {
  let pending = Buffer.alloc(0), initialized = false, negotiated = false,
    queue = [], working = false, closed = false;
  // The official tunnel multiplexes logical clients through one stdio child.
  // IDs belong to outstanding requests, not the lifetime of that child.
  const inFlight = new Set();
  const info = options.serverInfo ?? { name: "luckyray-library-web-mcp", version: "0.1.0-candidate.2" };
  const send = (value) => output.write(JSON.stringify(value) + "\n");
  const error = (id, code, message, data) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  const drain = async () => {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const { request: r, key, duplicate } = queue.shift();
        try {
          if (duplicate) { error(r.id, -32600, "Duplicate outstanding request id"); continue; }
          if (r.id === undefined) {
            if (r.method === "notifications/initialized" && negotiated) initialized = true;
            continue;
          }
          const meta = r.params?._meta;
          const version = meta?.["io.modelcontextprotocol/protocolVersion"];
          const modern = typeof version === "string" && version >= modernProtocol;
          if (modern || r.method === "server/discover") {
            if (version !== modernProtocol) {
              error(r.id, -32022, "Unsupported protocol version", { supported, ...(typeof version === "string" && version.length <= 32 ? { requested: version } : {}) });
              continue;
            }
            if (!object(meta["io.modelcontextprotocol/clientCapabilities"])) {
              error(r.id, -32602, "Client capabilities required"); continue;
            }
          }
          let result;
          if (r.method === "server/discover") {
            result = { supportedVersions: supported, capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": info } };
          } else if (r.method === "initialize") {
            // initialize negotiates a legacy session. Modern calls are stateless.
            negotiated = true; initialized = false;
            result = { protocolVersion: protocols.includes(r.params?.protocolVersion) ? r.params.protocolVersion : protocols[0], capabilities: { tools: {} }, serverInfo: info };
          } else if (r.method === "ping") result = {};
          else if (!["tools/list", "tools/call"].includes(r.method)) {
            error(r.id, -32601, "Method not found"); continue;
          } else if (!modern && !initialized) {
            error(r.id, -32000, "Initialize first"); continue;
          } else if (r.method === "tools/list") result = { tools: options.tools ?? [] };
          else {
            const value = await materials.run(r.params?.name, r.params?.arguments ?? {});
            result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
          }
          send({ jsonrpc: "2.0", id: r.id, result: { ...(modern ? { resultType: "complete" } : {}), ...result } });
        } catch (e) {
          const code = e instanceof MaterialError ? e.code : "operation-failed";
          const modern = r.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === modernProtocol;
          send({ jsonrpc: "2.0", id: r.id, result: { ...(modern ? { resultType: "complete" } : {}), isError: true, content: [{ type: "text", text: code }] } });
        } finally {
          if (key) inFlight.delete(key);
        }
      }
    } finally {
      working = false;
      if (closed && queue.length === 0) output.end?.();
    }
  };
  input.on("data", (chunk) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > 1048576) { input.destroy(); closed = true; return; }
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      if (!line.trim()) continue;
      if (queue.length >= 16) { input.destroy(); closed = true; return; }
      let r;
      try { r = JSON.parse(line); } catch { error(null, -32700, "Parse error"); continue; }
      if (!object(r) || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
        error(null, -32600, "Invalid request"); continue;
      }
      if (r.id !== undefined && !((typeof r.id === "string" && r.id.length <= 128) || Number.isSafeInteger(r.id))) {
        error(null, -32600, "Invalid id"); continue;
      }
      const key = r.id === undefined ? null : typeof r.id + ":" + r.id;
      const duplicate = key !== null && inFlight.has(key);
      if (key && !duplicate) inFlight.add(key);
      queue.push({ request: r, key: duplicate ? null : key, duplicate });
      void drain();
    }
  });
  input.on("end", () => { closed = true; if (!working && queue.length === 0) output.end?.(); });
}
