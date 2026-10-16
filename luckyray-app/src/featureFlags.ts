// D72: Feature flag 系统
// 控制 React 化页面与旧 HTML 页面之间的切换。
// flag 默认全 false（所有页面走旧 HTML），通过 localStorage 或 URL 参数覆盖。

export type FeatureFlagKey = "tagsReact" | "settingsReact" | "aiReact" | "searchReact" | "materialsReact" | "notesReact" | "graphReact" | "navShellReact";

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export const DEFAULT_FLAGS: FeatureFlags = {
  tagsReact: true,       // D73 已实现
  settingsReact: true,   // D75 已实现
  aiReact: true,         // D77 已实现
  searchReact: true,     // D79 已实现
  materialsReact: true,  // D81 已实现
  notesReact: true,      // D83 已实现
  graphReact: true,      // D85 已实现
  navShellReact: true,   // D103 主线默认启用：桌面日常版暂不更新
};

const STORAGE_KEY = "luckyray-feature-flags";

// 从 localStorage 读取已保存的 flag 覆盖值
function loadStoredFlags(): Partial<FeatureFlags> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {}
  return {};
}

// 从 URL 查询参数读取 flag 覆盖（支持多参数：?flag=tagsReact=0&flag=settingsReact=0）
function loadUrlFlags(): Partial<FeatureFlags> {
  try {
    const params = new URLSearchParams(window.location.search);
    const result: Partial<FeatureFlags> = {};
    // 支持多 flag= 参数：?flag=tagsReact=0&flag=settingsReact=0
    const flagParams = params.getAll("flag");
    for (const fp of flagParams) {
      const parts = fp.split("=");
      if (parts.length === 1) {
        const key = parts[0] as FeatureFlagKey;
        if (key in DEFAULT_FLAGS) result[key] = true;
      } else if (parts.length === 2) {
        const key = parts[0] as FeatureFlagKey;
        if (key in DEFAULT_FLAGS) result[key] = parts[1] === "1" || parts[1] === "true";
      }
    }
    // 也支持 ?tagsReact=1 简写形式（保留兼容）
    for (const key of Object.keys(DEFAULT_FLAGS) as FeatureFlagKey[]) {
      const val = params.get(key);
      if (val !== null) {
        result[key] = val === "1" || val === "true";
      }
    }
    return result;
  } catch {}
  return {};
}

// 获取合并后的 flag 值：默认 < localStorage < URL 参数
let cachedFlags: FeatureFlags | null = null;

export function getFlags(): FeatureFlags {
  if (cachedFlags) return cachedFlags;
  const stored = loadStoredFlags();
  const url = loadUrlFlags();
  cachedFlags = { ...DEFAULT_FLAGS, ...stored, ...url };
  return cachedFlags;
}

// 检查单个 flag
export function isEnabled(key: FeatureFlagKey): boolean {
  return getFlags()[key];
}

// 运行时设置 flag（写入 localStorage 并更新缓存）
export function setFlag(key: FeatureFlagKey, value: boolean): void {
  const flags = getFlags();
  flags[key] = value;
  cachedFlags = flags;
  try {
    const stored = loadStoredFlags();
    stored[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {}
}

// 清除缓存（用于测试）
export function clearFlagCache(): void {
  cachedFlags = null;
}
