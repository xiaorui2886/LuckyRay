import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import lightSeekUi from "../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js";
import lightSeekPackage from "../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/package.json" with { type: "json" };

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cosmicBackgroundPath = resolve(
  appRoot,
  "src-tauri",
  "dsh-host",
  "luckyray-dsh-lightseek-ui",
  "lightseek-cosmic-home.webp",
);
const brandSlotNames = Object.freeze([
  "sidebar.brand.mark",
  "sidebar.brand.name",
  "conversation.hero.brand.mark",
]);

async function loadOfficialBrandClientModule() {
  const sourcePath = resolve(
    appRoot,
    "src-tauri",
    "dsh",
    "host",
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-brand-official",
    "lib",
    "client.js",
  );
  const source = await readFile(sourcePath, "utf8");
  let loaderEntry;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loaderEntry = entry;
        },
      },
    },
  }, { filename: sourcePath });
  assert.equal(loaderEntry?.id, "@deepseek-ai/dsh-client-ui-brand-official");
  return loaderEntry.factory((specifier) => {
    if (specifier === "react/jsx-runtime") {
      return { jsx: (type, props) => ({ type, props }) };
    }
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        BrandWordmark: function BrandWordmark() {},
        FishLogo: function FishLogo() {},
      };
    }
    throw new Error(`unexpected official brand dependency: ${specifier}`);
  });
}

function createStrictSingleSlotRegistry() {
  const entries = new Map(brandSlotNames.map((name) => [name, []]));
  let currentOwner = "unknown";
  const installEffect = (effect) => {
    if (effect && typeof effect[Symbol.iterator] === "function") {
      for (const _disposer of effect) {
        // Exhaust the declaration-bound transaction, as the official registry does.
      }
    }
  };
  const slots = {
    inject(name, callback) {
      assert.ok(entries.has(name), `unexpected brand slot injection: ${name}`);
      installEffect(callback());
      return () => {};
    },
    register(options, component) {
      assert.ok(entries.has(options.name), `unexpected brand slot registration: ${options.name}`);
      const priority = options.priority ?? 0;
      const cell = entries.get(options.name);
      if (cell.some((entry) => entry.priority === priority)) {
        throw new Error(
          `single slot "${options.name}" already has a registration at priority ${priority} (registered by ${cell.find((entry) => entry.priority === priority).owner}) — register at a different priority to shadow it (lowest renders)`,
        );
      }
      const entry = { component, options, owner: currentOwner, priority };
      cell.push(entry);
      cell.sort((left, right) => left.priority - right.priority);
      return () => {
        const at = cell.indexOf(entry);
        if (at >= 0) cell.splice(at, 1);
      };
    },
  };
  return {
    apply(owner, clientModule, extra = {}) {
      const previousOwner = currentOwner;
      currentOwner = owner;
      try {
        clientModule.apply({ slots, ...extra });
      } finally {
        currentOwner = previousOwner;
      }
    },
    entries(name) {
      return entries.get(name).slice();
    },
    winner(name) {
      return entries.get(name)[0];
    },
  };
}

function installClientModule() {
  const registrations = [];
  const injected = [];
  const overrides = [];
  const clientModule = lightSeekUi.createClientModule((specifier) => {
    assert.equal(specifier, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }) };
  });
  const slots = {
    inject(name, callback) {
      injected.push(name);
      const installed = callback();
      if (installed && typeof installed[Symbol.iterator] === "function") {
        for (const _disposer of installed) {
          // Exhaust the official iterable effect so every registration is observed.
        }
      }
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const theme = {
    overrideTokens(source, tokens) {
      overrides.push({ source, tokens });
      return () => {};
    },
  };
  clientModule.apply({
    slots,
    theme,
  });
  return { clientModule, injected, overrides, registrations };
}

test("LightSeek is an app-owned official client-module occupant with no new runtime authority", () => {
  assert.equal(lightSeekPackage.name, "@luckyray/dsh-lightseek-ui");
  assert.equal(lightSeekPackage.main, "client.js");
  assert.deepEqual(lightSeekPackage.dsh.client.inject, [
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-ui-theme",
    "@deepseek-ai/dsh-client-ui-sidebar",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-brand-official",
  ]);
  assert.equal(lightSeekPackage.dsh.client.immediately, true);
  assert.deepEqual(installClientModule().clientModule.inject, ["slots", "theme"]);
});

test("LightSeek shades only the three declared brand slots and keeps the official shell", () => {
  const { injected, registrations } = installClientModule();
  assert.deepEqual(injected, [
    "sidebar.brand.mark",
    "sidebar.brand.name",
    "conversation.hero.brand.mark",
  ]);
  assert.deepEqual(registrations.map(({ options }) => options), [
    { name: "sidebar.brand.mark", priority: -10 },
    { name: "sidebar.brand.name", priority: -10 },
    { name: "conversation.hero.brand.mark", priority: -10 },
  ]);
  const sidebarMark = registrations[0].component({ size: 24, className: "official-owner-class" });
  assert.equal(sidebarMark.type, "img");
  assert.equal(sidebarMark.props.width, 24);
  assert.equal(sidebarMark.props.height, 24);
  assert.equal(sidebarMark.props.className, "official-owner-class");
  assert.equal(sidebarMark.props["aria-hidden"], "true");
  const sidebarName = registrations[1].component({});
  assert.equal(sidebarName.type, "span");
  assert.equal(sidebarName.props.children, "LightSeek");
  assert.equal(sidebarName.props["aria-label"], "LightSeek");
  const heroMark = registrations[2].component({ size: 34, className: "official-hero-class" });
  assert.equal(heroMark.type, "span");
  assert.match(heroMark.props.className, /official-hero-class/u);
  assert.match(heroMark.props.className, /lightseek-cosmic-hero-brand/u);
  assert.deepEqual(heroMark.props.style, { width: 34, height: 34 });
  const [themeStyle, heroImage] = heroMark.props.children;
  assert.equal(themeStyle.type, "style");
  assert.match(themeStyle.props.children, /\[data-phase="hero"\]:has\(\.lightseek-cosmic-hero-brand\)/u);
  assert.match(themeStyle.props.children, /cosmic-home-v1\.webp/u);
  assert.match(themeStyle.props.children, /--dsw-specific-input-major:/u);
  assert.match(themeStyle.props.children, /@media \(max-width: 720px\)/u);
  assert.doesNotMatch(themeStyle.props.children, /data-phase="active"|querySelector|MutationObserver/u);
  assert.equal(heroImage.type, "img");
  assert.equal(heroImage.props.width, 34);
  assert.equal(heroImage.props.height, 34);
});

test("LightSeek cosmic home is a bounded, text-free generated background asset", async () => {
  const bytes = await readFile(cosmicBackgroundPath);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
  assert.ok(bytes.length > 80 * 1024, "background should preserve useful visual detail");
  assert.ok(bytes.length < 600 * 1024, "background must stay bounded for first paint");
  assert.equal(lightSeekUi.COSMIC_BACKGROUND_ROUTE, "/__luckyray/lightseek/cosmic-home-v1.webp");
});

test("LightSeek host serves the generated background through one immutable same-origin asset route", async () => {
  const routes = [];
  const taps = [];
  const effects = [];
  lightSeekUi.apply({
    get(name) {
      assert.equal(name, "webServer");
      return {
        register(route) {
          routes.push(route);
          return () => {};
        },
        tapIndex(tap) {
          taps.push(tap);
          return () => {};
        },
      };
    },
    effect(install, label) {
      effects.push(label);
      install();
    },
  });
  assert.equal(taps.length, 1);
  assert.deepEqual(effects, [
    "luckyray: LightSeek cosmic home asset",
    "luckyray: LightSeek client graph order",
  ]);
  assert.equal(routes.length, 1);
  assert.deepEqual(
    { kind: routes[0].kind, path: routes[0].path },
    { kind: "exact", path: lightSeekUi.COSMIC_BACKGROUND_ROUTE },
  );
  let status;
  let headers;
  let body;
  await routes[0].handler({ method: "GET" }, {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody) {
      body = nextBody;
    },
  });
  assert.equal(status, 200);
  assert.equal(headers["Content-Type"], "image/webp");
  assert.equal(headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.ok(Buffer.isBuffer(body));
  assert.ok(body.length > 80 * 1024);
});

test("official rc.2 brand and LightSeek compose through deterministic single-slot shadowing", async () => {
  assert.equal(lightSeekUi.LIGHTSEEK_SLOT_PRIORITY, -10);
  const officialBrand = await loadOfficialBrandClientModule();
  const registry = createStrictSingleSlotRegistry();
  registry.apply("official", officialBrand);
  registry.apply("lightseek", lightSeekUi.createClientModule((specifier) => {
    assert.equal(specifier, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }) };
  }), {
    theme: { overrideTokens() {} },
  });
  for (const name of brandSlotNames) {
    // 0.1.5 official brand registers only the two sidebar slots and leaves
    // the conversation hero to the declaring package's animated fallback.
    const expected = name === "conversation.hero.brand.mark"
      ? [{ owner: "lightseek", priority: -10 }]
      : [{ owner: "lightseek", priority: -10 }, { owner: "official", priority: 0 }];
    assert.deepEqual(
      registry.entries(name).map(({ owner, priority }) => ({ owner, priority })),
      expected,
    );
    assert.equal(registry.winner(name).owner, "lightseek");
  }
});

test("official rc.2 single-slot composition remains fail-closed at equal priority", async () => {
  const officialBrand = await loadOfficialBrandClientModule();
  const registry = createStrictSingleSlotRegistry();
  registry.apply("official", officialBrand);
  assert.throws(
    () => registry.apply("equal-priority", {
      apply(ctx) {
        ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register(
          { name: "sidebar.brand.mark", priority: 0 },
          function InvalidEqualPriorityBrand() {},
        ));
      },
    }),
    /single slot "sidebar\.brand\.mark" already has a registration at priority 0.*lowest renders/u,
  );
  assert.equal(registry.winner("sidebar.brand.mark").owner, "official");
});

test("LightSeek uses the supplied path-only vector with a square optical crop", () => {
  const prefix = "data:image/svg+xml;charset=utf-8,";
  assert.ok(lightSeekUi.LOGO_DATA_URL.startsWith(prefix));
  const embedded = decodeURIComponent(lightSeekUi.LOGO_DATA_URL.slice(prefix.length));
  assert.match(embedded, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="800" viewBox="219 197 800 800">/u);
  assert.equal((embedded.match(/<path\b/gu) ?? []).length, 14);
  assert.doesNotMatch(embedded, /<image\b|<script\b|(?:href|xlink:href)\s*=/u);
});

test("LightSeek overrides complete light and dark theme tokens without touching tool gradients", () => {
  const { overrides } = installClientModule();
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].source, "@luckyray/dsh-lightseek-ui");
  assert.equal(overrides[0].tokens, lightSeekUi.LIGHTSEEK_THEME_TOKENS);
  const names = Object.keys(overrides[0].tokens);
  for (const name of names) {
    assert.match(name, /^--(?:dsw|ds)-[a-z0-9-]+$/u);
    assert.deepEqual(Object.keys(overrides[0].tokens[name]).sort(), ["dark", "light"]);
    assert.ok(overrides[0].tokens[name].light.length > 0);
    assert.ok(overrides[0].tokens[name].dark.length > 0);
  }
  assert.ok(names.includes("--dsw-alias-brand-primary"));
  assert.ok(names.includes("--dsw-specific-sidebar-fill"));
  assert.ok(names.includes("--dsw-specific-menu"));
  assert.ok(names.includes("--dsw-specific-input-major"));
  assert.ok(names.includes("--dsw-alias-markdown-code-block"));
  assert.ok(names.includes("--dsw-alias-scrollbar-bg-l1"));
  for (const name of [
    "--dsw-alias-state-business-primary",
    "--dsw-alias-button-info-fill",
    "--dsw-alias-button-primary-fill",
  ]) {
    assert.deepEqual(overrides[0].tokens[name], { light: "#7c8aff", dark: "#7c8aff" });
  }
  for (const name of [
    "--dsw-alias-button-info-hover",
    "--dsw-alias-button-primary-hover",
  ]) {
    assert.deepEqual(overrides[0].tokens[name], { light: "#9aa4ff", dark: "#9aa4ff" });
  }
  assert.deepEqual(overrides[0].tokens["--dsw-alias-state-business-tertiary"], {
    light: "rgba(124, 138, 255, 0.12)",
    dark: "rgba(124, 138, 255, 0.12)",
  });
  assert.equal(names.includes("--dsw-alias-button-info-dimmed"), false);
  assert.equal(names.some((name) => name.includes("gradient") || name.includes("shadow")), false);
});

test("the 0.1.5 graph assertion keeps every LightSeek dependency present exactly once and leaves the graph untouched", () => {
  const graph = {
    entries: [
      { id: "@deepseek-ai/dsh-client-ui-brand-official" },
      { id: "@deepseek-ai/dsh-client-ui-conversation" },
      { id: "@deepseek-ai/dsh-client-ui-theme" },
      { id: "@luckyray/dsh-lightseek-ui" },
      { id: "unrelated" },
    ],
  };
  const html = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)}</script></head></html>`;
  const rendered = lightSeekUi.assertLuckyRayLightSeekGraphOrder(html);
  assert.equal(rendered, html, "the 0.1.5 graph is authoritative and must not be reordered");
  const ids = JSON.parse(
    /globalThis\["__DSH_BOOT__"\]\s*=\s*(?<json>\{[^<]+\})<\/script>/u.exec(rendered)?.groups?.json,
  ).entries.map((entry) => entry.id);
  for (const dependency of [
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-theme",
    "@deepseek-ai/dsh-client-ui-brand-official",
  ]) {
    assert.equal(ids.filter((id) => id === dependency).length, 1, dependency);
  }
  assert.equal(ids.filter((id) => id === "@luckyray/dsh-lightseek-ui").length, 1);
});

test("the LightSeek graph assertion fails closed on a missing declared dependency", () => {
  const html = `<html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ entries: [
    { id: "@deepseek-ai/dsh-client-ui-theme" },
    { id: "@luckyray/dsh-lightseek-ui" },
  ] })}</script></head></html>`;
  assert.throws(
    () => lightSeekUi.assertLuckyRayLightSeekGraphOrder(html),
    /dsh-lightseek-ui-graph-invalid/u,
    "a missing brand-official dependency must fail the tap",
  );
});

test("4B adds no brittle DOM seam, prompt execution, polling, or official attribution rewrite", async () => {
  const source = await readFile(resolve(
    appRoot,
    "src-tauri",
    "dsh-host",
    "luckyray-dsh-lightseek-ui",
    "client.js",
  ), "utf8");
  assert.doesNotMatch(source, /querySelector|querySelectorAll|getElementsBy|MutationObserver|setTimeout|setInterval/u);
  assert.doesNotMatch(source, /联网搜索|浏览并整理网页|查询知识库|使用素材库|今天想一起做什么/u);
  assert.doesNotMatch(source, /inputActions|\.submit\s*\(/u);
  assert.doesNotMatch(source, /DeepSeek Harness/u);
  const settings = await readFile(resolve(appRoot, "src", "features", "settings", "SettingsPage.tsx"), "utf8");
  assert.match(settings, /DeepSeek Harness 诊断/u);
  const authority = JSON.parse(await readFile(resolve(appRoot, "dsh-host", "runtime-authority.json"), "utf8"));
  assert.equal(authority.runtimePackage.name, "@deepseek-ai/dsh");
  assert.equal(authority.runtimePackage.version, "0.1.7-rc.2");
  assert.equal(authority.sourceReference.declaredVersion, "0.1.7-rc.2");
});
