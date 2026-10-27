import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as access from "../src/core/services/companionAccess.ts";
import * as gateway from "../src/core/services/companionGateway.ts";
import * as presentation from "../src/core/services/companionPresentationStore.ts";
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const nodes = (value: any): any[] => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];

// Execute real component functions/handlers against the real store. Only React
// scheduling, the native transport and modal/locale seams are mocked. This is
// UI-prop evidence, not a browser paint/focus or Windows cursor measurement.
function component(store: presentation.CompanionPresentationStore, file: string, internal?: string) {
  const slots: any[] = []; let cursor = 0;
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect() {}, useMemo(make: any) { const i = cursor++; return slots[i] ??= make(); },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const source = readFileSync(new URL(`../src/features/settings/${file}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  new Function("require", "exports", "document", compiled + (internal ? `\nexports.testComponent = ${internal};` : ""))((id: string) => {
    if (id === "react") return hooks;
    if (id === "react-dom") return { createPortal: (child: any) => child };
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (id.endsWith("companionAccess")) return access;
    if (id.endsWith("companionGateway")) return gateway;
    if (id.endsWith("companionPresentationStore")) return presentation;
    if (id.endsWith("CompanionGatewayPanel")) return { COMPANION_COPY: {}, gatewayErrorMessage: () => "error" };
    if (id.endsWith("PhoneAccessManager")) return { default: () => null };
    if (id.endsWith("PhoneAuthorizationChoice")) return { default: () => null, PHONE_AUTHORIZATION_COPY: {} };
    if (id.endsWith("CompanionPresentation")) return { useCompanionSnapshot: () => store.getSnapshot(), useCompanionStore: () => store, useCompanionView: () => ({ state: store.getSnapshot(), owner: null, seconds: 60 }) };
    if (id.endsWith("i18n/index")) return { defineMessages: (value: any) => value, useMessages: () => ({ locale: "en-US", t: (key: string) => key }) };
    if (id.endsWith("applicationModalIsolation")) return { useApplicationModalSurface: () => ({ surfaceRef: {}, onSurfaceKeyDown() {}, onBackdropPointerDown() {} }) };
    if (id.endsWith(".css")) return {};
    throw Error(id);
  }, exports, { body: {}, visibilityState: "visible", querySelector: () => null });
  return () => { cursor = 0; return nodes((internal ? exports.testComponent : exports.default)({ store, deviceId: "a" })); };
}

function fixture() {
  const status = { state: "running", desktopInstanceId: "fixture-desktop", certificateFingerprint: "f".repeat(64), generation: 1, bindAddress: "192.168.1.20", port: 40000 };
  const device = { deviceId: "a", label: "Phone", connected: true, revokedAt: null, createdAt: "", lastAuthenticatedAt: null };
  const services: gateway.CompanionServiceGrantState = { permissionRevision: 1, currentVault: { vaultId: "vault-a", label: "A" }, grants: [] };
  const holds = new Map<string, Array<() => void>>();
  const gated = new Set<string>();
  const calls: string[] = [];
  const client = gateway.createCompanionGatewayClient(async (command, args) => {
    calls.push(command);
    if (gated.has(command)) await new Promise<void>(resolve => { const waiters = holds.get(command) || []; waiters.push(resolve); holds.set(command, waiters); });
    if (command === "companion_gateway_status") return structuredClone(status);
    if (command === "companion_gateway_list_devices") return [structuredClone(device)];
    if (command === "companion_gateway_list_interfaces" || command === "companion_gateway_list_audit") return [];
    if (command === "companion_gateway_service_grants") return structuredClone(services);
    if (command === "companion_gateway_lsh_remote_state") return { granted: false, runtimeAvailable: false };
    if (command === "companion_gateway_service_set_grants") {
      assert.equal(args!.expectedPermissionRevision, services.permissionRevision);
      for (const { enabled, ...grant } of args!.changes as any[]) if (enabled) services.grants.push(grant);
      services.permissionRevision++; return;
    }
    throw Error(command);
  });
  const store = presentation.createCompanionPresentationStore(client);
  return { store, calls, gate: (command: string) => gated.add(command), release(command: string) { gated.delete(command); for (const resolve of holds.get(command) || []) resolve(); holds.delete(command); } };
}

test("production quick/advanced/trust controls remain enabled through unchanged background polls", async () => {
  const f = fixture(); const close = f.store.open(Symbol("advanced"), true); await drain();
  const quick = component(f.store, "PhoneConnectionDialog.tsx", "PhoneConnectionContents");
  const advanced = component(f.store, "CompanionGatewayPanel.tsx", "ConnectedCompanionGatewayPanel");
  const trust = component(f.store, "PhoneAccessManager.tsx");
  const button = (tree: any[], key: string) => tree.find(node => node.type === "button" && (node.props["aria-label"] === key || node.props.children === key));
  const visible = () => ({
    quickRefreshDisabled: Boolean(button(quick(), "action.refresh").props.disabled),
    quickReadDisabled: Boolean(button(quick(), "devices.materialRead").props.disabled),
    quickPaneBusy: Boolean(quick().find(node => node.props?.className === "phone-connection-right").props["aria-busy"]),
    advancedRefreshDisabled: Boolean(button(advanced(), "action.refresh").props.disabled),
    advancedLshDisabled: Boolean(button(advanced(), "devices.lshRemote").props.disabled),
    trustDisabled: Boolean(button(trust(), "changeMode").props.disabled),
  });
  const before = visible(); assert.ok(Object.values(before).every(value => value === false));
  const trace: any[] = [];
  const unsubscribe = f.store.subscribe(() => trace.push(visible()));
  f.gate("companion_gateway_status"); f.gate("companion_gateway_service_grants");
  const poll = f.store.refresh(); assert.deepEqual(visible(), before);
  f.release("companion_gateway_status"); await poll; await drain();
  assert.deepEqual(visible(), before, "waiting for grants is background work, not a disabled-state pulse");
  f.release("companion_gateway_service_grants"); await drain();
  assert.ok(trace.every(value => JSON.stringify(value) === JSON.stringify(before)), JSON.stringify(trace));
  assert.deepEqual(visible(), before);
  unsubscribe(); close(); f.store.dispose();
});

test("production permission switch still shows busy for its explicit write, then confirmed state", async () => {
  const f = fixture(); const close = f.store.open(Symbol("quick")); await drain();
  const quick = component(f.store, "PhoneConnectionDialog.tsx", "PhoneConnectionContents");
  const permission = () => quick().find(node => node.type === "button" && node.props["aria-label"] === "devices.materialRead");
  assert.equal(permission().props["aria-checked"], false);
  f.gate("companion_gateway_service_set_grants"); permission().props.onClick(); await drain();
  assert.equal(permission().props.disabled, true); assert.equal(permission().props["aria-busy"], true);
  f.release("companion_gateway_service_set_grants"); await drain();
  assert.equal(permission().props["aria-busy"], false); assert.equal(permission().props["aria-checked"], true);
  assert.equal(f.calls.filter(call => call === "companion_gateway_service_set_grants").length, 1);
  close(); f.store.dispose();
});
