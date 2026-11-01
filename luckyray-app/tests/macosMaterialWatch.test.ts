import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("macOS material watch sources preserve distinct folder names without changing Windows deduplication", async () => {
  const names = ["navigator", "window", "localStorage"] as const;
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = new Map<string, string>();
  const server = await createServer({ configFile: false, appType: "custom", logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: { ignored: ["**"] } } });
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => true } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    const { addMaterialWatchSource, readMaterialWatchSources } = await server.ssrLoadModule("/src/features/materials/materialWatch.ts");
    addMaterialWatchSource("/Users/Ray/Source ");
    addMaterialWatchSource("/Users/Ray/source ");
    addMaterialWatchSource("/Users/Ray/a\\b");
    addMaterialWatchSource("/Users/Ray/a/b");
    addMaterialWatchSource("not-absolute");
    addMaterialWatchSource("/Users/Ray/../outside");
    assert.deepEqual(readMaterialWatchSources().map((source) => source.path), [
      "/Users/Ray/Source ", "/Users/Ray/source ", "/Users/Ray/a\\b", "/Users/Ray/a/b",
    ]);
    values.clear();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32" } });
    addMaterialWatchSource(" C:/Data ");
    addMaterialWatchSource("c:\\data");
    assert.deepEqual(readMaterialWatchSources().map((source) => source.path), ["c:\\data"]);
  } finally {
    await server.close();
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
