// Real Tauri menu/image IPC with an existing native child, in a random fixture
// profile. Does not open a popup or operate any desktop/window input.
import { invoke } from "@tauri-apps/api/core";
import { createLightSeekNativeMenu } from "../../src/features/ai/lightSeekNativeMenu";

const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
async function main() {
  await invoke("extension_fixture_add_child");
  const owned = await createLightSeekNativeMenu(tool => tool, () => { throw Error("Unexpected menu action"); });
  const rid = owned.menu.rid;
  const items = await owned.menu.items();
  check(items.length === 4, "Wrong native menu item count");
  check(items.filter(item => item.kind === "Icon").length === 3, "Windows icon items missing");
  for (let i = 0; i < 5; i++) {
    await owned.restart.setEnabled(i % 2 === 0);
    check(await owned.restart.isEnabled() === (i % 2 === 0), "Native enabled state diverged");
    await owned.update(tool => `本地 ${tool}`);
    check(owned.menu.rid === rid, "Menu was recreated");
  }
  const itemReport = items.map(item => ({ id: item.id, kind: item.kind }));
  await Promise.all(items.map(item => item.close()));
  await owned.close();
  await invoke("extension_fixture_report", { name: "native-menu-main", report: {
    ok: true, menuId: "lsh-tools", itemReport, reused: 5,
    boundary: "Real menu/image IPC after child creation; popup visual and real DSH continuity are not exercised.",
  } });
}
void (location.pathname.includes("child")
  ? invoke("extension_fixture_report", { name: "native-menu-child", report: { ok: true, childLoaded: true } })
  : main()).catch(async error => {
    await invoke("extension_fixture_report", { name: "native-menu-main", report: { ok: false, error: String(error) } });
  });
