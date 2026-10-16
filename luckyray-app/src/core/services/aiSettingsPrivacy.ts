export function projectAiSettingsForFrontend<
  T extends { aiApiKey?: string | null; aiImageApiKey?: string | null },
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
    aiApiKeyConfigured: Boolean(aiApiKey),
    aiImageApiKey: null,
    aiImageApiKeyConfigured: Boolean(aiImageApiKey),
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
