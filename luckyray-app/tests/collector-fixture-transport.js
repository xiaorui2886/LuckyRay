// TEST PACKAGE ONLY: substituted before any discovery/native message can run.
// This module never contacts a Desktop instance or obtains real credentials.
(function (global) {
  "use strict";
  const port = Number(chrome.runtime.getManifest().version_name.split("fixture-port:")[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("fixture port missing");
  const origin = `http://127.0.0.1:${port}`, network = global.fetch.bind(global);
  global.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    return url.origin === origin ? network(input, init) : Promise.resolve(new Response("fixture-only", { status: 503 }));
  };
  // The production background now resolves one verified binding before any
  // dispatch and has no numeric-port fallback, so the mock exposes the same
  // descriptor surface with synthetic digests for its single fixture port.
  const fingerprint = "f".repeat(64), serverNonce = "e".repeat(64);
  const descriptor = () => Object.freeze({ version: 1, port, origin: `chrome-extension://${chrome.runtime.id}`,
    fingerprint, serverNonce });
  global.LuckyRayLocalTransport = Object.freeze({
    discover: async () => port,
    verify: async () => true,
    discoverCandidates: async () => [descriptor()],
    openBinding: async (target) => {
      const targetPort = Number.isInteger(target) ? target : target?.port;
      if (targetPort !== port) {
        throw Object.assign(new Error("fixture binding unavailable"), { code: "binding-connection-lost" });
      }
      return { ...descriptor() };
    },
    confirmBinding: async (record) => {
      if (record?.port !== port || record?.fingerprint !== fingerprint) {
        throw Object.assign(new Error("fixture identity mismatch"), { code: "binding-identity-mismatch" });
      }
      return { ok: true, serverNonce };
    },
    fetch: async (_binding, pathname, init = {}) => {
      if (!/^\/api\//.test(pathname)) throw new Error("non-fixture route");
      return network(origin + pathname, init);
    },
    runtimeOrigin: () => `chrome-extension://${chrome.runtime.id}`,
    resetSession() {},
  });
})(globalThis);
