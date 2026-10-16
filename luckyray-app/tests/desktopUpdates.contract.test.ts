import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDesktopUpdateSession, compareVersions, selectDesktopRelease, createDesktopUpdateChecker, isOfficialDesktopLink, DESKTOP_LINKS } from "../src/core/services/desktopUpdates.ts";

function release(version = "1.9.5", overrides = {}) {
  const tag = `v${version}`, name = `LuckyRay_${version}_x64-setup.exe`;
  return { draft: false, prerelease: false, tag_name: tag,
    html_url: `${DESKTOP_LINKS.releases}/tag/${tag}`,
    assets: [{ name, state: "uploaded", size: 100,
      browser_download_url: `${DESKTOP_LINKS.releases}/download/${tag}/${name}` }], ...overrides };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fetcher = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>) => fn as typeof fetch;

test("numeric semver precedence never lexically downgrades", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareVersions("1.9.5+build.1", "1.9.5+build.2"), 0);
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < order.length; i++) assert.equal(compareVersions(order[i - 1], order[i]), -1);
  for (const invalid of ["1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3junk", "9007199254740992.0.0"]) assert.throws(() => compareVersions(invalid, "1.0.0"));
});
test("only exact stable desktop tag and uploaded Windows x64 installer qualify", () => {
  const bad = [release("99.0.0", { draft: true }), release("98.0.0", { prerelease: true }),
    release("97.0.0", { tag_name: "sdk-v97.0.0" }), release("96.0.0", { tag_name: "collector-v96.0.0" }),
    release("95.0.0-beta"), release("94.0.0", { assets: [] }), release("93.0.0", { html_url: "https://evil.invalid/" }),
    release("92.0.0", { assets: [{ ...release("92.0.0").assets[0], name: "LuckyRay_92.0.0_arm64-setup.exe" }] }),
    release("91.0.0", { assets: [{ ...release("91.0.0").assets[0], browser_download_url: "https://evil.invalid/setup.exe" }] }),
    release("90.0.0", { assets: [{ ...release("90.0.0").assets[0], size: 0 }] }),
    release("89.0.0", { assets: [{ ...release("89.0.0").assets[0], state: "new" }] }), null, {}];
  assert.equal(selectDesktopRelease(bad), null);
  assert.equal(selectDesktopRelease([...bad, release("1.9.5"), release("1.10.0"), release("1.9.9")])?.version, "1.10.0");
  assert.throws(() => selectDesktopRelease({}));
});
test("external links are exact official targets, never API-provided arbitrary URLs", () => {
  for (const url of Object.values(DESKTOP_LINKS)) assert.equal(isOfficialDesktopLink(url), true);
  assert.equal(isOfficialDesktopLink(`${DESKTOP_LINKS.releases}/tag/v1.10.0`), true);
  for (const url of ["javascript:alert(1)", "file:///C:/setup.exe", "https://github.com.evil.invalid/x", `${DESKTOP_LINKS.github}?redirect=evil`, `${DESKTOP_LINKS.releases}/tag/v1.2.3#x`, "https://luckyray.me/atelier/edition/support/../secret"]) assert.equal(isOfficialDesktopLink(url), false);
});
test("higher release available; equal or older stable is not an update", async () => {
  for (const [installed, expected] of [["1.9.4", "available"], ["1.9.5", "current"], ["1.10.0", "current"]]) {
    const check = createDesktopUpdateChecker(fetcher(async () => response([release()])));
    assert.equal((await check(installed)).status, expected);
  }
});
test("double clicks share one request; success/error cool down for one minute", async () => {
  let calls = 0, now = 1000;
  let resolve!: (r: Response) => void;
  const check = createDesktopUpdateChecker(fetcher(() => { calls++; return new Promise((r) => { resolve = r; }); }), () => now);
  const a = check("1.9.4"), b = check("1.9.4");
  assert.equal(a, b); assert.equal(calls, 1);
  resolve(response([release()])); await a;
  await check("1.9.4"); assert.equal(calls, 1);
  now += 60_001;
  const c = check("1.9.4"); assert.equal(calls, 2); resolve(response([], 403));
  assert.equal((await c).status, "error"); await check("1.9.4"); assert.equal(calls, 2);
});
test("offline, invalid JSON, rate limit, server failure and no compatible release never say current", async () => {
  for (const fn of [async () => { throw new TypeError("offline"); }, async () => new Response("invalid"), async () => response([], 403), async () => response([], 500), async () => response({}), async () => response([])]) {
    assert.equal((await createDesktopUpdateChecker(fetcher(fn))("1.9.4")).status, "error");
  }
  let calls = 0;
  assert.equal((await createDesktopUpdateChecker(fetcher(async () => { calls++; return response([]); }))("not-a-version")).status, "error");
  assert.equal(calls, 0);
});
test("timeout aborts the request and permits a later retry", async () => {
  let calls = 0, now = 0;
  const check = createDesktopUpdateChecker(fetcher(async (_url, options) => {
    calls++;
    if (calls > 1) return response([release()]);
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }), () => now, 5);
  assert.equal((await check("1.9.4")).status, "error");
  now = 61_000; assert.equal((await check("1.9.4")).status, "available");
});
test("bounded pagination searches past SDK releases and refuses truncated conclusions", async () => {
  const urls: string[] = [];
  const check = createDesktopUpdateChecker(fetcher(async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.credentials, "omit"); assert.equal(options?.redirect, "error");
    return response(urls.length === 1 ? Array.from({ length: 100 }, () => release("9.0.0", { tag_name: "sdk-v9.0.0" })) : [release()]);
  }));
  assert.equal((await check("1.9.4")).status, "available"); assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("https://api.github.com/repos/xiaorui2886/LuckyRay/releases?per_page=100&page=")));
  let calls = 0;
  const incomplete = createDesktopUpdateChecker(fetcher(async () => { calls++; return response(Array.from({ length: 100 }, () => release())); }));
  assert.equal((await incomplete("1.9.4")).status, "error"); assert.equal(calls, 3);
});
test("settings retains bridge URL guard, opt-out/dismiss and manual-install disclosure in both languages", async () => {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [page, card, zh, en] = await Promise.all([read("src/features/settings/SettingsPage.tsx"), read("src/features/settings/DesktopUpdateCard.tsx"), read("src/core/i18n/settingsMessages.ts"), read("src/core/i18n/settingsMessages.en.ts")]);
  assert.match(page, /!isOfficialDesktopLink\(url\)/); assert.match(page, /bridge\.openExternalUrl\(url\)/);
  assert.match(card, /if \(desktopUpdateSession.pending\(version\)\) return/);
  assert.match(card, /if \(!active \|\| !automatic \|\| nativeStatus\?\.phase!=="disabled"\) return/);
  assert.match(card, /desktopUpdateSession.dismiss\(result.release.version\)/);
  assert.match(zh, /应用内安装尚未启用/); assert.match(en, /In-app installation is not enabled/);
  assert.match(card, /!nativeEnabled && <p[^>]*>\{t\("settings.update.manualInstall"\)\}/);
  assert.match(card, /<DesktopInstallPanel active=\{active\}/);
  assert.doesNotMatch(card, /relaunch|\.install\(|downloadAndInstall/);
});

test("session restores an undismissed result across card remount without another daily request", async () => {
  let calls = 0, now = 1000;
  const session = createDesktopUpdateSession(async () => { calls++; return { status: "available", release: { version: "1.9.5", url: `${DESKTOP_LINKS.releases}/tag/v1.9.5` } }; }, () => { throw new Error("storage blocked"); }, () => now);
  await session.checkAutomatically("1.9.4");
  assert.equal(session.result("1.9.4")?.status, "available");
  assert.equal(session.dismissed(), null);
  assert.equal(session.checkAutomatically("1.9.4"), null);
  assert.equal(calls, 1);
  session.dismiss("1.9.5"); assert.equal(session.dismissed(), "1.9.5");
  assert.equal(session.result("1.9.4")?.status, "available");
  assert.equal(session.result("1.9.3"), null);
  session.dismiss(""); assert.equal(session.dismissed(), "");
  now += 86_400_001; await session.checkAutomatically("1.9.4"); assert.equal(calls, 2);
});
test("remounted card rejoins the in-flight session task and retains its outcome after unmount", async () => {
  let resolve!: (result: { status: "error"; reason: "network" }) => void;
  let calls = 0;
  const session = createDesktopUpdateSession(() => { calls++; return new Promise((r) => { resolve = r; }); }, () => { throw new Error("storage blocked"); }, () => 1000);
  const first = session.checkAutomatically("1.9.4");
  assert.ok(first);
  assert.equal(session.pending("1.9.4"), first);
  assert.equal(session.checkAutomatically("1.9.4"), first);
  assert.equal(session.check("1.9.4"), first);
  resolve({ status: "error", reason: "network" }); await first;
  assert.deepEqual(session.result("1.9.4"), { status: "error", reason: "network" });
  assert.equal(session.pending("1.9.4"), null); assert.equal(calls, 1);
});
test("session keeps auto-check opt-out and dismissal when reads or writes are unavailable", () => {
  for (const storage of [() => { throw new Error("blocked"); }, () => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } })]) {
    let calls = 0;
    const session = createDesktopUpdateSession(async () => { calls++; return { status: "error", reason: "network" }; }, storage, () => 1000);
    session.setAutomatic(false); session.dismiss("1.9.5");
    assert.equal(session.automatic(), false); assert.equal(session.dismissed(), "1.9.5");
    assert.equal(session.checkAutomatically("1.9.4"), null); assert.equal(calls, 0);
    session.setAutomatic(true); assert.equal(session.automatic(), true);
  }
});
test("streamed bytes, declared bytes and page count overflows return response-limit errors", async () => {
  for (const makeResponse of [
    () => new Response("[]", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    () => response(Array.from({ length: 101 }, () => release())),
    () => {
      let chunks = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (chunks++ < 3) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        else controller.close();
      } }));
    },
  ]) {
    const result = await createDesktopUpdateChecker(fetcher(async () => makeResponse()))("1.9.4");
    assert.deepEqual(result, { status: "error", reason: "response-limit" });
  }
});
test("byte budget cancels the oversized stream before reading the rest", async () => {
  let cancelled = false, reads = 0;
  const result = await createDesktopUpdateChecker(fetcher(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }))))("1.9.4");
  assert.equal(result.status, "error"); assert.equal(cancelled, true); assert.ok(reads <= 4);
});
test("timeout cancels a stalled response body rather than waiting indefinitely", async () => {
  let cancelled = false;
  const result = await createDesktopUpdateChecker(fetcher(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))), Date.now, 5)("1.9.4");
  assert.deepEqual(result, { status: "error", reason: "network" }); assert.equal(cancelled, true);
});
test("About opens browser synchronously even when a non-native bridge exists; native stays on bridge", async () => {
  const source = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  const body = source.match(/const handleAboutLink = useCallback\(async \(label: string, url\?: string\) => \{([\s\S]*?)\n  \}, \[showStatus, t\]\);/)?.[1];
  assert.ok(body);
  let browserCalls = 0, bridgeCalls = 0;
  const statuses: string[] = [];
  const create = new Function("isTauri", "getBridge", "window", "showStatus", "t", "isOfficialDesktopLink", `return async (label, url) => {${body}};`);
  const deps = [() => ({ openExternalUrl: async () => { bridgeCalls++; } }), { open: (url: string, target: string, features: string) => {
    browserCalls++; assert.equal(url, DESKTOP_LINKS.support); assert.equal(target, "_blank"); assert.equal(features, "noopener,noreferrer"); return null;
  } }, (message: string) => statuses.push(message), (key: string) => key, isOfficialDesktopLink];
  const browser = create(() => false, ...deps);
  const pending = browser("Support", DESKTOP_LINKS.support);
  assert.equal(browserCalls, 1); assert.equal(bridgeCalls, 0); await pending;
  assert.equal(statuses.at(-1), "settings.status.browserLinkRequested");
  const native = create(() => true, ...deps); await native("Support", DESKTOP_LINKS.support);
  assert.equal(bridgeCalls, 1); assert.equal(browserCalls, 1);
  await browser("Bad", "javascript:alert(1)"); await native("Bad", "https://evil.invalid");
  assert.equal(browserCalls, 1); assert.equal(bridgeCalls, 1);
});
