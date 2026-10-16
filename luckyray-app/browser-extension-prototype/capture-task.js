(function (global) {
  "use strict";

  // One coordinator owns the existing desktop import/transfer and note receipt.
  // The popup only observes it. No source credentials are written to storage.
  function create({ read, write, request, protocol, media = global.LuckyRayMediaImport, now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), connection: connectionProvider = null, confirm = null }) {
    let current = null;
    let loaded = false;
    let loading = null;
    let running = null;
    let starting = false;
    let recoveryChecked = false;
    let receiptRetryAt = 0;
    let transferRevision = 0;
    // Tasks created in this session without a binding (legacy test injection
    // only) may dispatch; a persisted task without a binding never can.
    const unboundSessionTasks = new Set();
    const activeStages = new Set(["starting", "transferring", "attaching", "checking"]);
    const uncertainCodes = new Set(["capture-commit-uncertain", "capture-commit-partial", "request-outcome-unknown"]);
    const noteCheckCodes = new Set(["app-unavailable", "host-unavailable", "verification-unavailable", "bootstrap-rejected", "request-outcome-unknown", "capture-commit-uncertain", "binding-service-restarted"]);
    const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
    const codeOf = (result) => result?.errorObject?.error?.code || result?.errorObject?.code || "capture-commit-uncertain";
    const blocks = () => current && !current.acknowledged && current.stage !== "completed" && current.stage !== "failed";

    function taskConnection(value) {
      return value && value.version === 1 && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
        && /^[a-f0-9]{64}$/.test(String(value.fingerprint || "")) ? value : null;
    }

    // Every business dispatch of a task stays on the connection the task was
    // accepted under. A persisted task whose log predates binding has no
    // attributable Desktop: fail closed instead of dispatching anywhere.
    // meta (optional object) receives the endpoint nonce this dispatch was
    // verified under, so restart confirmations bind to the receipt's source
    // generation instead of "the latest nonce".
    async function dispatch(method, path, body, meta) {
      const connection = taskConnection(current?.connection);
      if (connectionProvider && !connection && !unboundSessionTasks.has(current)) {
        return { ok: false, notDispatched: true, errorObject: { code: "capture-task-binding-missing" } };
      }
      return request(method, path, body, connection, meta);
    }

    async function save() { await write(copy(current)); }
    async function load() {
      if (loaded) return;
      if (!loading) loading = (async () => {
        const stored = await read();
        current = stored?.version === 1 ? stored : null;
        loaded = true;
      })().finally(() => { loading = null; });
      await loading;
    }
    async function stop(stage, code) {
      current.stage = stage;
      current.errorCode = code;
      await save();
    }
    async function attach() {
      current.stage = "attaching";
      await save();
      const result = await dispatch("POST", "/api/notes/attach-material", {
        ...current.noteRequest, assetId: current.asset.id,
      });
      current.noteResult = result;
      if (!result.ok) {
        current.noteCheckAvailable = noteCheckCodes.has(codeOf(result));
        return stop("partial", codeOf(result));
      }
      current.stage = current.organizationPartial ? "partial" : "completed";
      current.errorCode = null;
      await save();
    }
    async function finishImport(result) {
      if (!result.ok) {
        const code = codeOf(result);
        current.importFailure = protocol.projectMaterialImportFailure(result.errorObject);
        // A delivery permission check can fail after the host has committed.
        // Both final wire envelopes retain this bounded uncertainty marker;
        // the exact delivery-denied code also denotes this post-write check.
        const writeUnknown = result.errorObject?.error?.details?.writeOutcome === "unknown"
          || result.errorObject?.writeOutcome === "unknown" || code === "consumer-delivery-denied";
        const unknown = !result.notDispatched && (writeUnknown || uncertainCodes.has(code)
          || (current.mediaIdentity && (!result.status || result.status >= 500 || result.status === 409)));
        return stop(unknown ? "uncertain" : "failed", code);
      }
      const parsed = protocol.parseCaptureImportReceipt(result.data, current, media);
      if (!parsed.ok) return stop("uncertain", parsed.code);
      current.asset = parsed.asset;
      current.disposition = parsed.disposition;
      if (current.mediaIdentity) {
        current.organizationPartial = parsed.organizationPartial;
        // Keep immutable identity/outcome, never source URLs or full asset blobs.
        current.receipt = { consumerVersion: 1, ...current.mediaIdentity, assetId: parsed.asset.id, assetName: parsed.asset.name,
          disposition: parsed.disposition, organization: { state: parsed.receipt.organization.state }, atomic: false };
      }
      if (current.noteRequest) return attach();
      current.stage = current.organizationPartial ? "partial" : "completed";
      await save();
    }
    function parseTransfer(value, expectedId = current.transferId) {
      if (current.mediaIdentity && (value?.libraryId !== current.mediaIdentity.libraryId || value.requestId !== current.id)) return { ok: false, code: "media-receipt-identity" };
      const parsed = protocol.parseMediaTransferSnapshot(value);
      if (parsed.ok && expectedId && parsed.transferId !== expectedId) return { ok: false, code: "media-transfer-identity" };
      if (!parsed.ok) return parsed;
      if (!current.mediaIdentity) {
        // Check raw receipt identifiers before display sanitization can strip
        // control characters or truncate an invalid identifier into a valid one.
        if (parsed.state === "completed") {
          const receipt = protocol.parseCaptureImportReceipt({ disposition: parsed.skippedDuplicate ? "duplicate" : "imported",
            asset: { id: value.assetId, name: parsed.assetName, kind: value.assetKind } }, current, media);
          if (!receipt.ok) return receipt;
        }
        return parsed;
      }
      const receipt = value.receipt ? protocol.parseCaptureImportReceipt(value.receipt, current, media) : null;
      if (receipt && !receipt.ok) return receipt;
      return { ...parsed, libraryId: current.mediaIdentity.libraryId, requestId: current.id, ...(receipt ? { receipt: receipt.receipt } : {}) };
    }
    async function checkMediaReceipt() {
      const observed = current, expected = copy(current.mediaIdentity), expectedTransfer = current.transferId, revision = transferRevision;
      const stillOriginal = () => current === observed && !current.acknowledged && current.id === expected.requestId
        && current.transferId === expectedTransfer && transferRevision === revision
        && current.mediaIdentity?.libraryId === expected.libraryId && current.mediaIdentity?.requestId === expected.requestId
        && current.mediaIdentity?.operation === expected.operation;
      recoveryChecked = true; current.stage = "checking"; await save();
      const meta = {};
      const result = await dispatch("POST", "/api/material-libraries/media-receipt", expected, meta);
      if (!stillOriginal()) return;
      if (!result.ok) {
        // Reconnect observation can retry this read, never the original
        // import. A dispatch refused before send keeps its own truthful code.
        recoveryChecked = false; receiptRetryAt = now() + 1500;
        return stop("uncertain", result.notDispatched === true && codeOf(result) === "capture-task-binding-missing"
          ? "capture-task-binding-missing" : "media-receipt-unavailable");
      }
      const found = media.lookup(result.data, expected);
      if (!found.ok) return stop("uncertain", found.code);
      if (found.state === "unknown") return stop("uncertain", "request-outcome-unknown");
      // Restart recovery unlocks ONLY here, and ONLY after every identity has
      // been validated: lookup matched libraryId/requestId; a completed
      // answer additionally carried a receipt-checked asset; a pending answer
      // is parsed below FIRST so a wrong transferId can never unlock. The
      // confirmation is bound to meta.serverNonce — the nonce this receipt
      // was received under. A service that restarted again in between is
      // refused and the task re-reconciles on the next attempt.
      const confirmStep = async () => {
        if (!confirm || !taskConnection(current.connection)) return true;
        const confirmed = await confirm(current.connection, meta.serverNonce || null);
        if (confirmed?.ok === true) return true;
        recoveryChecked = false; receiptRetryAt = now() + 1500;
        return stop("uncertain", confirmed?.code || "media-receipt-unavailable");
      };
      if (found.state === "completed") {
        if (!await confirmStep()) return;
        return finishImport({ ok: true, data: found.receipt });
      }
      if (found.state === "rejected") {
        current.importFailure = protocol.projectMaterialImportFailure(found.response.body);
        return stop("failed", codeOf({ errorObject: found.response.body }));
      }
      const transfer = parseTransfer(found.transfer);
      if (!transfer.ok) return stop("uncertain", transfer.code);
      if (found.state !== "pending" && transfer.state !== found.state) return stop("uncertain", "media-receipt-invalid");
      if (found.state === "pending" && !await confirmStep()) return;
      current.transferId = transfer.transferId; current.transfer = transfer;
      if (found.state === "failed" || found.state === "cancelled") return stop("failed", transfer.errorCode || "media-transfer-failed");
      current.stage = "transferring"; await save(); return followTransfer();
    }
    async function followTransfer() {
      const observed = current, expectedId = current.transferId;
      const owns = revision => current === observed && !observed.acknowledged && observed.transferId === expectedId
        && observed.stage === "transferring" && transferRevision === revision;
      for (let poll = 0; poll < 2400; poll += 1) {
        const revision = transferRevision;
        if (!owns(revision)) return;
        let result;
        try {
          result = poll === 0 && current.transfer && ["completed", "failed", "cancelled"].includes(current.transfer.state)
            ? { ok: true, data: current.transfer }
            : await dispatch("GET", `/api/media/transfers/${expectedId}`);
        } catch (_) {
          if (owns(revision)) return stop("uncertain", "capture-commit-uncertain");
          if (current === observed && observed.stage === "transferring" && observed.transferId === expectedId) continue;
          return;
        }
        // Cancellation can settle this task and permit a new one while this
        // request is still in flight. Neither its value nor error owns the UI.
        if (!owns(revision)) {
          if (current === observed && observed.stage === "transferring" && observed.transferId === expectedId) continue;
          return;
        }
        if (!result.ok) {
          const code = codeOf(result);
          // A restarted desktop has lost this in-memory job. Never start a new
          // download under the old action, or claim it is still running. An
          // unattributable legacy log stays explicitly unknown, never paused
          // on some other instance's connection.
          return stop(code === "media-transfer-not-found" || code === "capture-task-binding-missing" ? "uncertain" : "paused", code);
        }
        const transfer = parseTransfer(result.data, expectedId);
        if (!transfer.ok) return stop("uncertain", transfer.code);
        current.transfer = transfer;
        await save();
        if (!owns(revision)) continue;
        if (transfer.state === "completed" && current.mediaIdentity) return finishImport({ ok: true, data: result.data.receipt });
        if (transfer.state === "completed") return finishImport({ ok: true, data: {
          disposition: transfer.skippedDuplicate ? "duplicate" : "imported",
          asset: { id: transfer.assetId, name: transfer.assetName, kind: transfer.assetKind },
        } });
        if (transfer.state === "failed" || transfer.state === "cancelled") {
          return stop("failed", transfer.errorCode || "media-transfer-failed");
        }
        await delay(750);
      }
      // Observation limits do not cancel a user's still-running desktop job.
      if (owns(transferRevision)) await stop("paused", "media-transfer-timeout");
    }
    function run(operation) {
      if (running) return running;
      const observed = current, revision = transferRevision;
      const pending = Promise.resolve().then(operation).catch(async () => {
        if (current === observed && !observed.acknowledged && transferRevision === revision) {
          current.stage = current.asset ? "partial" : "uncertain";
          current.errorCode = "capture-commit-uncertain";
          await save().catch(() => {});
        }
      }).finally(() => { if (running === pending) running = null; });
      running = pending;
      return running;
    }
    async function start(input) {
      input = copy(input);
      await load();
      if (starting || running || blocks()) return { ok: false, code: "capture-task-pending", task: copy(current) };
      if (!input || !["image", "video", "audio"].includes(input.kind)
        || !/^popup:[a-zA-Z0-9:_-]{1,120}$/.test(input.request?.requestId || "")
        || (input.noteRequest && input.noteRequest.requestId !== input.request.requestId)) {
        return { ok: false, code: "media-input-invalid" };
      }
      if (input.request.libraryId) {
        const validated = media?.validateRequest(input.kind, input.request);
        if (!validated?.ok) return { ok: false, code: validated?.code || "media-library-unavailable" };
      }
      // Resolve the verified connection first: a task may only be accepted
      // when its Desktop binding is already known and recordable. A frozen
      // connection supplied by the submission entry point wins — the whole
      // chain (library validation, organize target, dispatch) ran under it,
      // so a selection change mid-flight can never retarget this task.
      let connection = null;
      const frozen = taskConnection(input.connection);
      if (frozen) {
        connection = frozen;
      } else if (connectionProvider) {
        const resolved = await connectionProvider();
        if (!resolved?.ok) return { ok: false, code: resolved?.code || "media-library-unavailable",
          ...(resolved?.candidates ? { candidates: resolved.candidates } : {}) };
        connection = taskConnection(resolved.binding) || null;
      }
      starting = true;
      try {
        current = {
          version: 1, id: input.request.requestId, kind: input.kind,
          stage: "starting", sourceUrl: input.kind === "audio" ? "" : input.sourceUrl || "", createdAt: Date.now(),
          noteRequest: copy(input.noteRequest || null),
          ...(input.request.libraryId ? { mediaIdentity: media.identity(input.kind, input.request) } : {}),
          // The binding descriptor carries endpoint/origin/digest only; the
          // transport refreshes serverNonce in place after verified writes.
          ...(connection ? { connection: copy(connection) } : {}),
        };
        if (!current.connection) unboundSessionTasks.add(current);
        recoveryChecked = false;
        receiptRetryAt = 0;
        transferRevision += 1;
        // Persist before dispatch so closing the popup can never erase an
        // accepted action. A lost start response remains explicitly unknown.
        await save();
        const accepted = copy(current);
        const observed = current, revision = transferRevision;
        run(async () => {
          const result = await dispatch("POST", input.kind !== "image" ? "/api/media/transfers" : "/api/assets/import-media", input.request);
          if (current !== observed || observed.acknowledged || transferRevision !== revision) return;
          if (input.kind === "image" || !result.ok) return finishImport(result);
          const transfer = parseTransfer(result.data);
          if (!transfer.ok) return stop("uncertain", transfer.code);
          current.transferId = transfer.transferId;
          current.transfer = transfer;
          current.stage = "transferring";
          await save();
          await followTransfer();
        });
        return { ok: true, task: accepted };
      } finally { starting = false; }
    }
    async function status() {
      await load();
      if (!starting && !running && current && !current.acknowledged) {
        if (current.stage === "transferring") run(current.mediaIdentity && !recoveryChecked ? checkMediaReceipt : followTransfer);
        else if (current.stage === "attaching" && current.asset) run(attach);
        else if (current.mediaIdentity && !recoveryChecked && now() >= receiptRetryAt && ["starting", "checking", "uncertain"].includes(current.stage)) { run(checkMediaReceipt); await Promise.resolve(); }
        else if (current.stage === "starting" || current.stage === "checking") await stop("uncertain", "capture-commit-uncertain");
      }
      return { ok: true, task: copy(current) };
    }
    async function resume(id) {
      await load();
      if (current?.id !== id) return { ok: false, code: "capture-task-changed" };
      if (!running && current.mediaIdentity && ["uncertain", "paused"].includes(current.stage)) {
        run(checkMediaReceipt);
      } else if (!running && current.stage === "paused" && current.transferId) {
        current.stage = "transferring";
        run(followTransfer);
      } else if (!running && current.stage === "partial" && current.noteCheckAvailable && current.asset && current.noteRequest) {
        // Exactly the original request/binding. The durable desktop receipt
        // prevents a second append, including an interrupted acknowledgement.
        run(attach);
      }
      return { ok: true, task: copy(current) };
    }
    async function acknowledge(id) {
      await load();
      if (current?.id !== id || running || activeStages.has(current?.stage)) return { ok: false, code: "capture-task-pending" };
      current.acknowledged = true;
      await save();
      return { ok: true, task: copy(current) };
    }
    async function cancel(id) {
      await load();
      if (current?.id !== id || !current.transferId || current.asset || !["transferring", "paused"].includes(current.stage))
        return { ok: false, code: "capture-task-changed" };
      const observed = current, transferId = current.transferId, revision = transferRevision;
      const result = await dispatch("POST", `/api/media/transfers/${transferId}/cancel`);
      if (current !== observed || current.transferId !== transferId || current.acknowledged || current.asset
        || transferRevision !== revision || !["transferring", "paused"].includes(current.stage))
        return { ok: false, code: "capture-task-changed" };
      if (!result.ok) return { ok: false, code: codeOf(result) };
      const transfer = parseTransfer(result.data);
      if (!transfer.ok) return { ok: false, code: transfer.code };
      if (transfer.transferId !== transferId) return { ok: false, code: "capture-task-changed" };
      transferRevision += 1;
      current.transfer = transfer;
      if (transfer.state === "cancelled" || transfer.state === "failed") {
        const oldRun = running;
        await stop("failed", transfer.errorCode || (transfer.state === "cancelled" ? "media-transfer-cancelled" : "media-transfer-failed"));
        if (running === oldRun) running = null;
        return { ok: true, task: copy(observed) };
      }
      await save();
      if (!running && current === observed && !observed.acknowledged && !observed.asset && ["transferring", "paused"].includes(observed.stage)) {
        current.stage = "transferring"; run(followTransfer);
      }
      return { ok: true, task: copy(observed) };
    }
    return { start, status, resume, acknowledge, cancel };
  }
  const api = { create };
  global.LuckyRayCaptureTask = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
