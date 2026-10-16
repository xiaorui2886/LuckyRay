// Host-owned JSON transport adapter for Collector/SDK consumers. This module
// neither obtains credentials nor turns library enumeration into permission.
(function (root) {
  "use strict";
  const VERSION = 1;
  const paths = Object.freeze({ libraries: "/api/material-libraries", taxonomy: "/api/material-libraries/taxonomy", importBytes: "/api/material-libraries/import-bytes", query: "/api/material-libraries/query", detail: "/api/material-libraries/detail" });
  const validRequestId = id => validId(id) && id.length <= 128;
  const validId = id => typeof id === "string" && id.length > 0 && id.length <= 160 && /^[A-Za-z0-9_:-]+$/.test(id);
  class ConsumerError extends Error {
    constructor(code, message = code) { super(message); this.name = "MaterialLibraryConsumerError"; this.code = code; }
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const deepFreeze = value => {
    if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
  };
  function create(request) {
    if (typeof request !== "function") throw new TypeError("Verified host JSON transport is required");
    let libraryId = null, epoch = 0;
    const generations = new Map();
    const operations = new WeakMap();
    const validate = (value, target) => {
      if (!value || value.consumerVersion !== VERSION) throw new ConsumerError("consumer-contract-unavailable");
      if (target && (value.libraryId !== target.libraryId || value.requestId !== target.requestId)) throw new ConsumerError("consumer-response-identity");
      return value;
    };
    const select = id => {
      if (!validId(id)) throw new ConsumerError("consumer-input-invalid");
      libraryId = id; epoch++; generations.clear();
      return Object.freeze({ libraryId, epoch });
    };
    const read = async (kind, requestId, extra = {}) => {
      if (!validId(libraryId) || !validRequestId(requestId)) throw new ConsumerError("consumer-target-required");
      const target = { libraryId, requestId }, startedEpoch = epoch;
      const generation = (generations.get(kind) || 0) + 1; generations.set(kind, generation);
      const current = () => epoch === startedEpoch && generations.get(kind) === generation;
      try {
        const result = await request("POST", paths[kind], { ...extra, ...target });
        if (!current()) throw new ConsumerError("consumer-stale-result");
        return validate(result, target);
      } catch (error) {
        if (!current()) throw new ConsumerError("consumer-stale-result");
        throw error;
      }
    };
    const prepareCapture = input => {
      if (!validId(libraryId) || !input || !validRequestId(input.requestId)) throw new ConsumerError("consumer-target-required");
      if (input.libraryId && input.libraryId !== libraryId) throw new ConsumerError("consumer-target-changed");
      const body = deepFreeze(clone({ ...input, libraryId }));
      const operation = Object.freeze({ libraryId, requestId: body.requestId, body });
      operations.set(operation, { epoch, json: JSON.stringify(body) });
      return operation;
    };
    const save = async operation => {
      const frozen = operations.get(operation);
      if (!frozen) throw new ConsumerError("consumer-operation-unbound");
      // Retry is byte-for-byte the prepared payload; UI selection is irrelevant.
      const current = () => epoch === frozen.epoch && libraryId === operation.libraryId;
      try {
        const receipt = validate(await request("POST", paths.importBytes, JSON.parse(frozen.json)), operation);
        return Object.freeze({ receipt, current: current() });
      } catch (error) {
        const bound = new ConsumerError(error?.code || "consumer-save-failed", error?.message || "素材保存失败");
        bound.libraryId = operation.libraryId; bound.requestId = operation.requestId; bound.current = current();
        throw bound;
      }
    };
    return Object.freeze({
      select,
      libraries: async () => validate(await request("GET", paths.libraries)),
      taxonomy: requestId => read("taxonomy", requestId),
      query: (requestId, filter = {}) => read("query", requestId, { filter }),
      detail: (requestId, assetId) => read("detail", requestId, { assetId }),
      prepareCapture, save,
      snapshot: () => Object.freeze({ libraryId, epoch }),
    });
  }
  root.LuckyRayMaterialLibraries = Object.freeze({ version: VERSION, paths, create, ConsumerError });
})(globalThis);
