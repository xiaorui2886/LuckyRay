// Self-running native IPC regression in the existing random fixture profile.
// No CDP, UI injection, user profile, or network requests.
import { invoke } from "@tauri-apps/api/core";
import { createExtensionPackageService } from "../../src/core/extensions/packages";
import { runPlugin } from "../../src/core/extensions/runtime";

const check = (ok: unknown, reason: string) => { if (!ok) throw Error(reason); };
const manage = createExtensionPackageService();
const pkg = {
  manifest: { schemaVersion: 1, id: "fixture.multiwebview", name: "IPC fixture", version: "1.0.0", type: "script", entry: "main.js", minHostVersion: "1.9.2", apiVersion: 1, requiredModules: [], optionalModules: [] },
  resource: { code: "LuckyRay.register(async () => ({ title: 'IPC works' }));", requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [{ id: "open", label: "Open", kind: "command" }] },
};
async function main() {
  const before = await manage.refresh();
  await invoke("extension_fixture_add_child");
  // Native child creation changes the Tauri window type; even a hidden child
  // must not prevent the main renderer from managing/using its packages.
  const after = await manage.refresh();
  check(before.revision === after.revision, "list changed revision");
  let state = await manage.install(JSON.stringify(pkg), after.revision);
  state = await manage.grant(pkg.manifest.id, [], state.revision);
  state = await manage.enable(pkg.manifest.id, state.revision);
  check(state.packages.some(p => p.enabled), "enable failed");
  const result = await runPlugin(pkg.manifest.id, { materialIds: [], canvasIds: [], writes: false, knowledge: null, theme: {} }, { contribution: "open", action: "open", fields: {} }, new AbortController().signal, () => {});
  check(result.ui.title === "IPC works", "real plugin entry did not run");
  // Authorization refusal proves the actual runtime command body was reached,
  // without granting the fixture access to any user objects.
  const error = await invoke("extension_runtime", { request: JSON.stringify({ op: "poll", token: "not-a-session" }) }).then(() => "unexpected-success", String);
  check(!error.includes("WebviewWindow") && error !== "unexpected-success", "runtime extraction failed");
  const bad = structuredClone(pkg); bad.manifest.apiVersion = 999;
  const refused = await manage.update(JSON.stringify(bad), state.revision).then(() => false, () => true);
  check(refused, "bad update accepted");
  const retained = await manage.refresh();
  check(retained.revision === state.revision && retained.packages[0]?.package.manifest.version === "1.0.0", "failed update damaged state");
  pkg.manifest.version = "1.0.1";
  state = await manage.update(JSON.stringify(pkg), state.revision);
  state = await manage.disable(pkg.manifest.id, state.revision);
  const reloaded = createExtensionPackageService();
  check((await reloaded.refresh()).packages[0]?.package.manifest.version === "1.0.1", "new client lost update");
  await manage.uninstall(pkg.manifest.id, state.revision);
  await invoke("extension_fixture_report", { name: "multiwebview-main", report: { ok: true, runtimeCommandError: error } });
}
async function child() {
  const results = [];
  for (const command of ["manage_extension_packages", "extension_runtime"]) {
    const error = await invoke(command, { request: JSON.stringify({ op: "list" }) }).then(() => "unexpected-success", String);
    check(error === (command === "manage_extension_packages" ? "extension-host-window-required" : "plugin-host-window-required"), `${command}: ${error}`);
    results.push({ command, error });
  }
  await invoke("extension_fixture_report", { name: "multiwebview-child", report: { ok: true, results } });
}
void (location.pathname.includes("child") ? child() : main()).catch(async error => {
  await invoke("extension_fixture_report", { name: location.pathname.includes("child") ? "multiwebview-child" : "multiwebview-main", report: { ok: false, error: String(error) } });
});
