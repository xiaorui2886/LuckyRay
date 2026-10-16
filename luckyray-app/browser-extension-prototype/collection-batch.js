(function (global) {
  "use strict";
  // Uses the established single-task importer and receipts. Persist each item
  // BEFORE dispatch; worker recovery observes that ID instead of replaying it.
  function create({ read, write, task, prepare, media = global.LuckyRayMediaImport, uuid = () => crypto.randomUUID(), delay = ms => new Promise(r => setTimeout(r, ms)) }) {
    let batch = null, loaded = false, loading = null, running = null, changing = false;
    let checking = null;
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const save = () => write(copy(batch));
    async function load() { if (!loaded) { loading ||= (async () => { batch = await read() || null; loaded = true; })(); await loading; } }
    const blocks = () => batch && !batch.acknowledged;
    async function observe(item) {
      for (let count = 0; count < 800; count++) {
        const result = await task.status(), value = result.task;
        if (!result.ok || value?.id !== item.requestId) { item.state = "unknown"; return; }
        if (value.stage === "completed") { item.state = value.disposition === "duplicate" ? "duplicate" : "saved"; item.asset = value.asset; return; }
        if (value.stage === "partial" && value.organizationPartial && value.asset) {
          const acknowledged = await task.acknowledge(value.id);
          if (!acknowledged.ok) { await delay(500); continue; }
          item.state = "saved-partial"; item.asset = value.asset; return;
        }
        if (value.stage === "failed") { item.state = "failed"; item.errorCode = value.errorCode; item.failure = value.importFailure; return; }
        if (!["starting", "transferring", "attaching", "checking"].includes(value.stage)) { item.state = "unknown"; return; }
        await delay(500);
      }
      item.state = "unknown";
    }
    async function process() {
      for (const item of batch.items) {
        if (item.state === "saving") { await observe(item); await save(); }
        if (item.state === "unknown") { batch.stage = "unknown"; await save(); return; }
        if (item.state !== "queued") continue;
        if (batch.stopRequested) { batch.stage = "paused"; await save(); return; }
        const prepared = await prepare(copy(item), copy(batch.target), copy(batch.source), copy(batch.connection));
        if (batch.stopRequested) { batch.stage = "paused"; await save(); return; }
        if (!prepared.ok) { item.state = "failed"; item.errorCode = prepared.code; await save(); continue; }
        item.state = "saving"; await save();
        const started = await task.start({ ...prepared.input, connection: copy(batch.connection) });
        if (!started.ok) {
          // The persisted item was NOT dispatched by this coordinator. Do not
          // steal another task or acknowledge its uncertain receipt.
          item.state = started.code === "capture-task-pending" ? "queued" : "failed";
          item.errorCode = started.code; batch.stage = "paused"; await save(); return;
        }
        await observe(item); await save();
        if (item.state === "unknown") { batch.stage = "unknown"; await save(); return; }
      }
      batch.stage = batch.items.some(item => ["failed", "saved-partial"].includes(item.state)) ? "partial" : "completed"; await save();
    }
    function run() {
      if (!running) running = Promise.resolve().then(process).catch(async () => {
        const pending = batch?.items.find(item => item.state === "saving");
        if (pending) pending.state = "unknown";
        if (batch) { batch.stage = pending ? "unknown" : "paused"; await save().catch(() => {}); }
      }).finally(() => { running = null; });
    }
    async function start(input) {
      input = copy(input);
      await load(); if (changing || running || blocks()) return { ok: false, code: "batch-pending", batch: copy(batch) };
      if (!input?.source?.session || !Number.isInteger(input.source.tabId) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100
        || new Set(input.items.map(item => item.id)).size !== input.items.length) return { ok: false, code: "batch-input-invalid" };
      changing = true;
      const previousBatch = batch;
      try {
        const previous = batch ? [...(batch.previous || []), { id: batch.id, source: copy(batch.source), target: copy(batch.target), items: copy(batch.items), stage: batch.stage }].slice(-4) : [];
        batch = { version: 1, id: uuid(), stage: "running", source: copy(input.source), target: copy(input.target),
          connection: copy(input.connection || null), createdAt: Date.now(), previous,
          items: input.items.map((item, index) => ({ id: String(item.id), url: String(item.url), name: String(item.name || "网页图片").slice(0, 140), index: index + 1, binding: copy(item.binding || null),
            requestId: `popup:batch:${uuid()}`, state: "queued" })) };
        await save(); run(); return { ok: true, batch: copy(batch) };
      } catch (error) { batch = previousBatch; throw error; }
      finally { changing = false; }
    }
    function matchesOriginal(value, expected) {
      return value?.id === expected.requestId && value.kind === expected.operation
        && value.mediaIdentity?.libraryId === expected.libraryId && value.mediaIdentity?.requestId === expected.requestId
        && value.mediaIdentity?.operation === expected.operation && !value.acknowledged;
    }
    async function reconcileUnknown() {
      const observed = batch, item = batch.items.find(item => item.state === "unknown");
      const libraryId = batch.target?.destination?.libraryId;
      if (!item || !libraryId || !media) return;
      const expected = { libraryId, requestId: item.requestId, operation: "image" };
      const result = await task.status(), value = result.task;
      if (batch !== observed || batch.acknowledged || batch.stage !== "unknown" || item.state !== "unknown"
        || item.requestId !== expected.requestId || batch.target?.destination?.libraryId !== expected.libraryId
        || !result.ok || !matchesOriginal(value, expected)) return;
      if (value.stage === "completed" || (value.stage === "partial" && value.organizationPartial && !value.noteRequest)) {
        const parsed = media.receipt({ ...value.receipt, asset: value.asset }, expected);
        if (!parsed.ok) return;
        if (value.stage === "partial" && !(await task.acknowledge(value.id)).ok) return;
        item.state = parsed.organizationPartial ? "saved-partial" : parsed.disposition === "duplicate" ? "duplicate" : "saved";
        item.asset = parsed.asset;
      } else if (value.stage === "failed") {
        item.state = "failed"; item.errorCode = value.errorCode; item.failure = value.importFailure;
      } else return;
      // A recovered receipt settles this item. The remaining queue requires a
      // separate user action; readback never resumes writes or creates IDs.
      batch.stage = batch.items.some(item => item.state === "unknown") ? "unknown"
        : batch.items.some(item => item.state === "queued") ? "paused"
        : batch.items.some(item => ["failed", "saved-partial"].includes(item.state)) ? "partial" : "completed";
      await save();
    }
    async function status() {
      await load();
      if (!running && batch?.stage === "running") run();
      if (!running && batch?.stage === "unknown" && !batch.acknowledged) {
        checking ||= reconcileUnknown().finally(() => { checking = null; });
        await checking;
      }
      return { ok: true, batch: copy(batch) };
    }
    async function stop(id) { await load(); if (batch?.id !== id) return { ok: false, code: "batch-changed" }; batch.stopRequested = true; await save(); return { ok: true, batch: copy(batch) }; }
    async function retry(id) {
      await load(); if (batch?.id !== id || changing || running || checking || !["partial", "completed"].includes(batch.stage)) return { ok: false, code: "batch-pending" };
      changing = true;
      try {
        for (const item of batch.items) if (item.state === "failed") { item.state = "queued"; item.requestId = `popup:batch:${uuid()}`; delete item.errorCode; delete item.failure; }
        batch.stage = "running"; batch.stopRequested = false; await save(); run(); return { ok: true, batch: copy(batch) };
      } finally { changing = false; }
    }
    async function resume(id) {
      await load(); if (batch?.id !== id || batch.acknowledged || changing || running || checking) return { ok: false, code: "batch-pending" };
      if (batch.stage === "unknown") {
        const item = batch.items.find(item => item.state === "unknown"), libraryId = batch.target?.destination?.libraryId;
        if (!item || !libraryId) return { ok: false, code: "batch-pending" };
        const result = await task.status();
        if (!result.ok || !matchesOriginal(result.task, { libraryId, requestId: item.requestId, operation: "image" })) return { ok: false, code: "batch-pending" };
        const checked = await task.resume(item.requestId);
        return { ...checked, batch: copy(batch) };
      }
      if (batch.stage !== "paused") return { ok: false, code: "batch-pending" };
      batch.stopRequested = false; batch.stage = "running"; await save(); run(); return { ok: true, batch: copy(batch) };
    }
    async function acknowledge(id, confirmed = false) {
      await load(); if (batch?.id !== id || running || checking || batch.stage === "running" || (batch.stage === "unknown" && !confirmed)) return { ok: false, code: "batch-pending" };
      if (batch.stage === "unknown") {
        const current = await task.status();
        if (batch.items.some(item => item.state === "unknown" && item.requestId === current.task?.id)) {
          const response = await task.acknowledge(current.task.id); if (!response.ok) return response;
        }
      }
      // This only releases NEW actions. Retain all unresolved IDs and never
      // change an unknown/queued item to failed or enqueue it for a replay.
      batch.acknowledged = true; await save(); return { ok: true, batch: copy(batch) };
    }
    return { start, status, stop, retry, resume, acknowledge, blocks: async () => { await load(); return Boolean(blocks()); } };
  }
  const api = { create }; global.LuckyRayCollectionBatch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
