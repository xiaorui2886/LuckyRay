import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoUrl = new URL("../", import.meta.url);

const source = (path: string) => readFile(new URL(path, repoUrl), "utf8");

test("auto-launch registry probes never create a visible console window in packaged builds", async () => {
  const lib = await source("src-tauri/src/lib.rs");

  // The only raw `reg` spawn lives inside the no-window helper; every
  // auto-launch site (query / add / delete) builds its command through it.
  assert.equal((lib.match(/Command::new\("reg"\)/g) || []).length, 1);
  assert.match(
    lib,
    /#\[cfg\(target_os = "windows"\)\]\s*\nfn reg_command\(\) -> Command \{[\s\S]*?Command::new\("reg"\)[\s\S]*?creation_flags\(CREATE_NO_WINDOW\)/,
  );
  assert.match(lib, /const CREATE_NO_WINDOW: u32 = 0x0800_0000;/);
  // 1 definition + 3 production call sites.
  assert.equal((lib.match(/reg_command\(\)/g) || []).length, 4);

  // No shell wrapper is introduced anywhere in the production app surface.
  assert.doesNotMatch(lib, /Command::new\("(cmd|cmd\.exe|powershell|powershell\.exe)"/);
});

test("the packaged service-probe path stays a truthful in-process read", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const page = await source("src/features/community/CollectorServiceStatus.tsx");

  // The collection service check remains a base-URL read of the running
  // transport; it must not spawn a shell or fake a cached status.
  assert.match(lib, /fn get_collection_server_base_url\(\s*transport: tauri::State<'_, local_transport::LocalTransportHandle>,\s*\) -> String \{\s*transport\.base_url\(\)\s*\}/);
  assert.match(page, /getCollectionServerBaseUrl/);
  assert.match(page, /ready \? t\("settings\.general\.collection\.service\.ready"\)/);
  assert.doesNotMatch(page, /\b(?:fetch|invoke|setInterval)\(/);
});
