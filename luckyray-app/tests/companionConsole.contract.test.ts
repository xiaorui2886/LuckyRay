import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as companionAccess from "../src/core/services/companionAccess.ts";
import * as gatewayService from "../src/core/services/companionGateway.ts";
import { createCompanionPresentationStore, companionGrantKey } from "../src/core/services/companionPresentationStore.ts";

import {
  assertCanonicalPairingEnvelope,
  createCompanionGatewayClient,
  createCompanionPairingSession,
  pairingMemoryReducer,
  pairingSecondsRemaining,
  type PairingPresentation,
} from "../src/core/services/companionGateway.ts";

const presentation: PairingPresentation = {
  pairingId: "ticket-fixture",
  v: 1,
  name: "LuckyRay Desktop",
  instance: "desktop-0123456789abcdef0123456789abcdef",
  ip: "192.168.10.20",
  port: 48180,
  secret: "fixture-only-pairing-bootstrap",
  fp: "a".repeat(64),
  expiresAt: "2030-01-01T00:02:00Z",
  qrSize: 29,
  qrPath: "M0 0h1v1h-1z",
};

// Execute the real panel's hooks and JSX handlers without a browser or screen.
// Only React scheduling and the IPC transport are replaced; the service,
// pairing lifetime, reducer and component callbacks are production code.
function panelHarness(invoke: Parameters<typeof createCompanionGatewayClient>[0]) {
  const slots: any[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const sameDeps = (left: unknown[] | undefined, right: unknown[]) => left?.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useReducer(reducer: (state: unknown, action: unknown) => unknown, initial: unknown) {
      const [state, setState] = hooks.useState(initial);
      return [state, (action: unknown) => setState((current: unknown) => reducer(current, action))];
    },
    useRef(value: unknown) {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const t = (key: string) => key;
  const jsx = (type: any, props: any) => typeof type === "function" ? type(props) : ({ type, props });
  const client = createCompanionGatewayClient(invoke);
  const store = createCompanionPresentationStore(client);
  const authorization: any = {};
  const authorizationSource = readFileSync(new URL("../src/features/settings/PhoneAuthorizationChoice.tsx", import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(authorizationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)((name: string) => {
    if (name === "react") return { useId: () => "synthetic-choice" };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith("/i18n/index")) return { defineMessages: (value: unknown) => value, useMessages: () => ({ t }) };
    if (name.endsWith(".css")) return {};
    throw new Error(`unexpected authorization dependency ${name}`);
  }, authorization);
  const source = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: { default?: () => unknown } = {};
  new Function("require", "exports", "window", "document", compiled)((name: string) => {
    if (name === "react") return hooks;
    if (name.endsWith("/companionAccess")) return companionAccess;
    if (name.endsWith("/PhoneAccessManager")) return { default: () => null };
    if (name.endsWith("/PhoneAuthorizationChoice")) return authorization;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith("/companionGateway")) return gatewayService;
    if (name.endsWith("/companionPresentationStore")) return { companionGrantKey };
    if (name.endsWith("/CompanionPresentation")) return {
      useCompanionStore: () => store,
      useCompanionView: () => {
        const owner = hooks.useRef(Symbol("advanced-panel")).current;
        hooks.useEffect(() => store.open(owner, true), [owner]);
        const state = store.getSnapshot();
        return { state, owner, seconds: state.pairing ? pairingSecondsRemaining(state.pairing) : 0 };
      },
    };
    if (name.endsWith("/applicationModalIsolation")) return {
      useApplicationModalSurface: (_open: boolean, close: () => void) => ({
        surfaceRef: hooks.useRef(null), onBackdropPointerDown() {},
        onSurfaceKeyDown: (event: any) => { if (event.key === "Escape") { event.preventDefault(); close(); } },
      }),
    };
    if (name.endsWith("/i18n/index")) return { defineMessages: (value: unknown) => value, useMessages: () => ({ locale: "zh-CN", t }) };
    throw new Error(`unexpected panel dependency ${name}`);
  }, exports, { setInterval: () => 1, clearInterval() {} }, { activeElement: { focus() {} } });
  let tree: any;
  function render() {
    cursor = 0;
    tree = exports.default!();
    const pending = effects;
    effects = [];
    pending.forEach((effect) => effect());
  }
  function find(predicate: (node: any) => boolean, node = tree): any {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) return node.map((child) => find(predicate, child ?? null)).find(Boolean);
    if (predicate(node)) return node;
    return find(predicate, node.props?.children ?? null);
  }
  return {
    async settle() { for (let pass = 0; pass < 3; pass++) { render(); await new Promise(setImmediate); } render(); },
    button(key: string) { return find((node) => node.type === "button" && (node.props.children === key || node.props["aria-label"] === key)); },
    chooseManual() { find((node) => node.type === "input" && node.props.type === "radio" && node.props.value === "manual").props.onChange(); },
    choiceInsideDialog() { const dialog = find((node) => node.props?.["aria-labelledby"] === "companion-pair-title"); return Boolean(dialog && find((node) => node.type === "input" && node.props.type === "radio", dialog)); },
    dialog() { return find((node) => node.props?.["aria-labelledby"] === "companion-pair-title"); },
    recoveryDialog() { return find((node) => node.props?.["aria-labelledby"] === "companion-recover-title"); },
    escape() { find((node) => node.props?.["aria-labelledby"] === "companion-pair-title").props.onKeyDown({ key: "Escape", preventDefault() {} }); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); store.dispose(); },
  };
}

function panelTransport(cancel: () => unknown = () => true) {
  const cancelled: string[] = [];
  return {
    cancelled,
    async invoke(command: string, args?: Record<string, unknown>) {
      if (command === "companion_gateway_status") return { state: "running", bindAddress: presentation.ip, port: presentation.port, desktopInstanceId: presentation.instance, certificateFingerprint: presentation.fp };
      if (command === "companion_gateway_list_interfaces") return [{ interfaceId: "fixture", address: presentation.ip, name: "LAN", prefixLength: 24 }];
      if (command === "companion_gateway_list_devices" || command === "companion_gateway_list_audit") return [];
      if (command === "companion_gateway_issue_pairing") return presentation;
      if (command === "companion_gateway_cancel_pairing") { cancelled.push(String(args?.pairingId)); return cancel(); }
      throw new Error("unexpected command");
    },
  };
}

for (const action of ["pair.close", "pair.done", "Escape"]) {
  test(`real panel ${action} waits for scoped server cancellation before closing`, async () => {
    let finishCancel!: (value: boolean) => void;
    const transport = panelTransport(() => new Promise<boolean>((resolve) => { finishCancel = resolve; }));
    const panel = panelHarness(transport.invoke);
    await panel.settle();
    panel.button("gateway.pair").props.onClick();
    await panel.settle();
    assert.equal(panel.choiceInsideDialog(), true, "consent controls must be inside the active focus-trapped dialog");
    assert.equal(panel.button("pairChoose").props.disabled, true);
    panel.chooseManual();
    await panel.settle();
    panel.button("pairManual").props.onClick();
    await panel.settle();
    assert.ok(panel.dialog());
    if (action === "Escape") panel.escape();
    else panel.button(action).props.onClick();
    await panel.settle();
    assert.ok(panel.dialog(), "do not claim cancellation before the server replies");
    assert.deepEqual(transport.cancelled, [presentation.pairingId]);
    finishCancel(true);
    await panel.settle();
    assert.equal(Boolean(panel.dialog()), false);
    panel.unmount();
  });
}

test("real panel keeps cancellation failure visible and permits retry", async () => {
  let fail = true;
  const transport = panelTransport(() => { if (fail) throw { code: "gateway-transition-in-progress" }; return true; });
  const panel = panelHarness(transport.invoke);
  await panel.settle();
  panel.button("gateway.pair").props.onClick();
  await panel.settle();
  panel.chooseManual();
  await panel.settle();
  panel.button("pairManual").props.onClick();
  await panel.settle();
  panel.button("pair.close").props.onClick();
  await panel.settle();
  assert.ok(panel.dialog());
  assert.equal(panel.button("pair.close").props.disabled, false);
  fail = false;
  panel.button("pair.close").props.onClick();
  await panel.settle();
  assert.equal(Boolean(panel.dialog()), false);
  assert.equal(transport.cancelled.length, 2);
  panel.unmount();
});

test("real panel Escape during regeneration cancels the late response and stays closed", async () => {
  const transport = panelTransport();
  let finishIssue!: (value: PairingPresentation) => void;
  const panel = panelHarness(async (command, args) => {
    if (command === "companion_gateway_issue_pairing" && args?.replaceExisting) {
      return new Promise<PairingPresentation>((resolve) => { finishIssue = resolve; });
    }
    return transport.invoke(command, args);
  });
  await panel.settle();
  panel.button("gateway.pair").props.onClick();
  await panel.settle();
  panel.chooseManual();
  await panel.settle();
  panel.button("pairManual").props.onClick();
  await panel.settle();
  panel.button("pair.regenerate").props.onClick();
  await panel.settle();
  assert.ok(panel.dialog(), "pending regeneration keeps the close and Escape controls reachable");
  panel.escape();
  await panel.settle();
  assert.equal(Boolean(panel.dialog()), false);
  finishIssue({ ...presentation, pairingId: "replacement-fixture" });
  await panel.settle();
  assert.equal(Boolean(panel.dialog()), false);
  assert.deepEqual(transport.cancelled, [presentation.pairingId, "replacement-fixture"]);
  panel.unmount();
});

test("old close completion preserves a newly issued presentation and its cleanup", async () => {
  let finishClose!: (value: boolean) => void;
  let next = presentation;
  const cancelled: string[] = [];
  const client = createCompanionGatewayClient(async (command, args) => {
    if (command === "companion_gateway_issue_pairing") return next;
    if (command === "companion_gateway_cancel_pairing") {
      cancelled.push(String(args?.pairingId));
      if (cancelled.length === 1) return new Promise<boolean>((resolve) => { finishClose = resolve; });
      return true;
    }
    throw new Error("unexpected command");
  });
  const session = createCompanionPairingSession(client);
  await session.issue(false);
  const closing = session.close(presentation.pairingId);
  next = { ...presentation, pairingId: "new-fixture" };
  const newer = await session.issue(true);
  finishClose(false);
  await closing;
  assert.equal(pairingMemoryReducer(newer, { type: "close", pairingId: presentation.pairingId })?.pairingId, next.pairingId);
  await session.dispose();
  assert.deepEqual(cancelled, [presentation.pairingId, next.pairingId]);
});

test("real panel shows failed saved endpoint, retries that address and offers explicit Stop", async () => {
  const transport = panelTransport();
  const calls: string[] = [];
  const panel = panelHarness(async (command, args) => {
    if (command === "companion_gateway_status") return { state: "resume-failed", bindAddress: presentation.ip, port: presentation.port, code: "gateway-bind-conflict" };
    if (command === "companion_gateway_start") { calls.push(String(args?.bindAddress)); throw { code: "gateway-bind-conflict" }; }
    return transport.invoke(command, args);
  });
  await panel.settle();
  assert.equal(panel.button("gateway.retry").props.disabled, false);
  assert.equal(panel.button("gateway.stop").props.disabled, false);
  panel.button("gateway.retry").props.onClick();
  await panel.settle();
  assert.deepEqual(calls, [presentation.ip]);
  assert.equal(panel.button("gateway.retry").props.disabled, false);
  panel.unmount();
});

test("endpoint change requires a separate confirmation and cancellation sends no IPC", async () => {
  const transport = panelTransport();
  const recoveries: unknown[] = [];
  const panel = panelHarness(async (command, args) => {
    if (command === "companion_gateway_status") return { state: "resume-failed", bindAddress: presentation.ip, port: presentation.port, code: "gateway-bind-access-denied", bindFailure: { stage: "bind", kind: "access-denied", osCode: 10013, attempts: 1 } };
    if (command === "companion_gateway_recover_endpoint") { recoveries.push(args); return { state: "running", bindAddress: presentation.ip, port: 49123 }; }
    return transport.invoke(command, args);
  });
  await panel.settle();
  assert.equal(panel.button("recovery.select").props.disabled, false);
  panel.button("recovery.select").props.onClick();
  await panel.settle();
  assert.ok(panel.recoveryDialog()); assert.deepEqual(recoveries, []);
  panel.button("revoke.cancel").props.onClick(); await panel.settle();
  assert.equal(panel.recoveryDialog(), undefined); assert.deepEqual(recoveries, []);
  panel.button("recovery.select").props.onClick(); await panel.settle();
  panel.button("recovery.confirm").props.onClick(); await panel.settle();
  assert.deepEqual(recoveries, [{ expectedAddress: presentation.ip, expectedPort: presentation.port, confirmed: true }]);
  panel.unmount();
});

test("unavailable interface and unrelated failures do not offer blind endpoint changes", async () => {
  const transport = panelTransport();
  for (const code of ["gateway-listener-config-unavailable", "gateway-bind-address-unavailable", "gateway-listener-unavailable"]) {
    const panel = panelHarness(async (command, args) => command === "companion_gateway_status" ? { state: "resume-failed", bindAddress: presentation.ip, port: presentation.port, code } : transport.invoke(command, args));
    await panel.settle(); assert.equal(panel.button("recovery.select"), undefined); panel.unmount();
  }
});

test("canonical QR envelope is the exact Mobile-compatible seven-field v1 shape", () => {
  assert.deepEqual(assertCanonicalPairingEnvelope(presentation), {
    v: 1,
    name: presentation.name,
    instance: presentation.instance,
    ip: presentation.ip,
    port: presentation.port,
    secret: presentation.secret,
    fp: presentation.fp,
  });
  assert.throws(() => assertCanonicalPairingEnvelope({ ...presentation, v: 2 }));
  assert.throws(() => assertCanonicalPairingEnvelope({ ...presentation, alias: "forbidden" }));
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.20"]) {
    assert.equal(assertCanonicalPairingEnvelope({ ...presentation, ip }).ip, ip);
  }
  for (const ip of ["10.", "192.168.999.999-extra", "127.0.0.1", "0.0.0.0", "8.8.8.8", "172.32.0.1"]) {
    assert.throws(() => assertCanonicalPairingEnvelope({ ...presentation, ip }), ip);
  }
});

test("pairing presentation is memory-only and clears at every lifecycle boundary", () => {
  const active = pairingMemoryReducer(null, { type: "issued", presentation });
  assert.equal(active?.secret, presentation.secret);
  for (const type of ["close", "expired", "gateway-stopped", "gateway-restarted", "left-panel"] as const) {
    assert.equal(pairingMemoryReducer(active, { type }), null, type);
  }
  assert.equal(pairingSecondsRemaining(presentation, Date.parse("2030-01-01T00:01:59Z")), 1);
  assert.equal(pairingSecondsRemaining(presentation, Date.parse("2030-01-01T00:03:00Z")), 0);
});

test("typed client owns bounded management commands without a content API", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const client = createCompanionGatewayClient(async (command, args) => {
    calls.push({ command, args });
    if (command === "companion_gateway_list_interfaces") return [];
    if (command === "companion_gateway_list_devices") return [];
    if (command === "companion_gateway_list_audit") return [];
    return { state: "disabled", desktopInstanceId: "desktop-fixture", certificateFingerprint: "f".repeat(64) };
  });
  await client.status();
  await client.listInterfaces();
  await client.listDevices();
  await client.listAudit();
  assert.deepEqual(calls.map((call) => call.command), [
    "companion_gateway_status",
    "companion_gateway_list_interfaces",
    "companion_gateway_list_devices",
    "companion_gateway_list_audit",
  ]);
  assert.equal(calls.some((call) => /material|knowledge|canvas|lightseek|run/i.test(call.command)), false);
});

test("closing a pairing uses its local ticket identity without sending QR authority", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const client = createCompanionGatewayClient(async (command, args) => {
    calls.push({ command, args });
    return true;
  });
  await client.cancelPairing("ticket-fixture");
  assert.deepEqual(calls, [{ command: "companion_gateway_cancel_pairing", args: { pairingId: "ticket-fixture" } }]);
});

test("leaving the panel cancels an issuance that completes after cleanup", async () => {
  let finishIssue!: (value: PairingPresentation) => void;
  const cancelled: string[] = [];
  const client = createCompanionGatewayClient(async (command, args) => {
    if (command === "companion_gateway_issue_pairing") return new Promise<PairingPresentation>((resolve) => { finishIssue = resolve; });
    if (command === "companion_gateway_cancel_pairing") { cancelled.push(String(args?.pairingId)); return true; }
    throw new Error("unexpected command");
  });
  const session = createCompanionPairingSession(client);
  const pending = session.issue(false);
  await session.dispose();
  finishIssue(presentation);
  assert.equal(await pending, null);
  assert.deepEqual(cancelled, [presentation.pairingId]);
});

test("closing during regeneration cancels its late ticket without reopening the dialog", async () => {
  let finishIssue!: (value: PairingPresentation) => void;
  const cancelled: string[] = [];
  let issueCount = 0;
  const client = createCompanionGatewayClient(async (command, args) => {
    if (command === "companion_gateway_issue_pairing") {
      if (++issueCount === 1) return presentation;
      return new Promise<PairingPresentation>((resolve) => { finishIssue = resolve; });
    }
    if (command === "companion_gateway_cancel_pairing") { cancelled.push(String(args?.pairingId)); return true; }
    throw new Error("unexpected command");
  });
  const session = createCompanionPairingSession(client);
  await session.issue(false);
  const pending = session.issue(true);
  await session.close(presentation.pairingId);
  finishIssue({ ...presentation, pairingId: "replacement-fixture" });
  assert.equal(await pending, null);
  assert.deepEqual(cancelled, [presentation.pairingId, "replacement-fixture"]);
});

test("Settings console is accessible, responsive, and never persists pairing authority", () => {
  const panel = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/core/services/companionGateway.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/features/settings/settings.css", import.meta.url), "utf8");

  assert.match(settings, /key:\s*"companion",\s*labelKey:\s*"settings\.tab\.companion"/);
  assert.match(settings, /activeTab\s*===\s*"companion"[\s\S]*CompanionGatewayPanel/);
  assert.match(panel, /role="dialog"/);
  assert.match(panel, /aria-modal="true"/);
  assert.match(panel, /aria-label=\{t\("pair\.close"\)\}/);
  assert.match(panel, /onKeyDown/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.companion-pairing-dialog/);
  assert.doesNotMatch(`${panel}\n${service}`, /localStorage|sessionStorage|console\.(?:log|info|warn|error)|location\.(?:hash|search)/);
});

// MOBILE-CONNECTION-R2: the Desktop must expose a REAL copy entry matching the
// phone's "其他配对方式" path — reusing the SAME one-time envelope, never a
// second format and never a persisted secret.
test("pairing copy entry reuses the canonical envelope and writes only on demand", () => {
  const panel = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/core/services/companionGateway.ts", import.meta.url), "utf8");

  // The user-facing entry exists and is wired to a real handler.
  assert.match(panel, /t\("pair\.copy"\)/);
  assert.match(panel, /onClick=\{\(\)\s*=>\s*void copyPairingInfo\(\)\}/);
  // It copies exactly the canonical seven fields the QR carries.
  assert.match(panel, /assertCanonicalPairingEnvelope\(pairing\)/);
  // Clipboard use is write-only (never a read of someone else's clipboard)…
  assert.match(panel, /navigator\.clipboard\.writeText\(JSON\.stringify\(assertCanonicalPairingEnvelope\(pairing\)\)\)/);
  assert.doesNotMatch(`${panel}\n${service}`, /navigator\.clipboard\.read/);
  // …and the one-time secret is never put into component state, storage, or a log.
  assert.doesNotMatch(panel, /useState[^\n]*secret|setItem|JSON\.stringify\(pairing\)(?![\s\S]{0,40}writeText)/);
  // The authority layer keeps no clipboard capability at all.
  assert.doesNotMatch(service, /clipboard/);
});

// R2-REPAIR-R3 D1: the copy feedback belongs to the ticket it was produced
// for. A regenerated/closed ticket must not inherit it, and a late clipboard
// completion must not label a newer ticket as copied.
test("copy feedback is scoped to its pairing ticket and cannot leak across generations", () => {
  const panel = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");

  // The state carries the ticket identity, not a bare status.
  assert.match(panel, /const \[copyState, setCopyState\] = useState<\{ pairingId: string; state: "copied" \| "failed" \} \| null>\(null\)/);
  // A new/cleared ticket resets the feedback (regenerate / close / expire).
  assert.match(panel, /pairingRef\.current = pairing/);
  assert.match(panel, /useEffect\(\(\) => \{ setCopyState\(null\); \}, \[pairing\]\)/);
  // The async result is only accepted while its own ticket is still current.
  assert.match(panel, /if \(pairingRef\.current\?\.pairingId === pairingId\) setCopyState\(\{ pairingId, state: "copied" \}\)/);
  assert.match(panel, /if \(pairingRef\.current\?\.pairingId === pairingId\) setCopyState\(\{ pairingId, state: "failed" \}\)/);
  // Both messages are gated on the CURRENT ticket, so a stale one can never render.
  assert.equal((panel.match(/copyState\?\.pairingId === pairing\.pairingId/g) ?? []).length, 2);
  // Copying a superseded ticket during regeneration is not offered.
  assert.match(panel, /disabled=\{Boolean\(busy\) \|\| closingPairing \|\| !pairing\} onClick=\{\(\) => void copyPairingInfo\(\)\}/);
});

test("console exposes one safe interface selector and bounded lifecycle, device, audit actions", () => {
  const panel = readFileSync(new URL("../src/features/settings/CompanionGatewayPanel.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src-tauri/src/companion_gateway.rs", import.meta.url), "utf8");
  const commands = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(panel, /interfaces\.map[\s\S]*option value=\{item\.address\}/);
  assert.match(panel, /client\.start\(selectedAddress\)/);
  assert.match(backend, /validate_management_bind_address\(&bind_address, &interfaces\)/);
  assert.match(backend, /gateway\.inner\(\)\.start\(&bind_address, None\)/);
  assert.match(backend, /gateway\.inner\(\)\.restart\(&bind_address, None\)/);
  assert.doesNotMatch(backend, /companion_gateway_(?:start|restart)\([\s\S]{0,220}port:\s*Option<u16>/);
  assert.doesNotMatch(panel, /placeholder=["'][^"']*(?:IP|地址|bind)/i);
  for (const key of ["gateway.start", "gateway.stop", "gateway.restart", "gateway.pair", "pair.regenerate", "devices.title", "security.title", "firewall.description"]) {
    assert.match(panel, new RegExp(`t\\("${key.replace(".", "\\.")}\"\\)`));
  }
  assert.doesNotMatch(`${panel}\n${backend}\n${commands}`, /firewall_(?:add|create|write)_rule|netsh\s+advfirewall/i);
  const store = readFileSync(new URL("../src/core/services/companionPresentationStore.ts", import.meta.url), "utf8");
  assert.match(store, /catch \(error\) \{ publish\(\{ status: null, error \}\); \}/);
  assert.match(panel, /useApplicationModalSurface<HTMLDivElement>\(pairViewOpen/);
  assert.match(store, /ownedSession\.issue\(replace, authorizationMode\)/);
  for (const command of [
    "companion_gateway_status",
    "companion_gateway_start",
    "companion_gateway_stop",
    "companion_gateway_restart",
    "companion_gateway_issue_pairing",
    "companion_gateway_cancel_pairing",
    "companion_gateway_list_interfaces",
    "companion_gateway_list_devices",
    "companion_gateway_list_audit",
    "companion_gateway_revoke_device",
  ]) {
    assert.match(commands, new RegExp(command));
  }
});
