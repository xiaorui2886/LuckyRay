import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createEmbeddedPersonalBrowserClient,
  createPersonalBrowserTabsState,
  createPersonalBrowserLifecycleCoordinator,
  createLatestBrowserStatusGate,
  createPersonalBrowserClient,
  normalizePersonalBrowserAddress,
  reducePersonalBrowserTabsState,
  type PersonalBrowserStatus,
  type PersonalBrowserViewport,
} from "../src/core/services/personalBrowser.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

const status = (generation = 0): PersonalBrowserStatus => ({
  sessionId: "personal-safe",
  status: "idle",
  origin: null,
  title: null,
  canGoBack: false,
  canGoForward: false,
  generation,
  controlMode: "user-only",
  agentAutomation: "unavailable",
  networkIsolation: "top-level-only",
  privateSubresourcePrevention: "not-guaranteed",
});

test("status contract is explicit about user-only control and top-level-only network isolation", () => {
  const value = status();
  assert.equal(value.controlMode, "user-only");
  assert.equal(value.agentAutomation, "unavailable");
  assert.equal(value.networkIsolation, "top-level-only");
  assert.equal(value.privateSubresourcePrevention, "not-guaranteed");
});

test("address normalization adds https and rejects unsafe schemes, credentials, and controls", () => {
  assert.equal(normalizePersonalBrowserAddress("example.com/path"), "https://example.com/path");
  for (const value of ["file:///secret", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/\u0000private", ""]) {
    assert.throws(() => normalizePersonalBrowserAddress(value), /browser-navigation-invalid/);
  }
});

test("production client emits one typed broker command with session and generation", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const client = createPersonalBrowserClient(async (command, args) => {
    calls.push([command, args]);
    return { ...status(2), status: "loading" };
  });
  await client.navigate(status(1), "example.com");
  assert.deepEqual(calls, [["browser_personal_navigate", {
    sessionId: "personal-safe",
    expectedGeneration: 1,
    url: "https://example.com/",
  }]]);
});

test("embedded browser open and viewport updates stay on the typed broker boundary", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const viewport: PersonalBrowserViewport = {
    x: 900,
    y: 140,
    width: 480,
    height: 620,
    visible: true,
  };
  const client = createEmbeddedPersonalBrowserClient(
    () => viewport,
    async (command, args) => {
      calls.push([command, args]);
      return status(3);
    },
  );

  await client.open();
  await client.setViewport(status(2), { ...viewport, width: 520, visible: false });

  assert.deepEqual(calls, [
    ["browser_personal_open", { viewport }],
    ["browser_personal_set_viewport", {
      sessionId: "personal-safe",
      expectedGeneration: 2,
      viewport: { ...viewport, width: 520, visible: false },
    }],
  ]);
});

test("browser tabs select new pages and close the active page without losing its neighbor", () => {
  const initial = createPersonalBrowserTabsState("tab-1");
  const second = reducePersonalBrowserTabsState(initial, { type: "add", id: "tab-2" });
  const third = reducePersonalBrowserTabsState(second, { type: "add", id: "tab-3" });
  assert.deepEqual(third, { ids: ["tab-1", "tab-2", "tab-3"], activeId: "tab-3" });

  const selected = reducePersonalBrowserTabsState(third, { type: "select", id: "tab-2" });
  const closed = reducePersonalBrowserTabsState(selected, { type: "close", id: "tab-2" });
  assert.deepEqual(closed, { ids: ["tab-1", "tab-3"], activeId: "tab-1" });

  const sole = createPersonalBrowserTabsState("only-tab");
  assert.deepEqual(
    reducePersonalBrowserTabsState(sole, {
      type: "close",
      id: "only-tab",
      replacementId: "fresh-tab",
    }),
    { ids: ["fresh-tab"], activeId: "fresh-tab" },
  );
});

test("latest-only gate prevents stale responses and all post-dispose publication", () => {
  const published: number[] = [];
  const gate = createLatestBrowserStatusGate((value) => published.push(value.generation));
  const first = gate.begin();
  const second = gate.begin();
  gate.publish(first, status(1));
  gate.publish(second, status(2));
  gate.dispose();
  gate.publish(second, status(3));
  assert.deepEqual(published, [2]);
});

test("a released sole owner closes a session that resolves after open was pending", async () => {
  const opening = deferred<PersonalBrowserStatus>();
  const closed: PersonalBrowserStatus[] = [];
  const coordinator = createPersonalBrowserLifecycleCoordinator({
    open: () => opening.promise,
    close: async (current) => {
      closed.push(current);
      return { ...current, status: "closed" };
    },
  });

  const owner = coordinator.acquire({
    onStatus: () => assert.fail("released owner must not receive the late status"),
    onError: () => assert.fail("released owner must not receive an error"),
  });
  owner.release();
  opening.resolve(status(1));
  await flushAsync();

  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.sessionId, "personal-safe");
});

test("a replacement owner adopts the pending session and is the only owner that closes it", async () => {
  const opening = deferred<PersonalBrowserStatus>();
  const closed: PersonalBrowserStatus[] = [];
  const publishedA: number[] = [];
  const publishedB: number[] = [];
  const coordinator = createPersonalBrowserLifecycleCoordinator({
    open: () => opening.promise,
    close: async (current) => {
      closed.push(current);
      return { ...current, status: "closed" };
    },
  });

  const ownerA = coordinator.acquire({
    onStatus: (next) => publishedA.push(next.generation),
    onError: () => assert.fail("owner A must not receive an error"),
  });
  ownerA.release();
  const ownerB = coordinator.acquire({
    onStatus: (next) => publishedB.push(next.generation),
    onError: () => assert.fail("owner B must not receive an error"),
  });
  opening.resolve(status(2));
  await flushAsync();

  assert.deepEqual(publishedA, []);
  assert.deepEqual(publishedB, [2]);
  assert.equal(closed.length, 0);
  ownerB.release();
  await flushAsync();
  assert.equal(closed.length, 1);
});

test("an open rejection releases pending state so a later mount can retry", async () => {
  const attempts = [deferred<PersonalBrowserStatus>(), deferred<PersonalBrowserStatus>()];
  const errors: string[] = [];
  const published: number[] = [];
  let openCalls = 0;
  let closeCalls = 0;
  const coordinator = createPersonalBrowserLifecycleCoordinator({
    open: () => attempts[openCalls++]!.promise,
    close: async (current) => {
      closeCalls += 1;
      return { ...current, status: "closed" };
    },
  });

  const failedOwner = coordinator.acquire({
    onStatus: () => assert.fail("the failed owner must not receive status"),
    onError: (reason) => errors.push(String(reason)),
  });
  attempts[0]!.reject(new Error("browser-host-unavailable"));
  await flushAsync();
  assert.deepEqual(errors, ["Error: browser-host-unavailable"]);
  failedOwner.release();

  const retryOwner = coordinator.acquire({
    onStatus: (next) => published.push(next.generation),
    onError: () => assert.fail("retry must succeed"),
  });
  attempts[1]!.resolve(status(3));
  await flushAsync();
  assert.equal(openCalls, 2);
  assert.deepEqual(published, [3]);
  retryOwner.release();
  await flushAsync();
  assert.equal(closeCalls, 1);
});

test("a released owner cannot publish a late command result over the latest owner", async () => {
  const publishedA: number[] = [];
  const publishedB: number[] = [];
  let closeCalls = 0;
  const coordinator = createPersonalBrowserLifecycleCoordinator({
    open: async () => status(1),
    close: async (current) => {
      closeCalls += 1;
      return { ...current, status: "closed" };
    },
  });
  const ownerA = coordinator.acquire({
    onStatus: (next) => publishedA.push(next.generation),
    onError: () => assert.fail("owner A must not fail"),
  });
  await flushAsync();
  ownerA.release();
  const ownerB = coordinator.acquire({
    onStatus: (next) => publishedB.push(next.generation),
    onError: () => assert.fail("owner B must not fail"),
  });

  assert.equal(ownerA.publish(status(9)), false);
  assert.equal(ownerB.publish(status(2)), true);
  assert.deepEqual(publishedA, [1]);
  assert.deepEqual(publishedB, [1, 2]);
  assert.equal(closeCalls, 0);
  ownerB.release();
  await flushAsync();
  assert.equal(closeCalls, 1);
});

test("StrictMode mount cleanup remount shares one open and closes after the final owner", async () => {
  const published: number[] = [];
  let openCalls = 0;
  let closeCalls = 0;
  const coordinator = createPersonalBrowserLifecycleCoordinator({
    open: async () => {
      openCalls += 1;
      return status(4);
    },
    close: async (current) => {
      closeCalls += 1;
      return { ...current, status: "closed" };
    },
  });
  const observer = {
    onStatus: (next: PersonalBrowserStatus) => published.push(next.generation),
    onError: () => assert.fail("StrictMode remount must not fail"),
  };

  const firstMount = coordinator.acquire(observer);
  firstMount.release();
  const secondMount = coordinator.acquire(observer);
  await flushAsync();
  assert.equal(openCalls, 1);
  assert.equal(closeCalls, 0);
  assert.deepEqual(published, [4]);

  secondMount.release();
  await flushAsync();
  assert.equal(closeCalls, 1);
});

test("the AI route reuses the embedded personal browser as one fixed LuckyRay-owned sidebar", async () => {
  const [page, shell, titlebar, shellCss, browserPage, browserCss] = await Promise.all([
    readFile(new URL("../src/features/ai/DshNativeSurfacePage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/AppSidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/appShell.css", import.meta.url), "utf8"),
    readFile(new URL("../src/features/browser/BrowserPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/browser/browser.css", import.meta.url), "utf8"),
  ]);

  assert.match(shell, /const \[aiPersonalBrowserOpen, setAiPersonalBrowserOpen\] = useState\(false\)/u);
  assert.match(shell, /if \(route !== "ai"\) closeAiPersonalBrowser\(\)/u);
  assert.match(shell, /<DshNativeSurfacePage[\s\S]*personalBrowserOpen=\{aiPersonalBrowserOpen\}[\s\S]*nativeSurfacesVisible=\{nativeSurfacesVisible\}/u);
  assert.match(titlebar, /route === "ai" && onToggleAiPersonalBrowser/u);
  assert.match(titlebar, /aria-pressed=\{aiPersonalBrowserOpen\}/u);
  assert.match(titlebar, /aria-label=\{aiPersonalBrowserOpen \? t\("titlebar\.ai\.closeBrowser"\) : t\("titlebar\.ai\.openBrowser"\)\}/u);
  assert.match(titlebar, /title=\{aiPersonalBrowserOpen \? t\("titlebar\.ai\.closeBrowser"\) : t\("titlebar\.ai\.openBrowser"\)\}/u);
  assert.doesNotMatch(titlebar, /<span>\{aiPersonalBrowserOpen \? "关闭浏览器" : "个人浏览器"\}<\/span>/u);
  assert.match(page, /<div className="dsh-native-surface-layout">/u);
  assert.match(page, /\{personalBrowserOpen \? \([\s\S]*<BrowserPage embedded visible=\{nativeSurfacesVisible\} \/>[\s\S]*\) : null\}/u);
  assert.doesNotMatch(page, /setTimeout|setInterval|requestAnimationFrame|AgentBrowserRuntime/u);

  const toggleRule = shellCss.match(/\.react-nav-shell \.titlebar-ai-browser\s*\{([^}]*)\}/u)?.[1] || "";
  assert.match(toggleRule, /width:\s*32px/u);
  assert.match(toggleRule, /height:\s*32px/u);
  assert.match(toggleRule, /justify-content:\s*center/u);
  assert.match(toggleRule, /padding:\s*0/u);

  const sidebarRule = shellCss.match(/\.react-nav-shell \.ai-personal-browser-sidebar\s*\{([^}]*)\}/u)?.[1] || "";
  assert.match(sidebarRule, /width:\s*420px/u);
  assert.match(sidebarRule, /min-width:\s*420px/u);
  assert.match(sidebarRule, /flex:\s*0 0 420px/u);
  assert.doesNotMatch(sidebarRule, /transition|animation|resize/u);
  assert.match(shellCss, /\.dsh-native-surface-mount\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-width:\s*0;/u);

  assert.match(browserPage, /if \(!embedded\)/u, "the complete Browser route remains available");
  assert.match(browserPage, /createEmbeddedPersonalBrowserClient/u);
  assert.match(browserPage, /createPersonalBrowserLifecycleCoordinator/u);
  assert.match(browserCss, /var\(--bg-base\)|var\(--bg-surface\)/u);
  assert.match(browserCss, /var\(--text-primary\)/u);
  assert.match(browserCss, /var\(--text-secondary\)/u);
  assert.match(browserCss, /var\(--border\)/u);
  assert.match(browserCss, /var\(--accent\)/u);
  assert.match(browserCss, /var\(--accent-hover\)/u);
  assert.match(browserCss, /var\(--accent-muted\)/u);
  assert.match(browserCss, /:focus-visible/u);
  assert.match(browserCss, /button:disabled/u);
  assert.match(browserCss, /status-loading/u);
  assert.match(browserCss, /browser-error/u);
  assert.doesNotMatch(browserCss, /#c8a96a|#bda25d|#4f4632|rgba\(208,\s*169,\s*73/u);
});
