import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const RESOURCE_PROTOCOL = 1;
const MAX_RESOURCE_FRAME_BYTES = 256 * 1024;
const MAX_RESOURCE_RESULT_BYTES = 8 * 1024 * 1024;
const RESOURCE_RESULT_CHUNK_BYTES = 128 * 1024;
const MAX_RESOURCE_ARGS_BYTES = 128 * 1024;
const MAX_SESSION_ID_BYTES = 128;
const MAX_CALL_ID_BYTES = 192;

const READ = "read";
const WRITE = "write";
const DESTRUCTIVE = "destructive";
const FULL = "full";
const AUTHORITY_EVENT_TYPES = new Set([
  "permission/preset", "sandbox/mode", "approval/policy", "turn/end",
]);

function loadResourceOperations() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(
      new URL("./luckyray-dsh-resource-tools.json", import.meta.url),
      "utf8",
    ));
  } catch {
    throw new Error("dsh-resource-manifest-invalid");
  }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.operations)
    || Object.keys(manifest).sort().join(",") !== "operations,version"
    || manifest.operations.length === 0 || manifest.operations.length > 128) {
    throw new Error("dsh-resource-manifest-invalid");
  }
  const seen = new Set();
  const operations = manifest.operations.map((operation) => {
    if (!operation || Object.keys(operation).sort().join(",") !== "access,id"
      || typeof operation.id !== "string"
      || !/^luckyray_(browser|knowledge|materials|web)_[a-z0-9_]+$/u.test(operation.id)
      || ![READ, WRITE, DESTRUCTIVE, FULL].includes(operation.access)
      || seen.has(operation.id)) {
      throw new Error("dsh-resource-manifest-invalid");
    }
    seen.add(operation.id);
    return Object.freeze([operation.id, operation.access]);
  });
  return Object.freeze(operations);
}

export const RESOURCE_OPERATIONS = loadResourceOperations();

const OPERATION_ACCESS = new Map(RESOURCE_OPERATIONS);
const PATH_ARGUMENTS = new Map([
  ["luckyray_knowledge_source_register", [["path", "authorizedPath"]]],
  ["luckyray_materials_import_path", [["path", "authorizedPath"]]],
  ["luckyray_materials_import_folder", [["path", "authorizedPath"]]],
  ["luckyray_materials_relocate", [["path", "authorizedPath"]]],
  ["luckyray_materials_wide_import", [["path", "authorizedPath"]]],
  ["luckyray_materials_wide_relocate", [["path", "authorizedPath"]]],
  ["luckyray_materials_migrate_library", [
    ["sourcePath", "authorizedSourcePath"],
    ["targetPath", "authorizedTargetPath"],
  ]],
]);

function resourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactString(value, maximum, code) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw resourceError(code);
  }
  return value;
}

function jsonBytes(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw resourceError("dsh-resource-invalid-payload");
  return Buffer.byteLength(encoded, "utf8");
}

function lastPolicySeq(session) {
  let revision = -1;
  for (const event of session.events ?? []) {
    if (AUTHORITY_EVENT_TYPES.has(event?.type)
      && Number.isSafeInteger(event.seq) && event.seq >= 0) {
      revision = Math.max(revision, event.seq);
    }
  }
  return revision;
}

function resourcePolicy(ctx, session) {
  const policy = ctx.sandboxPolicy.resolve({ session });
  if (!policy || !["read-only", "workspace-write", "danger-full-access"].includes(policy.mode)) {
    throw resourceError("dsh-resource-policy-unavailable");
  }
  return {
    policy,
    context: {
      sessionId: session.id,
      policySeq: lastPolicySeq(session),
      mode: policy.mode,
      approvalPolicy: effectiveApprovalPolicy(ctx, session),
      workspaceRoot: typeof policy.workspaceRoot === "string" ? policy.workspaceRoot : "",
    },
  };
}

function samePolicy(left, right) {
  return left.sessionId === right.sessionId
    && left.policySeq === right.policySeq
    && left.mode === right.mode
    && left.approvalPolicy === right.approvalPolicy
    && left.workspaceRoot === right.workspaceRoot;
}

function createAdmissionCoordinator(ctx, bridge) {
  const tails = new WeakMap();
  const enqueue = (session, task) => {
    const prior = tails.get(session) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(task);
    tails.set(session, current);
    void current.then(
      () => { if (tails.get(session) === current) tails.delete(session); },
      () => { if (tails.get(session) === current) tails.delete(session); },
    );
    return current;
  };
  const observe = (session, event) => {
    if (!session || !AUTHORITY_EVENT_TYPES.has(event?.type)) return;
    void enqueue(session, async () => {
      const latest = resourcePolicy(ctx, session);
      await bridge.syncPolicy(latest.context);
    }).catch(() => {});
  };
  return Object.freeze({ enqueue, observe });
}

function completedEffectSettlementContext(operation, value) {
  const settlement = JSON.stringify({ operation, result: value });
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([Object.freeze({
      type: "text",
      text: `<luckyray_resource_settlement>\nBackend completed this resource operation before cancellation was observed. Do not retry it automatically.\n${settlement}\n</luckyray_resource_settlement>`,
    })]),
    source: Object.freeze({
      kind: "plugin",
      plugin: "luckyray-resource-tools",
      form: "notice",
      summary: `Completed resource operation: ${operation}`.slice(0, 120),
    }),
  });
}

function effectiveApprovalPolicy(ctx, session) {
  const override = ctx.approval?.overrideOf?.(session);
  const fallback = ctx.approval?.config?.policy;
  return override === "never" || override === "ask"
    ? override
    : fallback === "never" ? "never" : "ask";
}

function accessAllowed(mode, access) {
  if (access === READ) return true;
  if (access === FULL) return mode === "danger-full-access";
  return mode === "workspace-write" || mode === "danger-full-access";
}

function objectSchema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const STRING = Object.freeze({ type: "string", minLength: 1 });
const RESOURCE_REF = Object.freeze({ type: "string", pattern: "^rr-[0-9a-f]{36}$" });
const WEB_FETCH_REF = Object.freeze({ type: "string", pattern: "^wref-[0-9a-f]{64}$" });
const BROWSER_NAVIGATION_REF = Object.freeze({ type: "string", pattern: "^nav-[A-Za-z0-9]{48}$" });
const BROWSER_REF = Object.freeze({ type: "string", pattern: "^browser-[A-Za-z0-9]{48}$" });
const STRING_ARRAY = Object.freeze({ type: "array", items: STRING, maxItems: 64 });

function toolParameters(name) {
  if (name === "luckyray_web_search") {
    return objectSchema({
      query: { type: "string", minLength: 1, maxLength: 1024 },
      limit: { type: "integer", minimum: 5, maximum: 8 },
    }, ["query"]);
  }
  if (name === "luckyray_web_fetch") {
    return objectSchema({ fetchRef: WEB_FETCH_REF }, ["fetchRef"]);
  }
  if (name === "luckyray_browser_open") {
    return objectSchema({ navigationRef: BROWSER_NAVIGATION_REF }, ["navigationRef"]);
  }
  if (name === "luckyray_browser_read") {
    return objectSchema({ browserRef: BROWSER_REF }, ["browserRef"]);
  }
  if (name === "luckyray_browser_extract") {
    return objectSchema({
      browserRef: BROWSER_REF,
      kind: { type: "string", enum: ["main", "article", "headings", "links", "table"] },
      index: { type: "integer", minimum: 0, maximum: 15 },
    }, ["browserRef", "kind"]);
  }
  if ([
    "luckyray_knowledge_list", "luckyray_knowledge_recent", "luckyray_knowledge_index_snapshot",
    "luckyray_knowledge_index_refresh", "luckyray_knowledge_source_activate",
    "luckyray_knowledge_source_deactivate", "luckyray_knowledge_tags", "luckyray_materials_taxonomy",
    "luckyray_materials_folders", "luckyray_materials_tags", "luckyray_materials_change",
    "luckyray_materials_scan_missing", "luckyray_materials_retry_pending",
    "luckyray_materials_thumbnail_cleanup",
  ].includes(name)) return objectSchema();
  if (["luckyray_knowledge_search", "luckyray_materials_search"].includes(name)) {
    return objectSchema({ query: STRING, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["query"]);
  }
  if ([
    "luckyray_knowledge_read", "luckyray_knowledge_relations", "luckyray_knowledge_backlinks",
    "luckyray_materials_get",
    "luckyray_materials_inspect", "luckyray_materials_preview", "luckyray_materials_references",
  ].includes(name)) return objectSchema({ resourceRef: RESOURCE_REF }, ["resourceRef"]);
  if (["luckyray_knowledge_tag_documents", "luckyray_knowledge_embed_documents"].includes(name)) {
    return objectSchema({ query: STRING }, ["query"]);
  }
  if (name === "luckyray_knowledge_create") {
    return objectSchema({ title: STRING, content: { type: "string" }, parentRelativePath: { type: "string" } }, ["title", "content"]);
  }
  if (["luckyray_knowledge_append", "luckyray_knowledge_replace"].includes(name)) {
    return objectSchema({ resourceRef: RESOURCE_REF, content: { type: "string" } }, ["resourceRef", "content"]);
  }
  if (name === "luckyray_knowledge_insert") {
    return objectSchema({ resourceRef: RESOURCE_REF, offset: { type: "integer", minimum: 0 }, text: { type: "string" } }, ["resourceRef", "offset", "text"]);
  }
  if (name === "luckyray_knowledge_move") {
    return objectSchema({ resourceRef: RESOURCE_REF, title: STRING, parentRelativePath: { type: "string" } }, ["resourceRef", "title"]);
  }
  if (name === "luckyray_knowledge_set_tags") {
    return objectSchema({ resourceRef: RESOURCE_REF, tags: STRING_ARRAY }, ["resourceRef", "tags"]);
  }
  if (name === "luckyray_knowledge_delete") return objectSchema({ resourceRef: RESOURCE_REF }, ["resourceRef"]);
  if (name === "luckyray_knowledge_source_register") return objectSchema({ path: STRING }, ["path"]);
  if (name === "luckyray_materials_list") return objectSchema({ filter: { type: "object" } });
  if (name === "luckyray_materials_tag_map") {
    return objectSchema({ resourceRefs: { type: "array", items: RESOURCE_REF, maxItems: 64 } }, ["resourceRefs"]);
  }
  if (name === "luckyray_materials_update") {
    return objectSchema({ resourceRef: RESOURCE_REF, patch: { type: "object" } }, ["resourceRef", "patch"]);
  }
  if (name === "luckyray_materials_set_tags") {
    return objectSchema({ resourceRef: RESOURCE_REF, tagRefs: { type: "array", items: RESOURCE_REF, maxItems: 64 } }, ["resourceRef", "tagRefs"]);
  }
  if (name === "luckyray_materials_add_tags") {
    return objectSchema({ resourceRef: RESOURCE_REF, names: STRING_ARRAY }, ["resourceRef", "names"]);
  }
  if (["luckyray_materials_categorize", "luckyray_materials_move"].includes(name)) {
    return objectSchema({ resourceRef: RESOURCE_REF, folderRef: RESOURCE_REF }, ["resourceRef"]);
  }
  if (["luckyray_materials_relocate", "luckyray_materials_wide_relocate"].includes(name)) {
    return objectSchema({ resourceRef: RESOURCE_REF, path: STRING, options: { type: "object" } }, ["resourceRef", "path"]);
  }
  if (name === "luckyray_materials_rename") {
    return objectSchema({ resourceRef: RESOURCE_REF, fileName: STRING }, ["resourceRef", "fileName"]);
  }
  if (["luckyray_materials_asset_delete", "luckyray_materials_record_delete"].includes(name)) {
    return objectSchema({ resourceRef: RESOURCE_REF, deleteFile: { type: "boolean" } }, ["resourceRef"]);
  }
  if (name === "luckyray_materials_folder_create") {
    return objectSchema({ name: STRING, parentRef: RESOURCE_REF }, ["name"]);
  }
  if (name === "luckyray_materials_folder_rename") {
    return objectSchema({ folderRef: RESOURCE_REF, name: STRING }, ["folderRef", "name"]);
  }
  if (name === "luckyray_materials_folder_move") {
    return objectSchema({ folderRef: RESOURCE_REF, targetRef: RESOURCE_REF, position: { type: "string", enum: ["before", "after", "inside"] } }, ["folderRef", "position"]);
  }
  if (name === "luckyray_materials_folder_delete") return objectSchema({ folderRef: RESOURCE_REF }, ["folderRef"]);
  if (name === "luckyray_materials_tag_create") return objectSchema({ name: STRING, color: { type: "string" } }, ["name"]);
  if (name === "luckyray_materials_tag_update") return objectSchema({ tagRef: RESOURCE_REF, patch: { type: "object" } }, ["tagRef", "patch"]);
  if (name === "luckyray_materials_tag_merge") {
    return objectSchema({ targetRef: RESOURCE_REF, sourceRefs: { type: "array", items: RESOURCE_REF, minItems: 1, maxItems: 64 } }, ["targetRef", "sourceRefs"]);
  }
  if (name === "luckyray_materials_tag_delete") return objectSchema({ tagRef: RESOURCE_REF }, ["tagRef"]);
  if (["luckyray_materials_import_path", "luckyray_materials_import_folder", "luckyray_materials_wide_import"].includes(name)) {
    return objectSchema({ path: STRING, options: { type: "object" } }, ["path"]);
  }
  if (name === "luckyray_materials_migrate_library") {
    return objectSchema({ sourcePath: STRING, targetPath: STRING }, ["sourcePath", "targetPath"]);
  }
  throw resourceError("dsh-resource-operation-schema-missing");
}

async function authorizePaths(ctx, policy, operation, args, signal) {
  const mappings = PATH_ARGUMENTS.get(operation);
  if (!mappings) return args;
  const next = { ...(args ?? {}) };
  for (const [inputKey, outputKey] of mappings) {
    const path = exactString(args?.[inputKey], 32 * 1024, "dsh-resource-path-required");
    const target = await ctx.fs.resolve(path, { cwd: policy.workspaceRoot, signal });
    const info = await ctx.fs.stat(target, signal);
    if (!info || !["file", "directory"].includes(info.type)) {
      throw resourceError("dsh-resource-path-unavailable");
    }
    if (policy.mode === "workspace-write") {
      exactString(policy.workspaceRoot, 32 * 1024, "dsh-resource-workspace-required");
      const workspace = await ctx.fs.resolve(policy.workspaceRoot, { signal });
      if (!ctx.fs.contains(workspace, target)) throw resourceError("dsh-resource-path-out-of-scope");
    }
    const processPath = exactString(
      ctx.fs.processPath(target),
      32 * 1024,
      "dsh-resource-path-unavailable",
    );
    delete next[inputKey];
    next[outputKey] = processPath;
  }
  if (next.options && typeof next.options === "object" && !Array.isArray(next.options)) {
    next.options = { ...next.options };
    delete next.options.managedLibraryDir;
  }
  return next;
}

function assertLiveExecution(exec) {
  const agent = exec?.agent;
  const session = agent?.session;
  if (!agent || !session || agent.id !== session.id) {
    throw resourceError("dsh-resource-agent-required");
  }
  exactString(session.id, MAX_SESSION_ID_BYTES, "dsh-resource-session-invalid");
  exactString(exec.callId, MAX_CALL_ID_BYTES, "dsh-resource-call-invalid");
  return { agent, session };
}

export function createResourceToolDefinitions(ctx, bridge) {
  if (!ctx?.sandboxPolicy || !ctx?.approval || !ctx?.fs || !bridge?.syncPolicy || !bridge?.call) {
    throw resourceError("dsh-resource-composition-unavailable");
  }
  const coordinator = createAdmissionCoordinator(ctx, bridge);
  if (typeof ctx.on === "function") {
    ctx.on("session/event", (session, event) => coordinator.observe(session, event));
  }
  return RESOURCE_OPERATIONS.map(([name, access]) => Object.freeze({
    name,
    description: `LuckyRay ${name.replaceAll("_", " ")} (${access}).`,
    parameters: toolParameters(name),
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    isConcurrencySafe: () => access === READ,
    async execute(rawArgs, exec) {
      const { agent, session } = assertLiveExecution(exec);
      if (exec.signal?.aborted) throw resourceError("dsh-resource-cancelled");
      if (jsonBytes(rawArgs ?? {}) > MAX_RESOURCE_ARGS_BYTES) {
        throw resourceError("dsh-resource-arguments-too-large");
      }
      const prepared = resourcePolicy(ctx, session);
      const { policy } = prepared;
      if (!accessAllowed(policy.mode, access)) throw resourceError("dsh-resource-policy-denied");
      const approvalPolicy = prepared.context.approvalPolicy;
      let approval = "not-required";
      if ((access === DESTRUCTIVE || access === FULL) && approvalPolicy === "ask") {
        const outcome = await ctx.approval.request({
          agent,
          callId: exec.callId,
          toolName: name,
          reason: "LuckyRay resource operation",
          signal: exec.signal,
        });
        if (outcome !== "allowed-once") throw resourceError("dsh-resource-approval-denied");
        approval = "allowed-once";
      } else if (access === DESTRUCTIVE && policy.mode === "workspace-write") {
        throw resourceError("dsh-resource-approval-denied");
      }
      const args = await authorizePaths(ctx, policy, name, rawArgs ?? {}, exec.signal);
      return coordinator.enqueue(session, async () => {
        if (exec.signal?.aborted) throw resourceError("dsh-resource-cancelled");
        const admitted = resourcePolicy(ctx, session);
        if (!samePolicy(prepared.context, admitted.context)) {
          await bridge.syncPolicy(admitted.context, exec.signal);
          throw resourceError(accessAllowed(admitted.policy.mode, access)
            ? "dsh-resource-policy-changed" : "dsh-resource-policy-denied");
        }
        if (!accessAllowed(admitted.policy.mode, access)) throw resourceError("dsh-resource-policy-denied");
        if (access === DESTRUCTIVE && admitted.policy.mode === "workspace-write"
          && admitted.context.approvalPolicy !== "ask") {
          throw resourceError("dsh-resource-approval-denied");
        }
        await bridge.syncPolicy(admitted.context, exec.signal);
        if (exec.signal?.aborted) throw resourceError("dsh-resource-cancelled");
        const value = await bridge.call({
          ...admitted.context,
          callId: exec.callId,
          rootCallId: exec.rootCallId ?? exec.callId,
          operation: name,
          approval,
          args,
        }, access === READ ? exec.signal : undefined);
        if (access === READ && exec.signal?.aborted) {
          throw resourceError("dsh-resource-cancelled");
        }
        if (access !== READ && typeof exec.deferContext === "function") {
          exec.deferContext(completedEffectSettlementContext(name, value));
        }
        const latest = resourcePolicy(ctx, session);
        if (!samePolicy(admitted.context, latest.context)) {
          await bridge.syncPolicy(latest.context);
          if (access === READ) throw resourceError("dsh-resource-policy-changed");
        }
        return value;
      });
    },
  }));
}

function decodeMac(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return null;
  const bytes = Buffer.from(value, "hex");
  return bytes.length === 32 && bytes.toString("hex") === value ? bytes : null;
}

function signFrame(secret, direction, frame) {
  const fields = [
    String(frame.protocol), String(frame.generation), direction, String(frame.seq), frame.type,
    frame.requestId ?? "", frame.payload ?? "",
  ];
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(fields.join("\0"), "utf8").digest("hex");
}

export function signResourceFrame(secret, direction, frame) {
  return signFrame(secret, direction, frame);
}

function verifyFrame(secret, direction, frame) {
  const received = decodeMac(frame.mac);
  const expected = decodeMac(signFrame(secret, direction, frame));
  return received !== null && expected !== null && timingSafeEqual(received, expected);
}

export function createFdResourceBridge({ authority, request, response }) {
  if (!authority || !request || !response) throw resourceError("dsh-resource-channel-unavailable");
  const secret = exactString(authority.secret, 64, "dsh-resource-authority-invalid");
  if (!/^[0-9a-f]{64}$/u.test(secret) || authority.protocol !== RESOURCE_PROTOCOL
    || !Number.isSafeInteger(authority.generation) || authority.generation <= 0) {
    throw resourceError("dsh-resource-authority-invalid");
  }
  let outboundSeq = 0;
  let inboundSeq = 0;
  let requestIndex = 0;
  let closed = false;
  const pending = new Map();
  const lines = createInterface({ input: response, crlfDelay: Infinity, terminal: false });
  const failAll = (code = "dsh-resource-channel-closed") => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      item.cleanup();
      if (!item.aborted) item.reject(resourceError(code));
    }
    pending.clear();
    lines.close();
  };
  lines.on("line", (line) => {
    if (closed) return;
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_RESOURCE_FRAME_BYTES) throw resourceError("dsh-resource-frame-invalid");
      const frame = JSON.parse(line);
      if (Object.keys(frame).sort().join(",") !== "generation,mac,payload,protocol,requestId,seq,type"
        || !["result", "result-chunk"].includes(frame.type) || frame.protocol !== RESOURCE_PROTOCOL
        || frame.generation !== authority.generation || frame.seq !== inboundSeq + 1
        || !verifyFrame(secret, "host", frame)) throw resourceError("dsh-resource-frame-invalid");
      inboundSeq = frame.seq;
      const item = pending.get(frame.requestId);
      if (!item) throw resourceError("dsh-resource-frame-invalid");
      const chunk = Buffer.from(frame.payload, "base64url");
      item.size += chunk.length;
      if (item.size > MAX_RESOURCE_RESULT_BYTES) throw resourceError("dsh-resource-result-too-large");
      item.chunks.push(chunk);
      if (frame.type === "result-chunk") return;
      // Keep the request registered until decoding completes. Otherwise a
      // malformed authenticated result removes the only promise failAll can
      // reject, permanently blocking this session's admission queue.
      const payload = item.aborted ? null : JSON.parse(Buffer.concat(item.chunks, item.size).toString("utf8"));
      pending.delete(frame.requestId);
      item.cleanup();
      if (item.aborted) return;
      if (payload?.ok === true) item.resolve(payload.value);
      else item.reject(resourceError(typeof payload?.code === "string" ? payload.code : "dsh-resource-call-failed"));
    } catch (error) {
      failAll(error?.code === "dsh-resource-result-too-large"
        ? error.code : "dsh-resource-frame-invalid");
    }
  });
  const channelClosed = () => failAll();
  lines.once("close", channelClosed);
  lines.once("error", channelClosed);
  request.once("error", channelClosed);
  request.once("close", channelClosed);
  response.once("error", channelClosed);
  response.once("close", channelClosed);

  const send = (type, payload, signal) => {
    if (signal?.aborted) return Promise.reject(resourceError("dsh-resource-cancelled"));
    if (closed || request.destroyed || request.writableEnded || response.destroyed || response.readableEnded) {
      failAll();
      return Promise.reject(resourceError("dsh-resource-channel-closed"));
    }
    const nextSeq = outboundSeq + 1;
    const nextRequestIndex = requestIndex + 1;
    const requestId = `resource-${authority.generation}-${nextRequestIndex}`;
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const unsigned = {
      type, protocol: RESOURCE_PROTOCOL, generation: authority.generation,
      seq: nextSeq, requestId, payload: encodedPayload,
    };
    const frame = { ...unsigned, mac: signFrame(secret, "plugin", unsigned) };
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RESOURCE_FRAME_BYTES) {
      return Promise.reject(resourceError("dsh-resource-frame-too-large"));
    }
    // Only frames admitted for writing advance the authenticated sequence.
    outboundSeq = nextSeq;
    requestIndex = nextRequestIndex;
    return new Promise((resolveValue, rejectValue) => {
      const item = {
        resolve: resolveValue,
        reject: rejectValue,
        chunks: [],
        size: 0,
        aborted: false,
        cleanup: () => {},
      };
      const onAbort = () => {
        if (item.aborted) return;
        item.aborted = true;
        item.cleanup();
        rejectValue(resourceError("dsh-resource-cancelled"));
      };
      item.cleanup = () => signal?.removeEventListener?.("abort", onAbort);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      pending.set(requestId, item);
      try {
        request.write(line, (error) => { if (error) failAll(); });
      } catch {
        failAll();
      }
      if (signal?.aborted) onAbort();
    });
  };
  return Object.freeze({
    syncPolicy: (payload, signal) => send("policy", payload, signal),
    call: (payload, signal) => send("call", payload, signal),
  });
}

export function createChildResourceRouter({ authority, request, response, forward, onInvalid }) {
  if (!authority || !request || !response || typeof forward !== "function") {
    throw resourceError("dsh-resource-channel-unavailable");
  }
  const secret = exactString(authority.secret, 64, "dsh-resource-authority-invalid");
  if (!/^[0-9a-f]{64}$/u.test(secret) || authority.protocol !== RESOURCE_PROTOCOL
    || !Number.isSafeInteger(authority.generation) || authority.generation <= 0) {
    throw resourceError("dsh-resource-authority-invalid");
  }
  let inboundSeq = 0;
  let outboundSeq = 0;
  let closed = false;
  let queue = Promise.resolve();
  const lines = createInterface({ input: request, crlfDelay: Infinity, terminal: false });
  const invalidate = () => {
    if (closed) return;
    closed = true;
    lines.close();
    if (typeof onInvalid === "function") onInvalid();
  };
  const sendFrame = (requestId, type, bytes) => {
    outboundSeq += 1;
    const payload = bytes.toString("base64url");
    const unsigned = {
      type, protocol: RESOURCE_PROTOCOL, generation: authority.generation,
      seq: outboundSeq, requestId, payload,
    };
    const frame = { ...unsigned, mac: signFrame(secret, "host", unsigned) };
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RESOURCE_FRAME_BYTES) throw resourceError("dsh-resource-frame-too-large");
    response.write(line);
  };
  const send = (requestId, result) => {
    let bytes = Buffer.from(JSON.stringify(result), "utf8");
    if (bytes.length > MAX_RESOURCE_RESULT_BYTES) {
      bytes = Buffer.from(JSON.stringify({ ok: false, code: "dsh-resource-result-too-large" }), "utf8");
    }
    for (let offset = 0; offset < bytes.length; offset += RESOURCE_RESULT_CHUNK_BYTES) {
      const end = Math.min(offset + RESOURCE_RESULT_CHUNK_BYTES, bytes.length);
      sendFrame(requestId, end === bytes.length ? "result" : "result-chunk", bytes.subarray(offset, end));
    }
  };
  lines.on("line", (line) => {
    queue = queue.then(async () => {
      if (closed || Buffer.byteLength(line, "utf8") > MAX_RESOURCE_FRAME_BYTES) throw resourceError("dsh-resource-frame-invalid");
      const frame = JSON.parse(line);
      if (Object.keys(frame).sort().join(",") !== "generation,mac,payload,protocol,requestId,seq,type"
        || !["policy", "call"].includes(frame.type) || frame.protocol !== RESOURCE_PROTOCOL
        || frame.generation !== authority.generation || frame.seq !== inboundSeq + 1
        || !verifyFrame(secret, "plugin", frame)) throw resourceError("dsh-resource-frame-invalid");
      inboundSeq = frame.seq;
      const payload = JSON.parse(Buffer.from(frame.payload, "base64url").toString("utf8"));
      try {
        send(frame.requestId, { ok: true, value: await forward(frame.type, payload) });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "dsh-resource-call-failed";
        send(frame.requestId, { ok: false, code });
      }
    }).catch(invalidate);
  });
  lines.once("close", () => { closed = true; });
  lines.once("error", invalidate);
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      lines.close();
      request.destroy();
      response.end();
    },
  });
}

export async function apply(ctx, config = {}) {
  const authorityFd = Number(config.authorityFd ?? 7);
  const requestFd = Number(config.requestFd ?? 8);
  const responseFd = Number(config.responseFd ?? 9);
  const authorityText = await new Promise((resolveAuthority, rejectAuthority) => {
    let value = "";
    const stream = createReadStream(null, { fd: authorityFd, autoClose: false });
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { value += chunk; });
    stream.once("end", () => resolveAuthority(value));
    stream.once("error", rejectAuthority);
  });
  const authority = JSON.parse(authorityText);
  const bridge = createFdResourceBridge({
    authority,
    request: createWriteStream(null, { fd: requestFd, autoClose: false }),
    response: createReadStream(null, { fd: responseFd, autoClose: false }),
  });
  for (const definition of createResourceToolDefinitions(ctx, bridge)) {
    ctx.effect(() => ctx.tools.register(definition));
  }
}

export default { apply };
