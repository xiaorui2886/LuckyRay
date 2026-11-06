export function projectAiSettingsForFrontend<
  T extends { aiApiKey?: string | null; aiImageApiKey?: string | null; aiApiKeyConfigured?: boolean; aiImageApiKeyConfigured?: boolean },
>(settings: T): Omit<T, "aiApiKey" | "aiImageApiKey"> & {
  aiApiKey: null;
  aiApiKeyConfigured: boolean;
  aiImageApiKey: null;
  aiImageApiKeyConfigured: boolean;
} {
  const { aiApiKey, aiImageApiKey, ...safe } = settings;
  return {
    ...safe,
    aiApiKey: null,
    aiApiKeyConfigured: aiApiKey == null ? Boolean(settings.aiApiKeyConfigured) : Boolean(aiApiKey),
    aiImageApiKey: null,
    aiImageApiKeyConfigured: aiImageApiKey == null ? Boolean(settings.aiImageApiKeyConfigured) : Boolean(aiImageApiKey),
  };
}

export function sanitizeAiSettingsForBrowserStorage<
  T extends Record<string, string | number | boolean>,
>(settings: T): T {
  return {
    ...settings,
    "ai.apiKey": "",
  };
}
