import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the actual component's hooks and JSX handlers; no screen, profile, IPC or deletion.
function harness() {
  const slots: any[] = [];
  let cursor = 0, pending: Array<() => void> = [], tree: any;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback: () => void, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) { slots[index] = deps; pending.push(callback); }
    },
  };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const source = readFileSync(new URL("../src/features/materials/MissingAssetsPanel.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: { MissingAssetsPanel?: (props: any) => unknown } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith("/i18n/index")) return { useI18n: () => ({ t: (key: string) => key }) };
    if (name.endsWith("/materialsToolbarProtocol")) return { MATERIALS_MISSING_PANEL_ID: "fixture-missing" };
    throw Error(`unexpected dependency: ${name}`);
  }, exports);
  const batches: Array<{ ids: string[]; all: boolean }> = [];
  const props = {
    open: true, list: [{ id: "a", name: "A", libraryPath: "C:/synthetic/missing-a" }, { id: "b", name: "B", libraryPath: "C:/synthetic/missing-b" }],
    loading: false, error: "", relocatingIds: new Set<string>(), removing: false,
    onScan() {}, onRelocate() {}, onRemove() {}, onClose() {},
    onRemoveMany(ids: string[], all: boolean) { batches.push({ ids, all }); },
  };
  function render(patch = {}) {
    Object.assign(props, patch);
    for (let i = 0; i < 3; i++) {
      cursor = 0; tree = exports.MissingAssetsPanel!(props);
      const effects = pending; pending = []; effects.forEach((effect) => effect());
    }
  }
  function find(predicate: (node: any) => boolean, node = tree): any {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) return node.map((child) => find(predicate, child)).find(Boolean);
    return predicate(node) ? node : find(predicate, node.props?.children ?? null);
  }
  const text = (node: any): string => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : "";
  render();
  return { props, batches, render, find, button: (key: string) => find((node) => node.type === "button" && text(node).includes(key)) };
}

test("missing panel requests exactly the independently selected records or the current full list", () => {
  const panel = harness();
  assert.equal(panel.button("materials.missing.removeSelected").props.disabled, true);
  const checkbox = panel.find((node) => node.type === "input" && Boolean(node.props["aria-label"]));
  checkbox.props.onChange(); panel.render();
  assert.equal(panel.button("materials.missing.removeSelected").props.disabled, false);
  panel.button("materials.missing.removeSelected").props.onClick();
  panel.button("materials.missing.removeAll").props.onClick();
  assert.deepEqual(panel.batches, [{ ids: ["a"], all: false }, { ids: ["a", "b"], all: true }]);
});

test("missing panel select-all toggles and scan changes cannot leave stale selected IDs", () => {
  const panel = harness();
  panel.find((node) => node.type === "input" && Boolean(node.props.ref)).props.onChange(); panel.render();
  assert.equal(panel.find((node) => node.type === "input" && Boolean(node.props.ref)).props.checked, true);
  panel.render({ list: [panel.props.list[1]] });
  panel.button("materials.missing.removeSelected").props.onClick();
  assert.deepEqual(panel.batches, [{ ids: ["b"], all: false }]);
  panel.find((node) => node.type === "input" && Boolean(node.props.ref)).props.onChange(); panel.render();
  assert.equal(panel.button("materials.missing.removeSelected").props.disabled, true);
});

test("missing panel does not retain a hidden selection after closing and reopening", () => {
  const panel = harness();
  panel.find((node) => node.type === "input" && Boolean(node.props.ref)).props.onChange(); panel.render();
  panel.render({ open: false }); panel.render({ open: true });
  assert.equal(panel.button("materials.missing.removeSelected").props.disabled, true);
});

test("missing panel disables conflicting writes during scanning, relocation or removal", () => {
  for (const patch of [{ loading: true }, { removing: true }, { relocatingIds: new Set(["a"]) }]) {
    const panel = harness(); panel.render(patch);
    for (const key of ["materials.missing.removeAll", "materials.missing.removeSelected", "materials.missing.scan"]) assert.equal(panel.button(key).props.disabled, true);
    assert.equal(panel.find((node) => node.type === "input").props.disabled, true);
  }
});

test("missing panel blocks bulk removal on an empty list or a failed scan", () => {
  for (const patch of [{ list: [] }, { error: "scan-failed" }]) {
    const panel = harness(); panel.render(patch);
    assert.equal(panel.button("materials.missing.removeAll").props.disabled, true);
    assert.equal(panel.button("materials.missing.removeSelected").props.disabled, true);
    assert.deepEqual(panel.batches, []);
  }
});

test("the actual bulk handler freezes only listed IDs and waits for confirmation", () => {
  const sourceText = readFileSync(new URL("../src/features/materials/MaterialsPage.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("MaterialsPage.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleRemoveManyMissing" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const compiled = ts.transpileModule(`const handler = ${callback!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const writes: string[][] = [];
  const pending: any[] = [];
  const removing = { current: false };
  const handler = new Function("missingRemovingRef", "missingRelocatingIdsRef", "missingOperationCurrent", "missingList", "openConfirmDialog", "t", "performRemoveMissing", `${compiled}; return handler;`)(
    removing, { current: new Set() }, () => true, [{ id: "a" }, { id: "b" }], (value: unknown) => pending.push(value), (key: string) => key, (ids: string[]) => writes.push(ids),
  );
  const selected = ["a", "a", "outside"];
  handler(selected, false);
  assert.deepEqual(writes, [], "opening or cancelling the prompt cannot mutate records");
  assert.equal(pending.length, 1);
  selected[0] = "b";
  pending[0].actions[0].onClick();
  assert.deepEqual(writes, [["a"]], "confirmation uses its frozen target, not later selection");
  removing.current = true;
  handler(["b"], true);
  assert.equal(pending.length, 1, "a busy removal cannot open another write prompt");
});
