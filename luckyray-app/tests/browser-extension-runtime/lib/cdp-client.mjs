// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
//
// Zero-dependency by design (Issue #13 §3: package.json may only gain the
// test entry — production dependencies must not change). Only the domains the
// S1 fixture needs are implemented: Target, Runtime, ServiceWorker, Browser.
//
// The fixture drives a REAL Edge/Chrome binary with a fresh temp profile; the
// extension runs as an unpacked MV3 build. Nothing here mocks Chromium.

const WS_OPEN_TIMEOUT_MS = 15_000;
const CDP_SEND_TIMEOUT_MS = 30_000;

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_) {
        return;
      }
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(
            `CDP ${message.error.code || "error"} (${waiter.method}): ${message.error.message || message.error}`,
          ));
        } else {
          waiter.resolve(message.result || {});
        }
        return;
      }
      const method = String(message.method || "");
      const listeners = this.listeners.get(method);
      if (listeners) {
        for (const listener of Array.from(listeners)) {
          try {
            listener(message.params || {});
          } catch (_) {
            // A failing observer must not kill the socket loop.
          }
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP WebSocket connect timeout: ${wsUrl}`));
      }, WS_OPEN_TIMEOUT_MS);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(`CDP WebSocket connect failed: ${event?.message || "unknown error"}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CDP_SEND_TIMEOUT_MS}ms (browser unresponsive?)`));
      }, CDP_SEND_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.off(method, listener);
  }

  off(method, listener) {
    this.listeners.get(method)?.delete(listener);
  }

  async close() {
    try {
      this.ws.close();
    } catch (_) {
      // Ignore close failures; the process may already be shutting down.
    }
  }
}

// Attach to a target (flattened session) and cache the session id per target.
export async function attachSession(connection, targetId) {
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  if (!sessionId) throw new Error(`CDP attach produced no session for target ${targetId}`);
  return sessionId;
}

// Evaluate an expression in a target context and return the by-value result.
// Expressions are wrapped so a thrown promise rejection becomes a CDP error.
export async function evaluate(connection, sessionId, expression, options = {}) {
  const { result, exceptionDetails } = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: true,
    timeout: options.timeoutMs || 60_000,
  }, sessionId);
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description
      || exceptionDetails.exception?.value
      || exceptionDetails.text
      || "unknown evaluation error";
    throw new Error(`evaluate failed: ${text}`);
  }
  return result?.value;
}

export async function getTargets(connection) {
  const { targetInfos } = await connection.send("Target.getTargets");
  return targetInfos || [];
}
