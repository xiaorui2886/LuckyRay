import assert from "node:assert/strict";
import test from "node:test";
import { dedupeDroppedLocalPaths, normalizeDroppedLocalPath } from "../src/features/notes/externalDropPaths.ts";

test("macOS native drops retain distinct literal paths and safely decode local file URLs", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    assert.equal(normalizeDroppedLocalPath("file:///Users/Ray/%E7%AC%94%E8%AE%B0%20one.md"), "/Users/Ray/笔记 one.md");
    assert.equal(normalizeDroppedLocalPath("file://localhost/Users/Ray/a%5Cb.md"), "/Users/Ray/a\\b.md");
    assert.equal(normalizeDroppedLocalPath("/Users/Ray/a\\b.md"), "/Users/Ray/a\\b.md");
    assert.equal(normalizeDroppedLocalPath("file:///tmp/a%09b.md"), "/tmp/a\tb.md");
    const paths = ["/Users/Ray/File.md", "/Users/Ray/file.md", "/Users/Ray/name ", "/Users/Ray/name", "/Users/Ray/a\\b.md"];
    assert.deepEqual(dedupeDroppedLocalPaths([...paths, paths[0]]), paths);
    for (const input of ["file://elsewhere/secret", "file:///tmp/a%2fb", "file:///tmp/%2e%2e/secret", "file:///tmp/%00bad", "file:///tmp/has#fragment", "file:///tmp/%zz", "file:///tmp/a\\b.md", "file:///tmp/a\tb.md", "file:///tmp/a\rb.md", "file:///tmp/a\nb.md", "/tmp/../secret", "relative.md", "https://example.com/a.md"]) {
      assert.equal(normalizeDroppedLocalPath(input), "", input);
    }
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32" } });
    assert.equal(normalizeDroppedLocalPath(" C:/Users/Ray/A.md "), "C:\\Users\\Ray\\A.md");
    assert.equal(normalizeDroppedLocalPath("file:///C:/Users/Ray/a\\b.md"), "C:\\Users\\Ray\\a\\b.md");
    assert.deepEqual(dedupeDroppedLocalPaths(["C:/Users/Ray/A.md", "c:\\users\\ray\\a.md"]), ["C:\\Users\\Ray\\A.md"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
