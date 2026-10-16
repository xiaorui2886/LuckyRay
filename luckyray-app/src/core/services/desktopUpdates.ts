/** Public release discovery only. Never downloads or executes an installer. */
export const DESKTOP_LINKS = Object.freeze({
  github: "https://github.com/xiaorui2886/LuckyRay",
  website: "https://luckyray.me/atelier/edition",
  support: "https://luckyray.me/atelier/edition/support",
  releases: "https://github.com/xiaorui2886/LuckyRay/releases",
});
const RELEASE_API = "https://api.github.com/repos/xiaorui2886/LuckyRay/releases";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parseVersion(value: string) {
  const match = SEMVER.exec(value);
  if (!match) throw new Error("invalid-version");
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split(".") ?? [];
  if (core.some((v) => !Number.isSafeInteger(v)) || pre.some((v) => /^0\d+$/.test(v))) throw new Error("invalid-version");
  return { core, pre };
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length === y.length ? (x > y ? 1 : -1) : (x.length > y.length ? 1 : -1);
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function isOfficialDesktopLink(url: string): boolean {
  return Object.values(DESKTOP_LINKS).some((allowed) => url === allowed)
    || /^https:\/\/github\.com\/xiaorui2886\/LuckyRay\/releases\/tag\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(url);
}
export type DesktopRelease = { version: string; url: string };
export type DesktopUpdateResult =
  | { status: "available" | "current"; release: DesktopRelease }
  | { status: "error"; reason: "network" | "invalid" | "unavailable" | "response-limit" };
export function selectDesktopRelease(input: unknown): DesktopRelease | null {
  if (!Array.isArray(input)) throw new Error("invalid-response");
  let latest: DesktopRelease | null = null;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.draft !== false || r.prerelease !== false || typeof r.tag_name !== "string"
      || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(r.tag_name)) continue;
    const version = r.tag_name.slice(1);
    parseVersion(version);
    const url = `${DESKTOP_LINKS.releases}/tag/${r.tag_name}`;
    const name = `LuckyRay_${version}_x64-setup.exe`;
    if (r.html_url !== url || !Array.isArray(r.assets) || !r.assets.some((a: unknown) => {
      if (!a || typeof a !== "object") return false;
      const asset = a as Record<string, unknown>;
      return asset.name === name && asset.state === "uploaded" && typeof asset.size === "number" && asset.size > 0
        && asset.browser_download_url === `${DESKTOP_LINKS.releases}/download/${r.tag_name}/${name}`;
    })) continue;
    if (!latest || compareVersions(version, latest.version) > 0) latest = { version, url };
  }
  return latest;
}
const MAX_RELEASE_PAGE_BYTES = 2 * 1024 * 1024;
class ReleaseResponseLimitError extends Error {}
async function readReleasePage(response: Response, signal: AbortSignal): Promise<unknown[]> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RELEASE_PAGE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ReleaseResponseLimitError();
  }
  if (!response.body) throw new Error("missing-response-body");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  const parts: string[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RELEASE_PAGE_BYTES) {
        abort();
        throw new ReleaseResponseLimitError();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    const batch: unknown = JSON.parse(parts.join(""));
    if (!Array.isArray(batch)) throw new Error("invalid-response");
    if (batch.length > 100) throw new ReleaseResponseLimitError();
    return batch;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** One in-flight request; cache both errors and success to bound rapid retries. */
export function createDesktopUpdateChecker(fetcher: typeof fetch = fetch, now = Date.now, timeoutMs = 12000) {
  let pending: Promise<DesktopUpdateResult> | null = null;
  let cached: { version: string; until: number; result: DesktopUpdateResult } | null = null;
  return (currentVersion: string): Promise<DesktopUpdateResult> => {
    if (pending) return pending;
    if (cached?.version === currentVersion && cached.until > now()) return Promise.resolve(cached.result);
    pending = (async (): Promise<DesktopUpdateResult> => {
      try { parseVersion(currentVersion); } catch { return { status: "error", reason: "invalid" }; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const releases: unknown[] = [];
        // Bounded complete scan. Do not claim latest if the scan is truncated.
        for (let page = 1; page <= 3; page++) {
          const response = await fetcher(`${RELEASE_API}?per_page=100&page=${page}`, {
            signal: controller.signal, credentials: "omit", redirect: "error",
            headers: { Accept: "application/vnd.github+json" },
          });
          if (!response.ok) throw new Error("release-request-failed");
          const batch = await readReleasePage(response, controller.signal);
          releases.push(...batch);
          if (batch.length < 100) {
            const release = selectDesktopRelease(releases);
            if (!release) return { status: "error", reason: "unavailable" };
            return { status: compareVersions(release.version, currentVersion) > 0 ? "available" : "current", release };
          }
        }
        return { status: "error", reason: "unavailable" };
      } catch (error) {
        controller.abort();
        return { status: "error", reason: error instanceof ReleaseResponseLimitError ? "response-limit" : "network" };
      }
      finally { clearTimeout(timer); }
    })().then((result) => {
      cached = { version: currentVersion, until: now() + 60_000, result };
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
}
export const checkDesktopUpdates = createDesktopUpdateChecker();

/** Small session snapshot: settings may unmount, but discovery and preferences survive. */
export function createDesktopUpdateSession(
  checker = checkDesktopUpdates,
  storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage,
  now = Date.now,
) {
  const memory = new Map<string, string>();
  let latest: { version: string; result: DesktopUpdateResult } | null = null;
  let pending: { version: string; promise: Promise<DesktopUpdateResult> } | null = null;
  function read(key: string) {
    if (memory.has(key)) return memory.get(key)!;
    try { const value = storage().getItem(key); if (value !== null) memory.set(key, value); return value; }
    catch { return null; }
  }
  function write(key: string, value: string) {
    memory.set(key, value);
    try { storage().setItem(key, value); } catch { /* Keep this session's choice. */ }
  }
  const automaticKey = "luckyray-desktop-updates-auto-v1";
  const lastKey = "luckyray-desktop-updates-last-v1";
  const dismissedKey = "luckyray-desktop-updates-dismissed-v1";
  function check(version: string) {
    if (pending?.version === version) return pending.promise;
    const promise = checker(version).then((result) => { latest = { version, result }; return result; })
      .finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { version, promise };
    return promise;
  }
  return {
    result: (version: string) => latest?.version === version ? latest.result : null,
    pending: (version: string) => pending?.version === version ? pending.promise : null,
    automatic: () => read(automaticKey) !== "false",
    setAutomatic: (value: boolean) => write(automaticKey, String(value)),
    dismissed: () => read(dismissedKey),
    dismiss: (version: string) => write(dismissedKey, version),
    check,
    checkAutomatically(version: string) {
      if (read(automaticKey) === "false") return null;
      if (pending?.version === version) return pending.promise;
      const last = Number(read(lastKey)) || 0, time = now();
      if (last > 0 && time >= last && time - last < 86_400_000) return null;
      write(lastKey, String(time));
      return check(version);
    },
  };
}
export const desktopUpdateSession = createDesktopUpdateSession();
