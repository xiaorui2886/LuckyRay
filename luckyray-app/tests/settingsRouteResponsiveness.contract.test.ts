import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Settings only starts route-specific probes for the active tab", async () => {
  const page = await source("src/features/settings/SettingsPage.tsx");

  assert.match(page, /activeTab\s*!==\s*"general"[\s\S]{0,240}refreshRuntimeStatus/u);
  assert.match(page, /activeTab\s*!==\s*"ai"[\s\S]{0,700}agentSearchLifecycle\.attach/u);
  assert.match(page, /activeTab\s*!==\s*"ai"[\s\S]{0,700}createDefaultDshHostClient/u);
  assert.match(page, /activeTab\s*!==\s*"storage"[\s\S]{0,240}loadStorageInfo/u);
});

test("inactive Settings panels are not mounted into the DOM", async () => {
  const page = await source("src/features/settings/SettingsPage.tsx");
  assert.match(page, /function Panel\([\s\S]{0,240}if\s*\(active\s*!==\s*tab\)\s*return null/u);
});

test("recursive storage and backup inspection runs off the Tauri command thread", async () => {
  const rust = await source("src-tauri/src/lib.rs");
  const storage = rust.slice(rust.indexOf("async fn get_storage_usage"), rust.indexOf("fn clear_dir_contents"));
  assert.match(storage, /spawn_blocking/u);
  const backups = rust.slice(rust.indexOf("async fn list_backups"), rust.indexOf("fn restore_backup"));
  assert.match(backups, /spawn_blocking/u);
});

test("Windows auto-launch registry access runs off the Tauri command thread", async () => {
  const rust = await source("src-tauri/src/lib.rs");
  const commands = rust.slice(
    rust.indexOf("async fn get_auto_launch_enabled"),
    rust.indexOf("// D41c:"),
  );

  assert.match(commands, /async fn get_auto_launch_enabled[\s\S]{0,320}spawn_blocking/u);
  assert.match(commands, /async fn set_auto_launch_enabled[\s\S]{0,320}spawn_blocking/u);
  assert.doesNotMatch(commands, /async fn get_auto_launch_enabled[\s\S]{0,240}Command::new/u);
  assert.doesNotMatch(commands, /async fn set_auto_launch_enabled[\s\S]{0,240}Command::new/u);
});

test("collection readiness does not acquire the transport authentication lock", async () => {
  const rust = await source("src-tauri/src/lib.rs");
  const command = rust.slice(
    rust.indexOf("fn get_collection_server_base_url"),
    rust.indexOf("fn get_local_transport_client_config"),
  );
  assert.match(command, /transport\.base_url\(\)/u);
  assert.doesNotMatch(command, /client_config\(\)/u);

  const transport = await source("src-tauri/src/local_transport/mod.rs");
  const method = transport.slice(transport.indexOf("pub fn base_url"), transport.indexOf("pub fn client_config"));
  assert.match(method, /self\.port/u);
  assert.doesNotMatch(method, /auth\.lock/u);
});
