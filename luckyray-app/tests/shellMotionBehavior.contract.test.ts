import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((candidate): candidate is string => Boolean(candidate));

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "CDP request failed"));
      else request.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true });
    });
    return new CdpClient(socket);
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDebugPort(profileDir: string): Promise<number> {
  const activePortPath = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/u);
      const parsedPort = Number(port);
      if (Number.isFinite(parsedPort) && parsedPort > 0) return parsedPort;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOENT") throw error;
    }
    await wait(25);
  }
  throw new Error("Headless browser did not expose a DevTools port");
}

async function waitForDocument(page: CdpClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await page.send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (response.result.value === "complete") return;
    await wait(20);
  }
  throw new Error("Shell fixture did not finish loading");
}

async function evaluate<T>(page: CdpClient, expression: string): Promise<T> {
  const response = await page.send<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(response.result.description || "Fixture evaluation failed");
  return response.result.value as T;
}

async function withShellFixture(run: (page: CdpClient) => Promise<void>): Promise<void> {
  const browserExecutable = CHROME_CANDIDATES.find(existsSync);
  assert.ok(browserExecutable, "A local Chromium browser is required for shell motion contracts");

  const tempRoot = await mkdtemp(join(process.cwd(), ".shell-motion-"));
  const profileDir = join(tempRoot, "profile");
  const fixturePath = join(tempRoot, "shell-motion.html");
  let browser: ChildProcess | null = null;
  let page: CdpClient | null = null;

  try {
    await mkdir(profileDir);
    const shellCss = await readFile(new URL("../src/app/appShell.css", import.meta.url), "utf8");
    await writeFile(fixturePath, `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root {
  --theme-sidebar-bg: rgb(18, 18, 20); --theme-app-bg: rgb(8, 8, 10);
  --theme-titlebar-bg: rgb(8, 8, 10); --theme-border-strong: rgb(45, 45, 50);
  --theme-border-subtle: rgb(36, 36, 40); --theme-surface-base: rgb(12, 12, 14);
  --theme-surface-panel: rgb(18, 18, 20); --theme-surface-raised: rgb(28, 28, 32);
  --theme-hover: rgb(34, 34, 38); --theme-selected: rgb(40, 40, 46);
  --theme-text-muted: rgb(140, 140, 150); --text-primary: rgb(240, 240, 244);
  --text-secondary: rgb(180, 180, 190); --accent: rgb(124, 138, 255);
  --accent-muted: rgba(124, 138, 255, .16);
}
html, body { margin: 0; width: 100%; height: 100%; }
${shellCss}
</style></head><body>
<div class="react-nav-shell" data-sidebar-motion="manual">
  <aside class="sidebar">
    <div class="sidebar-header"><div class="logo-mark"></div><span class="logo-text">luckyray</span></div>
    <nav class="sidebar-nav">
      <div class="nav-section"><div class="nav-section-title">Space</div><div class="nav-item"><span class="nav-icon"></span><span class="nav-label">Materials</span></div></div>
      <div class="nav-section"><div class="nav-section-title">Filters</div><div class="nav-item"><span class="nav-icon"></span><span class="nav-label">Tags</span></div></div>
      <div class="nav-section" id="folder-section">
        <div class="nav-section-title"><span id="folder-section-label">Material folders</span><button class="folder-section-add-btn"></button></div>
        <div id="folder-list"><div class="folder-sidebar-react"><div class="folder-list">
          <div class="folder-item"><span class="folder-chevron open"></span><span class="folder-icon"></span><span class="folder-name">Deeply nested material folder</span></div>
          <div class="folder-children"><div class="folder-item"><span class="folder-chevron open"></span><span class="folder-icon"></span><span class="folder-name">Reference collection</span></div>
            <div class="folder-children"><div class="folder-item"><span class="folder-chevron"></span><span class="folder-icon"></span><span class="folder-name">Long folder label retained during expansion</span><button class="folder-action-btn-react"></button></div></div>
          </div>
        </div></div></div>
      </div>
    </nav>
    <div class="sidebar-footer"><div class="nav-item"><span class="nav-icon"></span><span class="nav-label">Settings</span></div><button class="sidebar-toggle"><span class="sidebar-toggle-icon"></span><span class="toggle-text">Collapse</span></button></div>
  </aside>
  <div class="main"><div class="titlebar materials-titlebar">
    <div class="titlebar-left"></div>
    <div class="titlebar-center"><div class="btn-group">
      <button class="view-cycle"><svg viewBox="0 0 16 16"></svg></button>
      <div class="sort-control"><button class="sort-btn"><svg viewBox="0 0 16 16"></svg><span class="sort-label">Recently used</span><svg viewBox="0 0 16 16"></svg></button></div>
      <button class="titlebar-action"><svg viewBox="0 0 16 16"></svg></button>
    </div></div>
    <div class="titlebar-right"><button class="titlebar-search"><span>Search</span></button><div class="window-controls"><button class="win-btn"></button><button class="win-btn"></button><button class="win-btn"></button></div></div>
  </div></div>
</div></body></html>`, "utf8");

    browser = spawn(browserExecutable, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    const port = await waitForDebugPort(profileDir);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((candidate) => candidate.type === "page");
    assert.ok(target, "Headless browser page target is available");
    page = await CdpClient.connect(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send("Page.navigate", { url: pathToFileURL(fixturePath).href });
    await waitForDocument(page);
    await run(page);
  } finally {
    page?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([
        new Promise<void>((resolve) => browser?.once("exit", () => resolve())),
        wait(1_000),
      ]);
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test("minimize-sized layout restoration keeps the same shell nodes and restores final geometry without entry motion", async () => {
  await withShellFixture(async (page) => {
    await evaluate(page, `window.__shellRefs = {
      shell: document.querySelector('.react-nav-shell'),
      sidebar: document.querySelector('.sidebar'),
      navTitle: document.querySelector('.nav-section-title'),
      search: document.querySelector('.titlebar-search'),
      controls: document.querySelector('.window-controls'),
      view: document.querySelector('.view-cycle'),
      sort: document.querySelector('.sort-btn')
    }`);

    await page.send("Emulation.setDeviceMetricsOverride", { width: 1, height: 1, deviceScaleFactor: 1, mobile: false });
    await evaluate(page, `document.querySelector('.react-nav-shell').dataset.sidebarMotion = 'automatic'; document.querySelector('.sidebar').classList.add('collapsed'); document.body.offsetWidth`);
    await wait(240);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(page, `document.querySelector('.sidebar').classList.remove('collapsed'); document.body.offsetWidth`);
    await wait(40);

    const restored = await evaluate<{
      sameNodes: boolean;
      navTransitionProperty: string;
      navTransitionDuration: string;
      searchTransitionProperty: string;
      viewTransitionProperty: string;
      sortTransitionProperty: string;
      searchWidth: number;
      viewWidth: number;
      sortWidth: number;
      sortPaddingInlineStart: number;
      controlsRight: number;
      titlebarRight: number;
      titlebarPaddingRight: number;
      viewportWidth: number;
    }>(page, `(() => {
      const refs = window.__shellRefs;
      const navStyle = getComputedStyle(refs.navTitle);
      const searchStyle = getComputedStyle(refs.search);
      const viewStyle = getComputedStyle(refs.view);
      const sortStyle = getComputedStyle(refs.sort);
      const searchRect = refs.search.getBoundingClientRect();
      const viewRect = refs.view.getBoundingClientRect();
      const sortRect = refs.sort.getBoundingClientRect();
      const controlsRect = refs.controls.getBoundingClientRect();
      const titlebar = document.querySelector('.titlebar');
      const titlebarRect = titlebar.getBoundingClientRect();
      return {
        sameNodes: refs.shell === document.querySelector('.react-nav-shell') && refs.sidebar === document.querySelector('.sidebar') && refs.search === document.querySelector('.titlebar-search'),
        navTransitionProperty: navStyle.transitionProperty,
        navTransitionDuration: navStyle.transitionDuration,
        searchTransitionProperty: searchStyle.transitionProperty,
        viewTransitionProperty: viewStyle.transitionProperty,
        sortTransitionProperty: sortStyle.transitionProperty,
        searchWidth: searchRect.width,
        viewWidth: viewRect.width,
        sortWidth: sortRect.width,
        sortPaddingInlineStart: parseFloat(sortStyle.paddingInlineStart),
        controlsRight: controlsRect.right,
        titlebarRight: titlebarRect.right,
        titlebarPaddingRight: parseFloat(getComputedStyle(titlebar).paddingRight),
        viewportWidth: innerWidth
      };
    })()`);

    assert.equal(restored.sameNodes, true, "restore must preserve shell DOM identity");
    assert.match(restored.navTransitionProperty, /none/u, "automatic compact changes must not replay nav entry transitions");
    assert.match(restored.navTransitionDuration, /^0s/u);
    assert.doesNotMatch(restored.searchTransitionProperty, /(?:^|,\s*)(?:all|width|gap|transform|opacity)(?:,|$)/u);
    assert.ok(Math.abs(restored.searchWidth - 200) < 0.5, `search should be at final width, got ${restored.searchWidth}`);
    assert.ok(Math.abs(restored.viewWidth - 32) < 0.5, `view control should restore at its final width, got ${restored.viewWidth}`);
    await wait(240);
    const settledMaterialsControls = await evaluate<{ viewWidth: number; sortWidth: number; sortPaddingInlineStart: number }>(page, `(() => {
      const view = document.querySelector('.view-cycle');
      const sort = document.querySelector('.sort-btn');
      return {
        viewWidth: view.getBoundingClientRect().width,
        sortWidth: sort.getBoundingClientRect().width,
        sortPaddingInlineStart: parseFloat(getComputedStyle(sort).paddingInlineStart)
      };
    })()`);
    assert.ok(Math.abs(restored.viewWidth - settledMaterialsControls.viewWidth) < 0.5, "view control must not visibly grow after restore");
    assert.ok(Math.abs(restored.sortWidth - settledMaterialsControls.sortWidth) < 0.5,
      `sort control must not visibly grow after restore; restored=${restored.sortWidth}, settled=${settledMaterialsControls.sortWidth}`);
    assert.ok(Math.abs(restored.sortPaddingInlineStart - settledMaterialsControls.sortPaddingInlineStart) < 0.5,
      `sort control padding must be final on the first restored frame; restored=${restored.sortPaddingInlineStart}, settled=${settledMaterialsControls.sortPaddingInlineStart}`);
    assert.doesNotMatch(restored.viewTransitionProperty, /(?:^|,\s*)(?:all|width|padding|gap|transform|opacity)(?:,|$)/u,
      "the Materials view control must not animate geometry after a minimize-sized layout");
    assert.doesNotMatch(restored.sortTransitionProperty, /(?:^|,\s*)(?:all|width|padding|gap|transform|opacity)(?:,|$)/u,
      "the Materials sort control must not grow from its compact breakpoint geometry");
    assert.ok(Math.abs(restored.controlsRight - (restored.titlebarRight - restored.titlebarPaddingRight)) < 0.5, "window controls must restore directly to the final trailing inset");

    for (const targetWidth of [1280, 1920]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1, height: 1, deviceScaleFactor: 1, mobile: false });
      await evaluate(page, `document.querySelector('.react-nav-shell').dataset.sidebarMotion = 'automatic'; document.querySelector('.sidebar').classList.add('collapsed'); document.body.offsetWidth`);
      await wait(240);
      await page.send("Emulation.setDeviceMetricsOverride", { width: targetWidth, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(page, `document.querySelector('.sidebar').classList.remove('collapsed'); document.body.offsetWidth`);
      await wait(40);
      const firstFrame = await evaluate<{ viewWidth: number; sortWidth: number }>(page, `({
        viewWidth: document.querySelector('.view-cycle').getBoundingClientRect().width,
        sortWidth: document.querySelector('.sort-btn').getBoundingClientRect().width
      })`);
      await wait(240);
      const settled = await evaluate<{ viewWidth: number; sortWidth: number }>(page, `({
        viewWidth: document.querySelector('.view-cycle').getBoundingClientRect().width,
        sortWidth: document.querySelector('.sort-btn').getBoundingClientRect().width
      })`);
      assert.ok(Math.abs(firstFrame.viewWidth - settled.viewWidth) < 0.5,
        `view control must be restore-stable at ${targetWidth}px`);
      assert.ok(Math.abs(firstFrame.sortWidth - settled.sortWidth) < 0.5,
        `sort control must be restore-stable at ${targetWidth}px`);
    }

    await evaluate(page, `document.querySelector('.react-nav-shell').dataset.sidebarMotion = 'manual'`);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const reducedMotionDurations = await evaluate<string[]>(page, `[
      getComputedStyle(document.querySelector('.sidebar')).transitionDuration,
      getComputedStyle(document.querySelector('.nav-section-title')).transitionDuration,
      getComputedStyle(document.querySelector('.titlebar-search')).transitionDuration
    ]`);
    assert.deepEqual(reducedMotionDurations, ["0s", "0s", "0s"]);
  });
});

test("manual collapse keeps settings and the collapse control on one fixed bottom track", async () => {
  await withShellFixture(async (page) => {
    const snapshot = async () => evaluate<{
      sidebarBottom: number;
      footerTop: number;
      footerBottom: number;
      footerHeight: number;
      navBottom: number;
      settingsHeight: number;
      toggleHeight: number;
      footerBackground: string;
      sidebarBackground: string;
      sidebarTransitionProperty: string;
      sidebarTransitionDuration: string;
      sectionTransitionProperty: string;
      navOverflowX: string;
      navOverflowY: string;
      navHorizontalScrollbar: number;
      settingsLabelPosition: string;
      settingsLabelWidth: number;
      settingsLabelOpacity: number;
      toggleTextPosition: string;
      toggleTextWidth: number;
      toggleTextOpacity: number;
    }>(page, `(() => {
      const sidebar = document.querySelector('.sidebar');
      const nav = document.querySelector('.sidebar-nav');
      const footer = document.querySelector('.sidebar-footer');
      const settings = footer.querySelector('.nav-item');
      const toggle = footer.querySelector('.sidebar-toggle');
      const settingsLabel = settings.querySelector('.nav-label');
      const toggleText = toggle.querySelector('.toggle-text');
      const sectionTitle = document.querySelector('.nav-section-title');
      const sidebarRect = sidebar.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return {
        sidebarBottom: sidebarRect.bottom,
        footerTop: footerRect.top,
        footerBottom: footerRect.bottom,
        footerHeight: footerRect.height,
        navBottom: navRect.bottom,
        settingsHeight: settings.getBoundingClientRect().height,
        toggleHeight: toggle.getBoundingClientRect().height,
        footerBackground: getComputedStyle(footer).backgroundColor,
        sidebarBackground: getComputedStyle(sidebar).backgroundColor,
        sidebarTransitionProperty: getComputedStyle(sidebar).transitionProperty,
        sidebarTransitionDuration: getComputedStyle(sidebar).transitionDuration,
        sectionTransitionProperty: getComputedStyle(sectionTitle).transitionProperty,
        navOverflowX: getComputedStyle(nav).overflowX,
        navOverflowY: getComputedStyle(nav).overflowY,
        navHorizontalScrollbar: nav.offsetHeight - nav.clientHeight,
        settingsLabelPosition: getComputedStyle(settingsLabel).position,
        settingsLabelWidth: settingsLabel.getBoundingClientRect().width,
        settingsLabelOpacity: Number(getComputedStyle(settingsLabel).opacity),
        toggleTextPosition: getComputedStyle(toggleText).position,
        toggleTextWidth: toggleText.getBoundingClientRect().width,
        toggleTextOpacity: Number(getComputedStyle(toggleText).opacity)
      };
    })()`);

    await evaluate(page, `document.querySelector('.react-nav-shell').dataset.sidebarMotion = 'manual'; document.body.offsetWidth`);
    const expanded = await snapshot();
    await evaluate(page, `document.querySelector('.sidebar').classList.add('collapsed'); document.body.offsetWidth`);
    const collapsedStart = await snapshot();
    await wait(100);
    const collapsedMid = await snapshot();
    await wait(140);
    await evaluate(page, `document.querySelector('.sidebar').classList.remove('collapsed'); document.body.offsetWidth`);
    await wait(40);
    const expandedAgain = await snapshot();

    for (const state of [expanded, collapsedStart, collapsedMid, expandedAgain]) {
      assert.ok(Math.abs(state.footerBottom - state.sidebarBottom) < 0.5, "footer must remain anchored to the sidebar bottom");
      assert.ok(Math.abs(state.navBottom - state.footerTop) < 0.5, "nav and footer tracks must remain contiguous");
      assert.equal(state.footerBackground, state.sidebarBackground, "footer must paint the same continuous sidebar surface");
      assert.match(state.navOverflowX, /^(?:hidden|clip)$/u, "the Materials folder tree must not expose a horizontal scrollbar seam");
      assert.match(state.navOverflowY, /^(?:auto|scroll)$/u, "folder-tree vertical scrolling must remain available");
      assert.ok(state.navHorizontalScrollbar < 1, `folder tree must not reserve a horizontal scrollbar track, got ${state.navHorizontalScrollbar}px`);
    }
    assert.ok(Math.max(expanded.footerHeight, collapsedStart.footerHeight, collapsedMid.footerHeight, expandedAgain.footerHeight)
      - Math.min(expanded.footerHeight, collapsedStart.footerHeight, collapsedMid.footerHeight, expandedAgain.footerHeight) < 0.5,
    "footer track height must not spike during collapse or expansion");
    assert.ok(Math.abs(expanded.settingsHeight - collapsedStart.settingsHeight) < 0.5);
    assert.ok(Math.abs(expanded.toggleHeight - collapsedStart.toggleHeight) < 0.5);
    assert.match(expanded.sidebarTransitionProperty, /width/u, "manual collapse retains the bounded shell width transition");
    assert.match(expanded.sidebarTransitionDuration, /0\.2s/u);
    assert.doesNotMatch(expanded.sectionTransitionProperty, /height|padding|margin/u, "manual collapse must not grow nav sections vertically");
    assert.equal(collapsedStart.settingsLabelPosition, "static", "Settings text must stay on its existing flex track while the sidebar width animates");
    assert.equal(collapsedStart.toggleTextPosition, "static", "Collapse text must stay on its existing flex track while the sidebar width animates");
    assert.ok(collapsedStart.settingsLabelWidth > 0, "Settings text must be clipped by the sidebar instead of being removed on frame zero");
    assert.ok(collapsedStart.toggleTextWidth > 0, "Collapse text must be clipped by the sidebar instead of being removed on frame zero");
    assert.ok(collapsedMid.settingsLabelOpacity > 0 && collapsedMid.settingsLabelOpacity < 1,
      `Settings text should fade in step with the 200ms shell motion, got ${collapsedMid.settingsLabelOpacity}`);
    assert.ok(collapsedMid.toggleTextOpacity > 0 && collapsedMid.toggleTextOpacity < 1,
      `Collapse text should fade in step with the 200ms shell motion, got ${collapsedMid.toggleTextOpacity}`);
  });
});

test("manual sidebar motion keeps header and material-folder icons on one monotonic path", async () => {
  await withShellFixture(async (page) => {
    const positions = async () => evaluate<{ logoX: number; folderX: number; sidebarWidth: number }>(page, `(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const logo = document.querySelector('.logo-mark').getBoundingClientRect();
      const folder = document.querySelector('.folder-icon').getBoundingClientRect();
      return { logoX: logo.left - sidebar.left, folderX: folder.left - sidebar.left, sidebarWidth: sidebar.width };
    })()`);

    await evaluate(page, `document.querySelector('.react-nav-shell').dataset.sidebarMotion = 'manual'; document.body.offsetWidth`);
    const expanded = await positions();
    await evaluate(page, `document.querySelector('.sidebar').classList.add('collapsed'); document.body.offsetWidth`);
    const start = await positions();
    await wait(100);
    const mid = await positions();
    await wait(140);
    const settled = await positions();

    assert.ok(Math.abs(start.logoX - expanded.logoX) < 1,
      `logo must not jump before the width transition starts; expanded=${expanded.logoX}, start=${start.logoX}`);
    assert.ok(mid.logoX <= expanded.logoX + 0.5 && mid.logoX >= settled.logoX - 0.5,
      `logo must follow one bounded path, got ${expanded.logoX} -> ${mid.logoX} -> ${settled.logoX}`);
    assert.ok(Math.abs(start.folderX - expanded.folderX) < 1,
      `folder icon must not jump when its chevron retires; expanded=${expanded.folderX}, start=${start.folderX}`);
    assert.ok(mid.folderX < expanded.folderX - 0.5 && mid.folderX > settled.folderX + 0.5,
      `folder icon must interpolate with the shell, got ${expanded.folderX} -> ${mid.folderX} -> ${settled.folderX}`);
    assert.ok(settled.sidebarWidth < expanded.sidebarWidth, "the contract must exercise the actual sidebar width transition");
  });
});
