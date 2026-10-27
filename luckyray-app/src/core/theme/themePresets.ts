export type ThemePresetId =
  | "dark"
  | "light"
  | "ivory-editorial"
  | "rose-tea"
  | "github-dark"
  | "white-zero"
  | "bangladesh-green"
  | "lilac-milk"
  | "blue-whisper";

export type ThemePreset = {
  id: ThemePresetId;
  name: string;
  category: "dark" | "light";
  recommendedAccent: string;
  // App, sidebar, raised surface, foreground and recommended accent.
  previewTokens: readonly [string, string, string, string, string];
};

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "dark",
    name: "深色",
    category: "dark",
    recommendedAccent: "#7c8aff",
    previewTokens: ["#0a0a0c", "#111114", "#1a1a1f", "#f0f0f2", "#7c8aff"],
  },
  {
    id: "light",
    name: "浅色",
    category: "light",
    recommendedAccent: "#7c8aff",
    previewTokens: ["#f1f2f5", "#eceef3", "#ffffff", "#18191f", "#7c8aff"],
  },
  {
    id: "ivory-editorial",
    name: "象牙刊物",
    category: "light",
    recommendedAccent: "#b9824f",
    previewTokens: ["#f3ede3", "#efe7db", "#fffaf2", "#2f2a23", "#b9824f"],
  },
  {
    id: "rose-tea",
    name: "玫瑰茶雾",
    category: "light",
    recommendedAccent: "#c97991",
    previewTokens: ["#f3e8ec", "#eddee4", "#fff7f9", "#3f3036", "#c97991"],
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    category: "dark",
    recommendedAccent: "#58a6ff",
    previewTokens: ["#0b0f14", "#11161d", "#21262d", "#f0f6fc", "#58a6ff"],
  },
  {
    id: "white-zero",
    name: "白域 Zero",
    category: "light",
    recommendedAccent: "#18181b",
    previewTokens: ["#f5f5f5", "#fafafa", "#ffffff", "#111113", "#18181b"],
  },
  {
    id: "bangladesh-green",
    name: "孟加拉森绿",
    category: "dark",
    recommendedAccent: "#00b884",
    previewTokens: ["#021510", "#041e19", "#0a332a", "#eafff8", "#00b884"],
  },
  {
    id: "lilac-milk",
    name: "丁香雪乳",
    category: "light",
    recommendedAccent: "#6a7699",
    previewTokens: ["#e8ddd6", "#e5d8d0", "#f8eee8", "#4a5068", "#6a7699"],
  },
  {
    id: "blue-whisper",
    name: "蓝雾海岸",
    category: "light",
    recommendedAccent: "#4b90a5",
    previewTokens: ["#c7d1dc", "#c3ced8", "#e3eaf0", "#29475b", "#4b90a5"],
  },
] as const;

export function getThemePreset(id: string): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === id) || THEME_PRESETS[0];
}
