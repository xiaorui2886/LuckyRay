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
  previewTokens: string[];
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
    previewTokens: ["#f5f5f7", "#ededf1", "#ffffff", "#18191f", "#7c8aff"],
  },
  {
    id: "ivory-editorial",
    name: "象牙刊物",
    category: "light",
    recommendedAccent: "#b9824f",
    previewTokens: ["#f6f1e8", "#fffaf2", "#efe5d6", "#2f2a23", "#b9824f"],
  },
  {
    id: "rose-tea",
    name: "玫瑰茶雾",
    category: "light",
    recommendedAccent: "#c97991",
    previewTokens: ["#f6edf0", "#f1e3e8", "#ead5dc", "#3f3036", "#c97991"],
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    category: "dark",
    recommendedAccent: "#58a6ff",
    previewTokens: ["#0d1117", "#161b22", "#21262d", "#f0f6fc", "#58a6ff"],
  },
  {
    id: "white-zero",
    name: "白域 Zero",
    category: "light",
    recommendedAccent: "#18181b",
    previewTokens: ["#ffffff", "#fbfbfb", "#eeeeee", "#111113", "#18181b"],
  },
  {
    id: "bangladesh-green",
    name: "孟加拉森绿",
    category: "dark",
    recommendedAccent: "#00b884",
    previewTokens: ["#031a16", "#06251f", "#0a332a", "#eafff8", "#00b884"],
  },
  {
    id: "lilac-milk",
    name: "丁香雪乳",
    category: "light",
    recommendedAccent: "#6a7699",
    previewTokens: ["#ece1d9", "#f5ebe4", "#ddc4b9", "#4a5068", "#6a7699"],
  },
  {
    id: "blue-whisper",
    name: "蓝雾海岸",
    category: "light",
    recommendedAccent: "#4b90a5",
    previewTokens: ["#ced7e0", "#dbe3ea", "#b8c9d4", "#29475b", "#4b90a5"],
  },
] as const;

export function getThemePreset(id: string): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === id) || THEME_PRESETS[0];
}
