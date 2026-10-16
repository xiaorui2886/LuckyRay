import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as access from "../src/core/services/companionAccess.ts";
import { companionDeviceDisplayLabel } from "../src/core/services/companionPresentationStore.ts";

function harness() {
  const state: any = { status: { state: "running" }, devices: [{ deviceId: "a", label: "Test phone" }], services: { a: { permissionRevision: 4, currentVault: { vaultId: "vault-a", label: "Journal" }, grants: [] } }, grantBusy: {}, grantLoading: {}, grantErrors: {}, busy: "" };
  const calls: any[] = [], slots: any[] = [], effects: any[] = [], modalActivity: boolean[] = []; let at = 0, tree: any;
  const hooks = { useEffect(effect: () => void) { effects.push(effect); }, useState(initial: any) { const i = at++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; } };
  const store = { getSnapshot: () => state, applyServiceChanges: async (...args: any[]) => { calls.push(args); return true; } };
  const exports: any = {};
  const source = readFileSync(new URL("../src/features/settings/PhoneAccessManager.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const jsx = (type: any, props: any) => ({ type, props });
  new Function("require", "exports", "document", code)((id: string) => {
    if (id === "react") return hooks;
    if (id === "react-dom") return { createPortal: (child: any) => child };
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (id.endsWith("companionAccess")) return access;
    if (id.endsWith("companionPresentationStore")) return { companionDeviceDisplayLabel };
    if (id.endsWith("CompanionPresentation")) return { useCompanionSnapshot: () => state };
    if (id.endsWith("i18n/index")) return { defineMessages: (value: any) => value, useMessages: (copy: any) => ({ t: (key: string, args: any = {}) => copy[key]["en-US"].replace(/\{([^}]+)\}/g, (_: string, key: string) => args[key] ?? "") }) };
    if (id.endsWith("applicationModalIsolation")) return { useApplicationModalSurface: (active: boolean, close: () => void) => { modalActivity.push(active); return ({ surfaceRef: {}, onSurfaceKeyDown: (event: any) => { if (event.key === "Escape") close(); }, onBackdropPointerDown: () => close() }); } };
    if (id.endsWith(".css")) return {};
    throw Error(id);
  }, exports, { body: {}, querySelector: () => null });
  const walk = (value: any): any[] => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
  const render = () => { at = 0; tree = exports.default({ store, deviceId: "a" }); effects.splice(0).forEach(effect => effect()); return walk(tree); };
  const button = (label: string) => render().find(node => node.type === "button" && node.props.children === label);
  return { state, calls, render, modalActivity, button, inputs: () => render().filter(node => node.type === "input"), dialog: () => render().find(node => node.props?.role === "dialog") };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
test("real trust dialog explains exact catalog/vault and deletion, requires confirm, and keeps cancel read-only", async () => {
  const h = harness(); h.button("Trust this phone…").props.onClick();
  assert.match(JSON.stringify(h.dialog()), /All managed records/); assert.match(JSON.stringify(h.dialog()), /Current vault · Journal/);
  assert.match(JSON.stringify(h.dialog()), /removing managed records/); assert.match(JSON.stringify(h.dialog()), /deleting notes/);
  assert.deepEqual(h.inputs().map(node => node.props.checked), [true, true, false, false]);
  assert.equal(h.calls.length, 0); h.button("Cancel").props.onClick(); assert.equal(h.dialog(), undefined); assert.equal(h.calls.length, 0);
  h.button("Trust this phone…").props.onClick(); h.button("Confirm selected access").props.onClick(); await drain();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], "a"); assert.equal(h.calls[0][1].length, 6);
  assert.ok(h.calls[0][1].every((change: any) => change.grantClass !== "content.write")); assert.equal(h.dialog(), undefined);
});
test("real write opt-in is explicit and changing current vault disables stale confirmation", async () => {
  const h = harness(); h.button("Trust this phone…").props.onClick();
  h.inputs()[2].props.onChange({ target: { checked: true } }); h.inputs()[3].props.onChange({ target: { checked: true } });
  h.button("Confirm selected access").props.onClick(); await drain(); assert.equal(h.calls[0][1].length, 8);
  h.button("Trust this phone…").props.onClick(); h.state.services.a.currentVault = { vaultId: "vault-b", label: "Other" };
  assert.equal(h.button("Confirm selected access").props.disabled, true);
  h.button("Confirm selected access").props.onClick(); await drain(); assert.equal(h.calls.length, 1);
  h.dialog().props.onKeyDown({ key: "Escape" }); assert.equal(h.dialog(), undefined);
});
test("real revoke confirmation identifies all retained scopes and changes no pairing/LSH switch", async () => {
  const h = harness(); h.state.services.a.grants = [
    { grantClass: "content.read", scopeKind: "catalog", scopeId: "" },
    { grantClass: "content.write", scopeKind: "vault", scopeId: "vault-old" },
    { grantClass: "content.read", scopeKind: "vault", scopeId: "vault-a" },
  ];
  h.button("Turn off all material/vault access…").props.onClick();
  assert.match(JSON.stringify(h.dialog()), /All managed records/); assert.match(JSON.stringify(h.dialog()), /Journal/); assert.match(JSON.stringify(h.dialog()), /Vault · old/);
  assert.match(JSON.stringify(h.dialog()), /Pairing and the separate LSH remote switch stay/);
  assert.equal(h.calls.length, 0); h.button("Confirm turning off listed access").props.onClick(); await drain();
  assert.equal(h.calls[0][1].length, 3); assert.ok(h.calls[0][1].every((change: any) => !change.enabled));
  h.button("Revoke this vault…").props.onClick(); h.button("Confirm turning off listed access").props.onClick(); await drain();
  assert.equal(h.calls[1][1].length, 1); assert.equal(h.calls[1][1][0].scopeId, "vault-old");
});

test("losing authoritative grant/device state releases the modal and does not resurrect old consent", () => {
  const h = harness(); h.button("Trust this phone…").props.onClick(); assert.ok(h.dialog());
  const before = h.state.services.a; h.state.services.a = undefined; assert.equal(h.dialog(), undefined);
  assert.equal(h.modalActivity.at(-1), false);
  h.state.services.a = before; assert.equal(h.dialog(), undefined); assert.equal(h.calls.length, 0);
  h.button("Trust this phone…").props.onClick(); assert.ok(h.dialog());
  h.state.devices = []; assert.equal(h.dialog(), undefined); assert.equal(h.modalActivity.at(-1), false);
  h.state.devices = [{ deviceId: "a", label: "Test phone" }]; assert.equal(h.dialog(), undefined);
});
