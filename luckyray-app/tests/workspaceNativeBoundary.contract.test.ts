import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nativeWorkspaceWindowRole } from "../src/workspace/windowBootstrap.ts";

test("withdrawn product native routing recognizes Main exactly and rejects all child bootstraps", () => {
  assert.equal(nativeWorkspaceWindowRole("main"), "main");
  for (const label of ["", "main-other", "workspace-registered", "workspace", "workspace-", "extension", "forged"]) {
    assert.throws(() => nativeWorkspaceWindowRole(label), /workspace-unrecognized-window/);
  }
});

test("boot failure cannot mount the legacy App or install its bridge", async () => {
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(main, /import\s+App\s+from|<App\s*\/?>/);
  const failure = main.slice(main.indexOf("boot().catch"));
  assert.match(failure, /role="alert"/);
  assert.doesNotMatch(failure, /installLuckyRayBridge|import\s*\(/);
  const child = await readFile(new URL("../src/workspace/WorkspaceWindow.tsx", import.meta.url), "utf8");
  assert.match(child, /workspaceCommand<NativeWindowSession>\(\{op:'bootstrap'\}\)/);
});

test("system close reuses the guarded quit worker and main participates without workspace bindings", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const callback = native.slice(native.indexOf(".on_window_event"), native.indexOf(".plugin(tauri_plugin_dialog::init())", native.indexOf(".on_window_event")));
  assert.match(callback, /window\.label\(\) == "main"/);
  assert.match(callback, /CloseRequested[\s\S]*api\.prevent_close\(\);[\s\S]*request_normal_quit\(window\.app_handle\(\)\.clone\(\), false\)/);
  const workspace = await readFile(new URL("../src-tauri/src/workspace_windows.rs", import.meta.url), "utf8");
  const quit = workspace.slice(workspace.indexOf("pub(crate) fn prepare_application_quit"), workspace.indexOf("pub(crate) fn finish_quit_probe"));
  assert.match(quit, /quit_participants\(children, app\.get_webview_window\("main"\)\.is_some\(\)\)/);
  assert.doesNotMatch(quit, /main_views/);
  assert.match(quit, /Duration::from_secs\(15\)/);
  assert.match(quit, /responses\.values\(\)\.all\(\|value\|\*value==Some\(true\)\)/);
  assert.match(quit, /luckyray:workspace-quit-cancelled/);
});

test("workspace capabilities still exclude global SQL, filesystem and shortcut grants", async () => {
  const capability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/workspace.json", import.meta.url), "utf8"));
  assert.deepEqual(capability.windows, ["workspace-*"]);
  for (const permission of capability.permissions) assert.doesNotMatch(permission, /^(sql|fs|global-shortcut|dialog|opener):/);
});

test("the full production app command dispatcher is wrapped by the workspace restriction", async () => {
  const native = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const policy = await readFile(new URL("../src-tauri/src/workspace_command_policy.rs", import.meta.url), "utf8");
  const production = native.slice(native.indexOf("pub fn run()"), native.indexOf("fn prepared_update_record"));
  assert.equal((production.match(/\.invoke_handler\(/g) || []).length, 1);
  const table = production.match(/\.invoke_handler\(workspace_command_policy::guard\(tauri::generate_handler!\[([\s\S]*?)\]\)\)/)?.[1];
  assert.ok(table, "the outer guard must enclose the entire generated table");
  const commands = table.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("//")).map(line => line.replace(/,$/, "").split("::").pop()!);
  assert.ok(commands.length > 100);
  for (const name of ["knowledge_read_document", "get_local_transport_client_config", "write_notes_vault_markdown_file", "knowledge_activate_ui_source", "material_catalog_list_assets", "close_window"]) assert.ok(commands.includes(name), name);
  assert.equal(commands.filter(command => command === "workspace_window_command").length, 1);
  assert.match(policy, /const WORKSPACE_COMMAND: &str = "workspace_window_command";/);
  assert.match(policy, /!label\.starts_with\("workspace-"\) \|\| command == WORKSPACE_COMMAND/);
  assert.match(policy, /if !allowed\(invoke\.message\.webview_ref\(\)\.label\(\), invoke\.message\.command\(\)\) \{\s*invoke\.resolver\.reject\(DENIED\);\s*return true;\s*\}\s*handler\(invoke\)/);
  assert.doesNotMatch(policy.slice(0, policy.indexOf("#[cfg(test)]")), /workspace_fixture_report|allowlist|\.payload\(/);
});

test("isolated native fixture exercises the same production guard before a real legacy read and side effect", async () => {
  const native = await readFile(new URL("../src-tauri/src/workspace_fixture.rs", import.meta.url), "utf8");
  const fixture = await readFile(new URL("./fixtures/workspace-native.tsx", import.meta.url), "utf8");
  assert.match(native, /workspace_command_policy::guard\(tauri::generate_handler!\[[\s\S]*crate::knowledge_read_document,[\s\S]*workspace_fixture_legacy_probe/);
  assert.match(native, /legacy_probe_calls\.fetch_add\(1, Ordering::SeqCst\)/);
  assert.match(native, /"productionLegacyCommandsDenied","guardedLegacyProbeNotExecuted"/);
  assert.match(fixture, /String\(error\)==='workspace-command-not-allowed'/);
  assert.match(fixture, /invoke<number>\('workspace_fixture_legacy_probe'\)!==1/);
  assert.match(fixture, /invoke<number>\('workspace_fixture_legacy_probe'\)!==2/);
  assert.match(fixture, /productionLegacyCommandsDenied:true/);
});

test("new metadata routes require a live exact grant before and after native reads", async()=>{
 const native=await readFile(new URL("../src-tauri/src/workspace_windows.rs",import.meta.url),"utf8");
 for(const name of ['NoteAuthority','NoteMetadata','QueryNoteMetadata']){
  const begin=native.indexOf(`        WindowRequest::${name} {`);const end=native.indexOf('        WindowRequest::',begin+25);const branch=native.slice(begin,end);
  assert.equal((branch.match(/require_live_view\(&registry,caller.label\(\),&view\)\?/g)||[]).length,2,name);
 }
 assert.match(native,/if !entry.open\{return Err\("workspace-view-closed"/);
 assert.match(native,/if current!=\*view/);
});
test("favorite metadata never projects an unscoped legacy path as captured-vault truth",async()=>{
 const native=await readFile(new URL("../src-tauri/src/workspace_windows.rs",import.meta.url),"utf8");
 assert.match(native,/if !canonical&&unscoped\{return Err\("workspace-note-legacy-favorite-authority-unavailable"/);
 assert.match(native,/NoteFavoriteStatus::Known\(canonical\)/);
 assert.doesNotMatch(native,/NoteFavoriteStatus::Known\(canonical\s*\|\|/);
});
test("close capabilities revoke only after a validated committed close",async()=>{
 const native=await readFile(new URL("../src-tauri/src/workspace_windows.rs",import.meta.url),"utf8");
 const begin=native.indexOf('        WindowRequest::SetOpenViews');const branch=native.slice(begin,native.indexOf('        WindowRequest::Close {',begin));
 assert.match(branch,/commit_view_closes/);assert.ok(branch.indexOf('planned_closed_views')<branch.indexOf('entry.open=ids.contains'));
 assert.match(native,/known.contains\(&entry.view.id\)&&entry.open&&!ids.contains\(&entry.view.id\)/);
 const broker=await readFile(new URL("../src-tauri/src/workspace_actions.rs",import.meta.url),"utf8");const transaction=broker.slice(broker.indexOf('pub(crate) fn commit_view_closes'),broker.indexOf('pub(crate) fn remove_view'));
 assert.ok(transaction.indexOf('close()?')<transaction.indexOf('entries.retain'));
});
