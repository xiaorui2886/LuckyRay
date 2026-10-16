(function installLuckyRayLocalTransport(global) {
  "use strict";

  const HOST_NAME = "com.luckyray.desktop";
  const SECRET_PATTERN = /^[a-f0-9]{64}$/;
  const NATIVE_MESSAGE_TIMEOUT_MS = 5000;
  const DISCOVERY_FIRST_PORT = 37418;
  const DISCOVERY_LAST_PORT = 37467;
  // Only an explicitly generated isolated test build supplies this immutable
  // preset BEFORE this module loads. Product builds retain ordinary discovery.
  const isolatedTarget = global.__LUCKYRAY_ISOLATED_TRANSPORT_TARGET__ || null;
  if (isolatedTarget && (!Object.isFrozen(isolatedTarget) || isolatedTarget.name !== "ray-secondary-v1" || isolatedTarget.port !== 37468
    || isolatedTarget.origin !== runtimeOrigin() || !Array.isArray(isolatedTarget.libraryIds) || !Object.isFrozen(isolatedTarget.libraryIds) || !isolatedTarget.libraryIds.length
    || isolatedTarget.libraryIds.some(id => !/^[A-Za-z0-9_:-]{1,160}$/.test(id)) || !isolatedTarget.libraryIds.includes(isolatedTarget.defaultLibraryId))) {
    throw transportError("host-forbidden", "Invalid isolated test target");
  }
  const isolatedTransfers = new Map();
  let cachedConfig = null;
  let bootstrapPromise = null;

  // Observe only this worker's PNG POST while it is in flight. Existing
  // webRequest permission is sufficient; never request headers/requestBody,
  // retain URLs, or turn a network failure into permission to replay a write.
  const pngNetworkAttempts = new Set();
  let pngNetworkObservable = false;
  try {
    const api = chrome.webRequest;
    if (api?.onBeforeRequest && api?.onResponseStarted && api?.onErrorOccurred) {
      const filter = { urls: ["http://127.0.0.1/api/material-libraries/import-bytes"] };
      const matching = details => {
        if (details.method !== "POST" || details.initiator !== runtimeOrigin()) return [];
        return [...pngNetworkAttempts].filter(attempt => attempt.url === details.url);
      };
      api.onBeforeRequest.addListener(details => {
        const attempts = matching(details);
        for (const attempt of attempts) {
          if (attempts.length !== 1 || attempt.networkId !== null) {
            attempt.event = "ambiguous";
            attempt.networkId = null;
          } else {
            attempt.event = "started";
            attempt.networkId = details.requestId;
          }
        }
      }, filter);
      const record = (details, event) => {
        for (const attempt of matching(details)) {
          if (attempt.event === "ambiguous" || attempt.networkId !== details.requestId) continue;
          attempt.event = event;
          if (Number.isInteger(details.statusCode)) attempt.status = details.statusCode;
          if (event === "error") attempt.error = /^net::ERR_[A-Z0-9_]{1,64}$/.test(details.error || "")
            ? details.error : "network-error";
        }
      };
      api.onResponseStarted.addListener(details => record(details, "response"), filter);
      api.onErrorOccurred.addListener(details => record(details, "error"), filter);
      pngNetworkObservable = true;
    }
  } catch (_) { /* Older browser/test host: explicitly mark unobservable. */ }

  function beginPngNetworkAttempt(url, method) {
    if (method !== "POST" || !/^http:\/\/127\.0\.0\.1:\d+\/api\/material-libraries\/import-bytes$/.test(url)) return null;
    const attempt = { url, port: Number(new URL(url).port), networkId: null,
      event: pngNetworkObservable ? "unobserved" : "unavailable", status: null, error: null };
    if (pngNetworkAttempts.size >= 8) return null;
    pngNetworkAttempts.add(attempt);
    return attempt;
  }

  function transportError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function runtimeOrigin() {
    const root = chrome.runtime.getURL("");
    const match = /^(chrome-extension|moz-extension):\/\/([a-z0-9_-]+)\/?$/.exec(root);
    if (!match) throw transportError("host-forbidden", "Invalid extension origin");
    return `${match[1]}://${match[2]}`;
  }

  function baseUrl(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay endpoint");
    }
    return `http://127.0.0.1:${port}`;
  }

  function candidatePorts() {
    if (isolatedTarget) return [isolatedTarget.port];
    const testPorts = typeof process !== "undefined" && process.versions && process.versions.node
      ? global.__LUCKYRAY_TEST_PORTS__
      : null;
    if (Array.isArray(testPorts) && testPorts.length > 0) {
      return [...new Set(testPorts.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
    }
    return Array.from(
      { length: DISCOVERY_LAST_PORT - DISCOVERY_FIRST_PORT + 1 },
      (_, index) => DISCOVERY_FIRST_PORT + index,
    );
  }

  function hexToBytes(value) {
    if (!SECRET_PATTERN.test(value)) throw transportError("protocol-incompatible", "Invalid credential");
    return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
  }

  function bytesToHex(value) {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function randomNonce() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function proofMessage(origin, port, clientNonce, serverNonce) {
    return `luckyray-local-transport-proof-v1\nprotocol:1\norigin:${origin}\nport:${port}\nclientNonce:${clientNonce}\nserverNonce:${serverNonce}`;
  }

  async function hmacHex(credential, message) {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(credential),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  }

  // Binding descriptors identify a verified endpoint by digest only. The
  // credential itself never leaves this module's in-memory session.
  async function sha256Hex(value) {
    return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  }

  function constantTimeTextEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 3000);
    try {
      return await fetch(url, { ...(init || {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns { serverNonce } for a verified server, or null. The desktop keeps
  // one serverNonce per service instance, so a change means that service
  // restarted even when its credential (and fingerprint) stay identical.
  async function verifyServerProof(port, credential, timeoutMs) {
    const clientNonce = randomNonce();
    let response;
    try {
      response = await fetchWithTimeout(
        `${baseUrl(port)}/api/v1/proof`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientNonce }),
        },
        timeoutMs || 1200,
      );
    } catch (_) {
      return null;
    }
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const data = payload && payload.ok && payload.data;
    if (
      !data || data.protocolVersion !== 1 || data.port !== port || data.clientNonce !== clientNonce
      || !SECRET_PATTERN.test(data.serverNonce) || !SECRET_PATTERN.test(data.proof)
    ) return null;
    const expected = await hmacHex(
      credential,
      proofMessage(runtimeOrigin(), port, clientNonce, data.serverNonce),
    );
    if (!constantTimeTextEqual(expected, data.proof)) return null;
    return { serverNonce: data.serverNonce };
  }

  function nativeHostError(text) {
    const message = text || "Native host unavailable";
    const code = /not found|not registered|forbidden|access/i.test(message)
      ? "host-not-installed"
      : "host-unavailable";
    const diagnostic = /not found|not registered/i.test(message)
      ? "native-host-not-found"
      : /forbidden|access/i.test(message)
        ? "native-host-forbidden"
        : /exited/i.test(message)
          ? "native-host-exited"
          : /message port|disconnected|closed/i.test(message)
            ? "native-channel-closed"
            : /did not respond|timeout/i.test(message)
              ? "native-host-timeout"
              : "native-host-unavailable";
    const error = transportError(code, message);
    error.diagnostic = diagnostic;
    return error;
  }

  function callbackNativeMessage(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(nativeHostError("Native host did not respond")), NATIVE_MESSAGE_TIMEOUT_MS);
      chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
        clearTimeout(timer);
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(nativeHostError(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function nativeMessage(message) {
    return callbackNativeMessage(message);
  }

  function validateBootstrapResponse(response, expectedPort) {
    if (!response || response.ok !== true || !response.data) {
      const code = response && response.error && response.error.code;
      const message = response && response.error && response.error.message;
      throw transportError(code || "host-unavailable", message || "LuckyRay native host failed");
    }
    const data = response.data;
    if (
      data.protocolVersion !== 1 || !Number.isInteger(data.actualPort)
      || (Number.isInteger(expectedPort) && data.actualPort !== expectedPort)
      || data.baseUrl !== baseUrl(data.actualPort) || !SECRET_PATTERN.test(data.credential)
    ) {
      throw transportError("protocol-incompatible", "LuckyRay and the extension must be updated");
    }
    return Object.freeze({
      protocolVersion: data.protocolVersion,
      baseUrl: data.baseUrl,
      actualPort: data.actualPort,
      credential: data.credential,
    });
  }

  async function probeHealth(port) {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl(port)}/api/v1/health`,
        { method: "GET", cache: "no-store" },
        450,
      );
      if (!response.ok) return { port, compatible: false, service: false };
      const payload = await response.json().catch(() => null);
      const data = payload && payload.ok && payload.data;
      if (!data || data.service !== "luckyray-local-transport") {
        return { port, compatible: false, service: false };
      }
      return {
        port,
        compatible: data.protocolVersion === 1 && data.extensionBootstrap === true,
        service: true,
      };
    } catch (_) {
      return { port, compatible: false, service: false };
    }
  }

  async function bootstrapCandidate(port) {
    // A restarting desktop can interrupt the first control connection after
    // health becomes available. Bootstrap has no business payload or write;
    // retry a transport interruption once, then still require a valid proof.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let payload;
      try {
        const response = await fetchWithTimeout(
          `${baseUrl(port)}/api/v1/extension/bootstrap`,
          {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
          900,
        );
        if (!response.ok) return null;
        payload = await response.json();
      } catch (_) {
        continue;
      }
      let config;
      try {
        config = validateBootstrapResponse(payload, port);
      } catch (_) {
        return null;
      }
      const proof = await verifyServerProof(port, config.credential, 1000);
      if (!proof) return null;
      return { ...config, fingerprint: await sha256Hex(config.credential), serverNonce: proof.serverNonce };
    }
    return null;
  }

  async function discoverDirectConfig() {
    const probes = await Promise.all(candidatePorts().map((port) => probeHealth(port)));
    let sawIncompatibleService = false;
    let sawVerificationFailure = false;
    for (const probe of probes) {
      if (probe.service && !probe.compatible) sawIncompatibleService = true;
      if (!probe.compatible) continue;
      const config = await bootstrapCandidate(probe.port);
      if (config) return config;
      sawVerificationFailure = true;
    }
    if (sawVerificationFailure) {
      throw transportError("verification-unavailable", "LuckyRay server identity could not be verified");
    }
    if (sawIncompatibleService) {
      throw transportError("protocol-incompatible", "LuckyRay and the extension must be updated");
    }
    throw transportError("app-unavailable", "Open LuckyRay and try again");
  }

  async function bootstrap(force) {
    if (!force && cachedConfig) return cachedConfig;
    if (bootstrapPromise) return bootstrapPromise;
    if (force) cachedConfig = null;
    bootstrapPromise = (async () => {
      const config = await discoverDirectConfig();
      cachedConfig = config;
      return config;
    })();
    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  function resetSession() {
    cachedConfig = null;
    bootstrapPromise = null;
    isolatedTransfers.clear();
  }

  function invalidateCachedConfig() {
    cachedConfig = null;
  }

  async function verify(port, timeoutMs) {
    const config = cachedConfig || await bootstrap();
    if (Number.isInteger(port) && port !== config.actualPort) return false;
    const proof = await verifyServerProof(config.actualPort, config.credential, timeoutMs);
    if (!proof) {
      invalidateCachedConfig();
      return false;
    }
    config.serverNonce = proof.serverNonce;
    return true;
  }

  async function discover() {
    if (cachedConfig) {
      const proof = await verifyServerProof(cachedConfig.actualPort, cachedConfig.credential, 900);
      if (proof) {
        cachedConfig.serverNonce = proof.serverNonce;
        return cachedConfig.actualPort;
      }
    }
    invalidateCachedConfig();
    return (await bootstrap(true)).actualPort;
  }

  async function isAuthenticationRejection(response) {
    if (response.status === 401) return true;
    if (response.status !== 403) return false;
    const payload = await response.clone().json().catch(() => null);
    const code = String(payload?.code || payload?.error?.code || "");
    return new Set([
      "authentication-required",
      "extension-bootstrap-required",
      "origin-not-allowed",
      "extension-origin-forbidden",
    ]).has(code);
  }

  // ---- Instance binding ------------------------------------------------
  //
  // Discovery (choosing which Desktop to talk to) and business dispatch
  // (sending a task's requests) are separate. A binding descriptor carries
  // only the canonical loopback endpoint, this extension's origin, the
  // SHA-256 digest of the verified credential context and the last verified
  // serverNonce — never a raw credential. Dispatch under a binding recovers
  // on the SAME endpoint only: it never scans ports and never fails over to
  // another Desktop instance, so a task cannot be attributed to a different
  // computer by a failed proof, a 401/403 or a lost response.

  function connectionBindingTarget(target) {
    if (target == null || Number.isInteger(target)) return null;
    if (typeof target !== "object" || Array.isArray(target)) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay connection binding");
    }
    if (target.version !== 1 || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
      || target.origin !== runtimeOrigin() || !SECRET_PATTERN.test(String(target.fingerprint || ""))) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay connection binding");
    }
    if (target.serverNonce != null && !SECRET_PATTERN.test(target.serverNonce)) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay connection binding");
    }
    return { port: target.port, fingerprint: target.fingerprint, serverNonce: target.serverNonce || null };
  }

  async function bootstrapPortOnly(port) {
    // Recovery for a bound dispatch: this one endpoint, no port scan, no
    // failover. Bootstrap and proof still carry no business payload.
    const probe = await probeHealth(port);
    if (probe.service && !probe.compatible) {
      throw transportError("protocol-incompatible", "LuckyRay and the extension must be updated");
    }
    const config = await bootstrapCandidate(port);
    if (config) return config;
    if (probe.compatible) {
      throw transportError("verification-unavailable", "LuckyRay server identity could not be verified");
    }
    throw transportError("binding-connection-lost", "The bound LuckyRay connection is unavailable");
  }

  function sessionConfigForBinding(binding) {
    if (!cachedConfig || cachedConfig.actualPort !== binding.port || cachedConfig.fingerprint !== binding.fingerprint) {
      return null;
    }
    return cachedConfig;
  }

  async function openBinding(port) {
    // Verifies one endpoint and returns a fresh caller-owned binding
    // descriptor (no credential). The caller persists and re-passes it.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay endpoint");
    }
    // The caller is choosing this exact port; it checks the returned digest.
    // Reuse only the credential held in memory, never a cached proof. Passing
    // { port } to sessionConfigForBinding required an absent fingerprint and
    // accidentally forced health/bootstrap on every selection/status read.
    let config = cachedConfig?.actualPort === port ? cachedConfig : null;
    const proof = config && await verifyServerProof(port, config.credential, 1000);
    if (proof) config = { ...config, serverNonce: proof.serverNonce };
    else config = await bootstrapPortOnly(port);
    cachedConfig = config;
    return { version: 1, port: config.actualPort, origin: runtimeOrigin(),
      fingerprint: config.fingerprint, serverNonce: config.serverNonce };
  }

  async function confirmBinding(record, expectedServerNonce) {
    // Explicit restart-recovery confirmation. Only a caller that has verified
    // a valid receipt (libraryId/requestId — and transferId when a snapshot is
    // involved) may call this; a failure, an unknown answer or a wrong
    // identity never unlocks the binding. Re-verifies the same endpoint and
    // identity. When expectedServerNonce is supplied it MUST equal the nonce
    // observed when that receipt was received: a different nonce means the
    // service restarted again between receipt and confirmation, so the
    // confirmation is refused and the caller must re-reconcile against the
    // new instance — the latest nonce is never accepted as a substitute.
    const binding = connectionBindingTarget(record);
    if (!binding) throw transportError("protocol-incompatible", "Invalid LuckyRay connection binding");
    if (expectedServerNonce != null && !SECRET_PATTERN.test(expectedServerNonce)) {
      throw transportError("protocol-incompatible", "Invalid LuckyRay confirmation nonce");
    }
    const config = await bootstrapPortOnly(binding.port);
    if (config.fingerprint !== binding.fingerprint) {
      const error = transportError("binding-identity-mismatch",
        "This LuckyRay task is bound to a different Desktop instance");
      error.notDispatched = true;
      throw error;
    }
    const proof = await verifyServerProof(config.actualPort, config.credential, 1000);
    if (!proof) {
      invalidateCachedConfig();
      throw transportError("verification-unavailable", "LuckyRay server identity could not be verified");
    }
    if (expectedServerNonce != null && proof.serverNonce !== expectedServerNonce) {
      const error = transportError("binding-restart-mismatch",
        "LuckyRay restarted again after the receipt; reconcile the task once more");
      error.restarted = true;
      error.notDispatched = true;
      throw error;
    }
    cachedConfig = config;
    if (!Object.isFrozen(record)) record.serverNonce = proof.serverNonce;
    return { ok: true, serverNonce: proof.serverNonce };
  }

  async function discoverCandidates() {
    // Explicit enumeration for connection selection: every compatible service
    // is bootstrap- and proof-verified, and only digests are returned. With
    // more than one candidate the user must choose; callers never silently
    // prefer the lowest port.
    const probes = await Promise.all(candidatePorts().map((port) => probeHealth(port)));
    const candidates = [];
    let sawIncompatibleService = false;
    let sawVerificationFailure = false;
    for (const probe of probes) {
      if (probe.service && !probe.compatible) sawIncompatibleService = true;
      if (!probe.compatible) continue;
      const config = await bootstrapCandidate(probe.port);
      if (!config) {
        sawVerificationFailure = true;
        continue;
      }
      candidates.push(Object.freeze({ version: 1, port: config.actualPort, origin: runtimeOrigin(),
        fingerprint: config.fingerprint, serverNonce: config.serverNonce }));
    }
    if (!candidates.length) {
      if (sawVerificationFailure) {
        throw transportError("verification-unavailable", "LuckyRay server identity could not be verified");
      }
      if (sawIncompatibleService) {
        throw transportError("protocol-incompatible", "LuckyRay and the extension must be updated");
      }
      throw transportError("app-unavailable", "Open LuckyRay and try again");
    }
    candidates.sort((left, right) => left.port - right.port);
    return candidates;
  }

  async function decorateTransportFailure(error, cause, networkAttempt) {
    // Preserve only the error class, never fetch messages, URLs or headers.
    error.transportFailure = ["AbortError", "TimeoutError", "TypeError"].includes(cause?.name)
      ? cause.name : "transport-error";
    if (networkAttempt) {
      // Browser event and Fetch promise delivery can be adjacent tasks.
      // One bounded observation delay, not another network request.
      if (pngNetworkObservable && networkAttempt.event !== "error") await new Promise(resolve => setTimeout(resolve, 75));
      const { event, status, error: networkError, port } = networkAttempt;
      error.transportNetwork = { event, status, error: networkError, port };
    }
    return error;
  }

  async function boundAuthorizedFetch(record, binding, path, init, timeoutMs, meta) {
    const method = String(init?.method || "GET").toUpperCase();
    const readOnly = method === "GET" || method === "HEAD";
    // The durable receipt lookup is the observation that reconciles an
    // existing task; it stays available exactly so a restarted service can be
    // asked about the original action before anything new is sent.
    const reconciling = method === "POST" && path === "/api/material-libraries/media-receipt";
    let businessDispatched = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let config = sessionConfigForBinding(binding);
      try {
        if (!config) {
          invalidateCachedConfig();
          config = await bootstrapPortOnly(binding.port);
          if (config.fingerprint !== binding.fingerprint) {
            // Another Desktop instance now owns this port. The bound task can
            // never be attributed to it.
            const error = transportError("binding-identity-mismatch",
              "This LuckyRay task is bound to a different Desktop instance");
            error.notDispatched = true;
            throw error;
          }
          cachedConfig = config;
        }
        if (!readOnly) {
          let proof = await verifyServerProof(config.actualPort, config.credential, 900);
          if (!proof) {
            // The remembered credential no longer proves this endpoint. A
            // fresh same-port bootstrap distinguishes a restarted service
            // under a different credential (identity mismatch) from a broken
            // proof path; it never widens to a port scan.
            invalidateCachedConfig();
            config = await bootstrapPortOnly(binding.port);
            if (config.fingerprint !== binding.fingerprint) {
              const error = transportError("binding-identity-mismatch",
                "This LuckyRay task is bound to a different Desktop instance");
              error.notDispatched = true;
              throw error;
            }
            cachedConfig = config;
            proof = await verifyServerProof(config.actualPort, config.credential, 900);
            if (!proof) {
              invalidateCachedConfig();
              throw transportError("verification-unavailable", "LuckyRay server identity could not be verified");
            }
          }
          config.serverNonce = proof.serverNonce;
          if (!reconciling && binding.serverNonce && proof.serverNonce !== binding.serverNonce) {
            // The bound service restarted since the task's last verified
            // dispatch. Reconcile the original task first; a new download or
            // note write must not be re-sent against the fresh instance.
            const error = transportError("binding-service-restarted",
              "LuckyRay restarted; verify the existing task before sending another write");
            error.restarted = true;
            throw error;
          }
        }
      } catch (error) {
        // Nothing was sent to a route in this phase; only that fact makes a
        // write retryable. A dispatch that already left can never inherit it.
        if (!readOnly && !businessDispatched && error.notDispatched === undefined) error.notDispatched = true;
        throw error;
      }
      const headers = new Headers((init && init.headers) || {});
      headers.set("Authorization", `Bearer ${config.credential}`);
      const requestUrl = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const networkAttempt = beginPngNetworkAttempt(requestUrl, method);
      // The nonce this dispatch was verified under — for writes it is the
      // fresh proof nonce, for reads the session nonce. Callers tie restart
      // confirmations to exactly this generation of the endpoint.
      if (meta && typeof meta === "object") meta.serverNonce = config.serverNonce;
      let response;
      try {
        businessDispatched = true;
        response = await fetchWithTimeout(
          requestUrl,
          { ...(init || {}), headers },
          timeoutMs || 5000,
        );
      } catch (cause) {
        invalidateCachedConfig();
        if (readOnly && attempt === 0) continue;
        // A bound read may retry on the same endpoint only. Once a write was
        // sent, a lost response does not prove the route did not run; the
        // caller must reconcile the task, never resubmit or fail over.
        throw await decorateTransportFailure(transportError(
          readOnly ? "binding-connection-lost" : "request-outcome-unknown",
          readOnly
            ? "The bound LuckyRay connection is unavailable"
            : "The request was sent but its result could not be confirmed",
        ), cause, networkAttempt);
      } finally {
        if (networkAttempt) pngNetworkAttempts.delete(networkAttempt);
      }
      if (!await isAuthenticationRejection(response)) {
        if (isolatedTarget && response.ok && method === "POST" && ["/api/media/transfers", "/api/material-libraries/media-receipt"].includes(path)) {
          const body = JSON.parse(init.body), payload = await response.clone().json().catch(() => null), value = payload?.ok === true && payload.data ? payload.data : payload;
          const transfer = path.endsWith("media-receipt") ? value?.state === "pending" ? value.transfer : null : value;
          if (value?.libraryId === body.libraryId && value.requestId === body.requestId && /^media-[a-f0-9]+-[a-f0-9]{16}$/i.test(transfer?.transferId || "")) isolatedTransfers.set(transfer.transferId, body.libraryId);
        }
        // No HTTP response — success or failure — ever refreshes the binding's
        // serverNonce. Restart recovery is unlocked only by confirmBinding,
        // after the caller verified a valid receipt for the original action.
        return response;
      }
      invalidateCachedConfig();
      if (attempt === 1) {
        throw transportError("bootstrap-rejected", "LuckyRay session must be refreshed");
      }
      // Authentication is rejected before the route adapter can dispatch, so
      // one same-endpoint re-bootstrap and one replay cannot duplicate a
      // business write — and can never switch to another Desktop instance.
    }
    throw transportError("bootstrap-rejected", "LuckyRay session must be refreshed");
  }

  async function authorizedFetch(_port, path, init, timeoutMs, meta) {
    const method = String(init?.method || "GET").toUpperCase();
    if (isolatedTarget) {
      const reads = new Set(["/api/v1/capabilities", "/api/v1/extension/appearance", "/api/material-libraries"]);
      const writes = new Set(["/api/assets/import-media", "/api/media/transfers", "/api/material-libraries/taxonomy", "/api/material-libraries/media-receipt"]);
      let body = null; try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) {}
      const ownedJob = /^\/api\/media\/transfers\/(media-[a-f0-9]+-[a-f0-9]{16})(?:\/cancel)?$/i.exec(path);
      const permitted = method === "GET" && reads.has(path) || method === "POST" && writes.has(path) && isolatedTarget.libraryIds.includes(body?.libraryId)
        || ownedJob && isolatedTarget.libraryIds.includes(isolatedTransfers.get(ownedJob[1])) && (method === "GET" || method === "POST" && path.endsWith("/cancel"));
      if (!permitted) { const error = transportError("host-forbidden", "This isolated test permits only its designated libraries"); error.notDispatched = true; throw error; }
    }
    const binding = connectionBindingTarget(_port);
    if (binding) return boundAuthorizedFetch(_port, binding, path, init, timeoutMs, meta);
    const readOnly = method === "GET" || method === "HEAD";
    let businessDispatched = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let config = cachedConfig;
      // Read/status polling uses the already proof-verified in-memory session.
      // Re-proving before every poll creates a false availability dependency on
      // a short control timeout. Mutating requests still prove immediately;
      // any 401 response below forces a fresh bootstrap before one safe replay.
      try {
        let proof = null;
        if (!config || (!readOnly && !(proof = await verifyServerProof(config.actualPort, config.credential, 900)))) {
          invalidateCachedConfig();
          config = await bootstrap(true);
        } else if (proof) {
          config.serverNonce = proof.serverNonce;
        }
      } catch (error) {
        // A failed proof/bootstrap has no business payload. Only this local
        // pre-dispatch fact can make a write retryable; a later connection
        // loss must never inherit it after fetch has already been called.
        if (!readOnly && !businessDispatched) error.notDispatched = true;
        throw error;
      }
      const headers = new Headers((init && init.headers) || {});
      headers.set("Authorization", `Bearer ${config.credential}`);
      let response;
      const requestUrl = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const networkAttempt = beginPngNetworkAttempt(requestUrl, method);
      try {
        businessDispatched = true;
        response = await fetchWithTimeout(
          requestUrl,
          { ...(init || {}), headers },
          timeoutMs || 5000,
        );
      } catch (cause) {
        invalidateCachedConfig();
        if (readOnly && attempt === 0) continue;
        // A disconnected GET can be repeated after discovery. Once a write
        // was sent, a lost response does not prove that the route did not run.
        // Its caller must reconcile the existing task/receipt, never resubmit.
        const error = transportError(
          readOnly ? "app-unavailable" : "request-outcome-unknown",
          readOnly
            ? "LuckyRay connection is unavailable"
            : "The request was sent but its result could not be confirmed",
        );
        await decorateTransportFailure(error, cause, networkAttempt);
        throw error;
      } finally {
        if (networkAttempt) pngNetworkAttempts.delete(networkAttempt);
      }
      if (!await isAuthenticationRejection(response)) {
        if (isolatedTarget && response.ok && method === "POST" && ["/api/media/transfers", "/api/material-libraries/media-receipt"].includes(path)) {
          const body = JSON.parse(init.body), payload = await response.clone().json().catch(() => null), value = payload?.ok === true && payload.data ? payload.data : payload;
          const transfer = path.endsWith("media-receipt") ? value?.state === "pending" ? value.transfer : null : value;
          if (value?.libraryId === body.libraryId && value.requestId === body.requestId && /^media-[a-f0-9]+-[a-f0-9]{16}$/i.test(transfer?.transferId || "")) isolatedTransfers.set(transfer.transferId, body.libraryId);
        }
        return response;
      }
      invalidateCachedConfig();
      if (attempt === 1) {
        throw transportError("bootstrap-rejected", "LuckyRay session must be refreshed");
      }
      // Authentication is rejected before the route adapter can dispatch, so
      // one fresh bootstrap and one replay cannot duplicate a business write.
    }
    throw transportError("bootstrap-rejected", "LuckyRay session must be refreshed");
  }

  const api = Object.freeze({
    bootstrap,
    verify,
    discover,
    discoverCandidates,
    openBinding,
    confirmBinding,
    fetch: authorizedFetch,
    resetSession,
    runtimeOrigin,
    diagnoseNative: nativeMessage,
  });
  global.LuckyRayLocalTransport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
