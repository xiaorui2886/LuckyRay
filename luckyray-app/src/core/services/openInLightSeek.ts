export type OpenInLightSeekSource = "materials" | "notes" | "collection" | "graph" | "search";

export type OpenInLightSeekLocalResource = Readonly<{
  kind: "material";
  assetId: string;
  libraryId?: string;
  canonicalPath: string;
  delivery: "image-attachment" | "path-reference";
}>;

export type OpenInLightSeekRequest = {
  source: OpenInLightSeekSource;
  text: string;
  localResources?: readonly OpenInLightSeekLocalResource[];
};

export type OpenInLightSeekIntent = Readonly<{
  intentId: string;
  /** A previous attempt may already have entered the official composer. */
  recoveryOnly: boolean;
  source: OpenInLightSeekSource;
  text: string;
  localResources: readonly OpenInLightSeekLocalResource[];
}>;

type Listener = () => void;

const MAX_INTENT_TEXT_BYTES = 12 * 1024;
const MAX_LOCAL_RESOURCES = 64;
const MAX_LOCAL_RESOURCE_PATH_BYTES = 4 * 1024;
const TRUNCATED_MARKER = "\n\n（内容已截断，请回到原页面查看完整内容。）";
const SOURCES = new Set<OpenInLightSeekSource>(["materials", "notes", "collection", "graph", "search"]);
const LOCAL_RESOURCE_SOURCES = new Set<OpenInLightSeekSource>(["materials", "notes", "collection"]);
const IMAGE_ATTACHMENT_SOURCES = new Set<OpenInLightSeekSource>(["materials", "notes"]);

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string) {
  if (utf8Length(value) <= MAX_INTENT_TEXT_BYTES) return value;
  const points = Array.from(value);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Length(`${points.slice(0, middle).join("")}${TRUNCATED_MARKER}`) <= MAX_INTENT_TEXT_BYTES) low = middle;
    else high = middle - 1;
  }
  return `${points.slice(0, low).join("").trimEnd()}${TRUNCATED_MARKER}`;
}

function redactLocalPaths(value: string) {
  return value
    .replace(/file:\/\/\/[^\s<>'"]+/giu, "[本地路径已省略]")
    .replace(/(^|[\s(（【：:])(?:[a-z]:[\\/]|\\\\)[^\r\n]*/gimu, "$1[本地路径已省略]")
    .replace(/(^|[\s(（【：:])\/(?!\/)[^\s<>'"]+/gmu, "$1[本地路径已省略]");
}

function isAbsoluteLocalPath(value: string) {
  return /^[a-z]:[\\/]/iu.test(value)
    || /^\\\\(?:\?\\)?[^\\/]+[\\/][^\\/]+/u.test(value)
    || value.startsWith("/");
}

function normalizeLocalResources(
  source: OpenInLightSeekSource,
  resources: readonly OpenInLightSeekLocalResource[] | undefined,
) {
  if (resources === undefined) return Object.freeze([]) as readonly OpenInLightSeekLocalResource[];
  if (!LOCAL_RESOURCE_SOURCES.has(source) || !Array.isArray(resources)
    || resources.length === 0 || resources.length > MAX_LOCAL_RESOURCES) {
    throw new Error("lightseek-open-intent-invalid");
  }
  return Object.freeze(resources.map((resource) => {
    const assetId = typeof resource?.assetId === "string" ? resource.assetId : "";
    const canonicalPath = typeof resource?.canonicalPath === "string" ? resource.canonicalPath : "";
    const delivery = resource?.delivery;
    const libraryId = resource?.libraryId;
    if (libraryId !== undefined && (typeof libraryId !== "string" || !libraryId || libraryId.length > 256
      || libraryId.trim() !== libraryId || /[\u0000-\u001f\u007f]/u.test(libraryId))) throw new Error("lightseek-open-intent-invalid");
    if (resource?.kind !== "material" || !assetId || assetId.length > 256 || assetId.trim() !== assetId
      || (delivery !== "image-attachment" && delivery !== "path-reference")
      || (delivery === "image-attachment" && !IMAGE_ATTACHMENT_SOURCES.has(source))
      || /[\u0000-\u001f\u007f]/u.test(assetId)
      || !canonicalPath || canonicalPath.trim() !== canonicalPath
      || utf8Length(canonicalPath) > MAX_LOCAL_RESOURCE_PATH_BYTES
      || /[\u0000-\u001f\u007f]/u.test(canonicalPath)
      || !isAbsoluteLocalPath(canonicalPath)) {
      throw new Error("lightseek-open-intent-invalid");
    }
    return Object.freeze({ kind: "material" as const, assetId, ...(libraryId === undefined ? {} : { libraryId }), canonicalPath, delivery });
  }));
}

function validateRequest(request: OpenInLightSeekRequest) {
  const rawText = typeof request?.text === "string" ? request.text.trim() : "";
  if (!SOURCES.has(request?.source)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rawText)) {
    throw new Error("lightseek-open-intent-invalid");
  }
  const localResources = normalizeLocalResources(request.source, request.localResources);
  if (!rawText && localResources.length === 0) throw new Error("lightseek-open-intent-invalid");
  return {
    source: request.source,
    text: rawText ? truncateUtf8(redactLocalPaths(rawText)) : "",
    localResources,
  };
}

export function createOpenInLightSeekCoordinator({
  navigate,
  createId,
}: {
  navigate: () => void;
  createId: () => string;
}) {
  let pending: OpenInLightSeekIntent | null = null;
  let settled: { intentId: string; delivered: boolean } | null = null;
  let retryCandidate: { intentId: string; requestKey: string } | null = null;
  const listeners = new Set<Listener>();
  const waiters = new Set<{ intentId: string; resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return Object.freeze({
    stage(request: OpenInLightSeekRequest) {
      if (pending) throw new Error("lightseek-open-intent-busy");
      const normalized = validateRequest(request);
      const requestKey = JSON.stringify(normalized);
      const recoveryOnly = retryCandidate?.requestKey === requestKey;
      const intentId = recoveryOnly && retryCandidate ? retryCandidate.intentId : createId();
      if (!/^intent-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(intentId) || intentId.length > 64) {
        throw new Error("lightseek-open-intent-invalid");
      }
      pending = Object.freeze({ intentId, recoveryOnly, ...normalized });
      retryCandidate = null;
      settled = null;
      try {
        navigate();
      } catch (error) {
        pending = null;
        throw error;
      }
      notify();
      return pending;
    },
    peek() {
      return pending;
    },
    uncertainIntentId() {
      return retryCandidate?.intentId ?? null;
    },
    complete(intentId: string) {
      if (pending?.intentId !== intentId) return false;
      pending = null;
      settled = { intentId, delivered: true };
      retryCandidate = null;
      for (const waiter of [...waiters]) {
        if (waiter.intentId !== intentId) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      return true;
    },
    fail(intentId: string, disposition: "not-staged" | "uncertain" = "uncertain") {
      if (pending?.intentId !== intentId) return false;
      retryCandidate = disposition === "uncertain" ? { intentId, requestKey: JSON.stringify({
        source: pending.source, text: pending.text, localResources: pending.localResources,
      }) } : null;
      pending = null;
      settled = { intentId, delivered: false };
      for (const waiter of [...waiters]) {
        if (waiter.intentId !== intentId) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("lightseek-open-intent-not-delivered"));
      }
      return true;
    },
    allowNewActionAfterReview(intentId: string) {
      if (pending || retryCandidate?.intentId !== intentId) return false;
      retryCandidate = null;
      return true;
    },
    wait(intentId: string) {
      if (settled?.intentId === intentId) {
        return settled.delivered ? Promise.resolve() : Promise.reject(new Error("lightseek-open-intent-not-delivered"));
      }
      if (pending?.intentId !== intentId) return Promise.reject(new Error("lightseek-open-intent-unavailable"));
      return new Promise<void>((resolve, reject) => {
        const waiter = { intentId, resolve, reject, timeout: setTimeout(() => {
          if (!waiters.delete(waiter)) return;
          if (pending?.intentId === intentId) {
            retryCandidate = { intentId, requestKey: JSON.stringify({
              source: pending.source, text: pending.text, localResources: pending.localResources,
            }) };
            pending = null;
            settled = { intentId, delivered: false };
            for (const other of [...waiters]) {
              if (other.intentId !== intentId) continue;
              waiters.delete(other);
              clearTimeout(other.timeout);
              other.reject(new Error("lightseek-open-intent-timeout"));
            }
          }
          reject(new Error("lightseek-open-intent-timeout"));
        }, 35_000) };
        waiters.add(waiter);
      });
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      if (pending) listener();
      return () => listeners.delete(listener);
    },
  });
}

const coordinator = createOpenInLightSeekCoordinator({
  navigate: () => { window.location.hash = "#ai"; },
  createId: () => `intent-${crypto.randomUUID()}`,
});

export function openInLightSeek(request: OpenInLightSeekRequest) {
  return coordinator.stage(request);
}

export function peekOpenInLightSeekIntent() {
  return coordinator.peek();
}

export function peekUncertainOpenInLightSeekIntentId() {
  return coordinator.uncertainIntentId();
}

export function completeOpenInLightSeekIntent(intentId: string) {
  return coordinator.complete(intentId);
}

export function failOpenInLightSeekIntent(intentId: string, disposition: "not-staged" | "uncertain" = "uncertain") {
  return coordinator.fail(intentId, disposition);
}

export function allowNewOpenInLightSeekActionAfterReview(intentId: string) {
  return coordinator.allowNewActionAfterReview(intentId);
}

export function waitForOpenInLightSeekIntent(intentId: string) {
  return coordinator.wait(intentId);
}

export function subscribeOpenInLightSeekIntent(listener: Listener) {
  return coordinator.subscribe(listener);
}
