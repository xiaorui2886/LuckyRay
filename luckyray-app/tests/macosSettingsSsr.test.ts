import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("shortcut settings render Command on macOS and keep Ctrl on Windows", async () => {
  const names = ["window", "localStorage", "sessionStorage", "navigator"] as const;
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: typeof names[number], value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, value });
  const storage = {
    getItem: (key: string) => key === "luckyray-settings-v1-activePanel" ? "shortcut" : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  setGlobal("localStorage", storage);
  setGlobal("sessionStorage", storage);
  setGlobal("window", {
    __LUCKYRAY__: null, addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => true, location: { hash: "" },
  });
  // No server is exposed; disabling config discovery avoids esbuild walking
  // inaccessible checkout ancestors in the isolated Windows test sandbox.
  const server = await createServer({ configFile: false, appType: "custom", logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: { ignored: ["**"] } } });
  try {
    const page = await server.ssrLoadModule("/src/features/settings/SettingsPage.tsx");
    const i18n = await server.ssrLoadModule("/src/core/i18n/index.ts");
    for (const [platform, expected] of [["MacIntel", "Cmd+K"], ["Win32", "Ctrl+K"]] as const) {
      setGlobal("navigator", { platform });
      const html = renderToStaticMarkup(React.createElement(i18n.I18nProvider, { locale: "en-US" }, React.createElement(page.default)));
      assert.ok(html.includes(`>${expected}</button>`), `missing ${expected} in ${platform} settings`);
    }
  } finally {
    await server.close();
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
