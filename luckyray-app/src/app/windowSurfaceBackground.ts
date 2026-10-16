export type WindowSurfaceColor = [number, number, number, number];

export function parseWindowSurfaceColor(value: string): WindowSurfaceColor | null {
  const normalized = value.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(normalized);
  if (!match) return null;

  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((part) => `${part}${part}`).join("");
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
  return [red, green, blue, alpha];
}

type SurfaceColorReader = () => string;
type SurfaceColorWriter = (color: WindowSurfaceColor) => Promise<void>;

const readEffectiveAppBackground: SurfaceColorReader = () => (
  getComputedStyle(document.documentElement).getPropertyValue("--theme-app-bg")
);

const writeTauriWindowSurface: SurfaceColorWriter = async (color) => {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().setBackgroundColor(color);
};

export async function syncWindowSurfaceBackground(
  readColor: SurfaceColorReader = readEffectiveAppBackground,
  writeColor: SurfaceColorWriter = writeTauriWindowSurface,
): Promise<boolean> {
  const color = parseWindowSurfaceColor(readColor());
  if (!color || color[3] === 0) return false;
  try {
    await writeColor(color);
    return true;
  } catch {
    // Browser/unit fixtures and restricted WebViews have no native authority.
    return false;
  }
}
