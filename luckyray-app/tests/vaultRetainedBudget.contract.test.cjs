const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  test = require("node:test");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const code = esbuild.transformSync(
  fs.readFileSync(
    root + "/src/features/notes/editor/retainedEditorViews.ts",
    "utf8",
  ),
  { loader: "ts", format: "cjs" },
).code;
const moduleValue = { exports: {} };
new Function("module", "exports", code)(moduleValue, moduleValue.exports);
const { RetainedEditorViews } = moduleValue.exports;
function view() {
  const dom = new EventTarget(),
    image = { naturalWidth: 0, naturalHeight: 0 };
  dom.querySelectorAll = (kind) => (kind === "img" ? [image] : []);
  return {
    dom,
    image,
    state: { doc: { length: 10 } },
    destroy() {
      this.destroyed = true;
    },
  };
}
test("late image decode evicts inactive views using current estimated sizes", () => {
  const pool = new RetainedEditorViews(4, 100);
  const a = view(),
    b = view();
  pool.keep("A", a);
  pool.keep("B", b);
  a.image.naturalWidth = 10;
  a.image.naturalHeight = 10;
  a.dom.dispatchEvent(new Event("load"));
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, undefined);
  assert.equal(pool.take("A"), undefined);
  pool.destroy();
  assert.equal(b.destroyed, true);
});
test("reusing a view rechecks capacity without evicting the active oversized document", () => {
  const pool = new RetainedEditorViews(4, 100);
  const a = view(),
    b = view();
  pool.keep("A", a);
  pool.keep("B", b);
  b.state.doc.length = 100;
  assert.equal(pool.take("B"), b);
  pool.trim("B");
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, undefined);
  pool.destroy();
});
