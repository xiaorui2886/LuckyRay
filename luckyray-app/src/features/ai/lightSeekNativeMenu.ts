import { Image } from "@tauri-apps/api/image";
import { IconMenuItem, Menu } from "@tauri-apps/api/menu";

export const LSH_TOOL_PATHS = {
  check: "m3 8 3 3 7-7 M13 8v5H2V2h7",
  about: "M14 8a6 6 0 1 1-12 0 6 6 0 1 1 12 0 M8 7v4 M8 4.5v.5",
  update: "M2 12h12 M8 2v8 m-3-3 3 3 3-3",
  restart: "M13 6a5.5 5.5 0 1 0 0 4 M10 3h3v3",
};
type Tool = keyof typeof LSH_TOOL_PATHS;

/** OS popup above the native child; icons share the browser menu's vector paths.
 * Windows owns popup colors/metrics. No Webview or app theme is recreated here. */
export async function createLightSeekNativeMenu(text: (tool: Tool) => string, action: (tool: Tool) => void) {
  const items: IconMenuItem[] = [];
  try {
    for (const tool of ["check", "about", "update", "restart"] as const) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Menu icon canvas unavailable");
      context.scale(2, 2); context.strokeStyle = "#777777";
      context.lineWidth = 1.5; context.lineCap = "round"; context.lineJoin = "round";
      context.stroke(new Path2D(LSH_TOOL_PATHS[tool]));
      const pixels = context.getImageData(0, 0, 32, 32).data;
      const icon = await Image.new(new Uint8Array(pixels), 32, 32);
      try { items.push(await IconMenuItem.new({ id: `lsh-${tool}`, text: text(tool), icon, action: () => action(tool) })); }
      finally { await icon.close(); }
    }
    const menu = await Menu.new({ id: "lsh-tools", items: [items[0], items[1], items[2], { item: "Separator" }, items[3]] });
    return {
      menu, restart: items[3],
      async update(text: (tool: Tool) => string) {
        await Promise.all((["check", "about", "update", "restart"] as const).map((tool, i) => items[i].setText(text(tool))));
      },
      async close() { await menu.close(); await Promise.all(items.map(item => item.close())); },
    };
  } catch (error) { await Promise.all(items.map(item => item.close())); throw error; }
}
