export type AiProviderMeta = {
  label: string;
  baseUrl: string;
  models: string[];
  defaultProtocol: AiApiProtocol;
  protocols: AiApiProtocol[];
};

export type AiApiProtocol = "openai-compatible" | "anthropic-messages";

export type AiProviderPreset = {
  protocol: AiApiProtocol;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
};

export type AiModelOption = {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
};

export const CUSTOM_AI_MODEL_OPTION = "自定义...";
export const MINIMAX_GLOBAL_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_CHINA_BASE_URL = "https://api.minimaxi.com/v1";

export const AI_PROVIDER_CONFIG: Record<string, AiProviderMeta> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible", "anthropic-messages"],
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.1", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible"],
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
    defaultProtocol: "anthropic-messages",
    protocols: ["anthropic-messages"],
  },
  minimax: {
    label: "MiniMax",
    baseUrl: MINIMAX_GLOBAL_BASE_URL,
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
    defaultProtocol: "anthropic-messages",
    protocols: ["anthropic-messages", "openai-compatible"],
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["gpt-oss:20b", "qwen3:8b", "llama3.2"],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible"],
  },
  twelveai: {
    label: "12API · 中转",
    baseUrl: "https://new.12ai.org/v1",
    models: [],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible", "anthropic-messages"],
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible"],
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible"],
  },
  qwen: {
    label: "阿里云百炼 / Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible"],
  },
  custom: {
    label: "自定义",
    baseUrl: "",
    models: [],
    defaultProtocol: "openai-compatible",
    protocols: ["openai-compatible", "anthropic-messages"],
  },
};

export const AI_PROVIDER_ENTRIES = Object.entries(AI_PROVIDER_CONFIG);

export const AI_PROTOCOL_LABELS: Record<AiApiProtocol, string> = {
  "openai-compatible": "OpenAI Compatible",
  "anthropic-messages": "Anthropic Messages",
};

export function resolveAiProviderPreset(provider?: string | null, requestedProtocol?: string | null): AiProviderPreset {
  const key = String(provider || "deepseek").toLowerCase();
  const meta = getAiProviderMeta(key);
  const protocol = meta.protocols.includes(requestedProtocol as AiApiProtocol)
    ? requestedProtocol as AiApiProtocol
    : meta.defaultProtocol;
  const model = meta.models[0] || "";
  const baseUrl = protocol === "anthropic-messages"
    ? key === "deepseek"
      ? "https://api.deepseek.com/anthropic"
      : key === "minimax"
        ? "https://api.minimax.io/anthropic"
        : key === "anthropic"
          ? "https://api.anthropic.com"
          : meta.baseUrl
    : key === "deepseek"
      ? "https://api.deepseek.com"
      : key === "minimax"
        ? MINIMAX_GLOBAL_BASE_URL
        : meta.baseUrl;
  const contextWindowTokens = key === "deepseek" || (key === "minimax" && model === "MiniMax-M3")
    ? 1_000_000
    : key === "minimax" || key === "anthropic"
      ? 204_800
      : 128_000;
  return { protocol, baseUrl, model, contextWindowTokens, maxOutputTokens: 32_768 };
}

export function getAiProviderMeta(provider?: string | null): AiProviderMeta {
  return AI_PROVIDER_CONFIG[provider || ""] || AI_PROVIDER_CONFIG.deepseek;
}

export function normalizeAiApiKey(value?: string | null): string {
  let next = String(value || "").trim();
  next = next.replace(/^Authorization\s*:\s*/i, "").trim();
  next = next.replace(/^Bearer\s+/i, "").trim();
  next = next.replace(/^["']|["']$/g, "").trim();
  return next;
}

export function normalizeAiBaseUrl(value?: string | null, provider?: string | null): string {
  const meta = getAiProviderMeta(provider);
  let next = String(value || meta.baseUrl || "").trim();
  if (!next) return meta.baseUrl;

  next = next.replace(/\s+/g, "").replace(/\/+$/, "");
  if (String(provider || "").toLowerCase() === "minimax") {
    next = next.replace(/api\.minimax\.chat/i, "api.minimax.io");
  }
  next = next.replace(/\/chat\/completions$/i, "");
  next = next.replace(/\/messages$/i, "");
  next = next.replace(/\/responses$/i, "");
  return next || meta.baseUrl;
}

export function isMiniMaxChinaApiKey(value?: string | null): boolean {
  return normalizeAiApiKey(value).toLowerCase().startsWith("sk-cp");
}

export function resolveAiBaseUrlForKey(provider?: string | null, baseUrl?: string | null, _apiKey?: string | null): string {
  const normalized = normalizeAiBaseUrl(baseUrl, provider);
  return normalized;
}

export function describeAiProvider(provider?: string | null): string {
  return getAiProviderMeta(provider).label;
}

export function getAiConnectionFailureHint(provider?: string | null, message = "", baseUrl = ""): string {
  const key = String(provider || "").toLowerCase();
  const text = `${message} ${baseUrl}`.toLowerCase();
  if (key === "minimax" && (text.includes("2049") || text.includes("invalid api key") || text.includes("api.minimax.chat"))) {
    return "已兼容 MiniMax 国际站 api.minimax.io 与国内站 api.minimaxi.com；若仍返回 2049，请确认该 Key 所属站点和账户余额/套餐可用。";
  }
  if (text.includes("bearer bearer")) {
    return "API Key 里不要带 Authorization: 或 Bearer 前缀，应用会自动补请求头。";
  }
  return "";
}

export function getDefaultAiModel(provider?: string | null, fallback = ""): string {
  return getAiProviderMeta(provider).models[0] || fallback;
}

export function getSettingsAiModelOptions(provider?: string | null, currentModel?: string | null): string[] {
  const models = [...getAiProviderMeta(provider).models, CUSTOM_AI_MODEL_OPTION];
  const current = String(currentModel || "").trim();
  if (current && !models.includes(current)) return [current, ...models];
  return models;
}

export function getDefaultSettingsAiModel(provider?: string | null): string {
  return getSettingsAiModelOptions(provider)[0] || CUSTOM_AI_MODEL_OPTION;
}

export function isPresetAiModel(provider?: string | null, model?: string | null): boolean {
  const value = String(model || "").trim();
  return Boolean(value && getAiProviderMeta(provider).models.includes(value));
}

export function buildAiModelOptions(settings: { provider?: string; model?: string }): AiModelOption[] {
  const options = AI_PROVIDER_ENTRIES.flatMap(([provider, meta]) => (
    meta.models.map((model) => ({
      id: model,
      label: model,
      provider,
      providerLabel: meta.label,
    }))
  ));
  const currentModel = String(settings.model || "").trim();
  const currentProvider = String(settings.provider || "custom");
  if (currentModel && !options.some((model) => model.id === currentModel && model.provider === currentProvider)) {
    options.unshift({
      id: currentModel,
      label: currentModel,
      provider: currentProvider,
      providerLabel: getAiProviderMeta(currentProvider).label,
    });
  }
  return options;
}
