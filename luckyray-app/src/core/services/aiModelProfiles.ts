import { getAiProviderMeta, type AiApiProtocol } from "./aiProviders";

export type AiModelProfile = {
  id: string;
  name: string;
  provider: string;
  protocol: AiApiProtocol;
  baseUrl: string;
  model: string;
  availableModels: string[];
  temperature: number;
  maxOutputTokens: number;
  contextWindowTokens: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  agentCompatible: boolean;
  sourceIdentity?: string;
  sourceProvider?: string;
  modelCapabilities: AiModelCapability[];
};

export type AiModelCapability = {
  id: string;
  input: Array<"text" | "image">;
  inputState: "declared" | "unknown";
  toolCalls: "supported" | "unsupported" | "unknown";
};

export type AiModelProfilesSnapshot = {
  version: 1;
  activeProfileId: string;
  profiles: AiModelProfile[];
};

export type AiModelProfileInput = Omit<AiModelProfile,
  "apiKeyConfigured" | "agentCompatible" | "sourceIdentity" | "sourceProvider" | "modelCapabilities"> & {
  apiKey?: string;
  clearApiKey?: boolean;
};

export type AiModelMenuOption = {
  id: string;
  profileId: string;
  label: string;
  model: string;
  provider: string;
  active: boolean;
  agentCompatible: boolean;
};

export type LightSeekModelSyncResult = {
  outcome: "synced" | "partial" | "stale" | "not-ready" | "unavailable";
  message: string;
  synced: number;
  skipped: number;
  unsupported: number;
  items: LightSeekModelSyncItem[];
  snapshot?: AiModelProfilesSnapshot;
};

export type LightSeekModelSyncItem = {
  sourceIdentity: string;
  displayName: string;
  provider: string;
  status: "synced" | "skipped" | "unsupported";
  reason: string;
  profileId?: string;
};

export type ActiveAiModelMessageResult = {
  success: boolean;
  content?: string | null;
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

type ActiveAiModelMessageBridge = {
  aiChatComplete: (
    messages: Array<{ role: string; content: string }>,
    options: { temperature: number; maxTokens: number },
  ) => Promise<ActiveAiModelMessageResult>;
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_PROVIDERS = new Set(["deepseek", "openai", "anthropic", "minimax", "ollama", "custom", "twelveai", "gemini", "zhipu", "qwen"]);

function boundedText(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return "";
  return text;
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function projectProfile(value: unknown): AiModelProfile | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = boundedText(row.id, 64);
  const name = boundedText(row.name, 80);
  const provider = boundedText(row.provider, 32).toLowerCase();
  const providerMeta = getAiProviderMeta(provider);
  const requestedProtocol = boundedText(row.protocol, 32) as AiApiProtocol;
  const protocol = providerMeta.protocols.includes(requestedProtocol)
    ? requestedProtocol
    : providerMeta.defaultProtocol;
  const baseUrl = boundedText(row.baseUrl, 2048);
  const model = boundedText(row.model, 128);
  const availableModels = Array.isArray(row.availableModels)
    ? [...new Set(row.availableModels.map((value) => boundedText(value, 128)).filter(Boolean))].slice(0, 256)
    : [];
  const modelCapabilities = Array.isArray(row.modelCapabilities)
    ? row.modelCapabilities.map((value): AiModelCapability | null => {
      if (!value || typeof value !== "object") return null;
      const capability = value as Record<string, unknown>;
      const id = boundedText(capability.id, 128);
      const input = Array.isArray(capability.input)
        ? [...new Set(capability.input.filter((item) => item === "text" || item === "image"))] as Array<"text" | "image">
        : [];
      const inputState = capability.inputState === "declared" ? "declared"
        : capability.inputState === "unknown" ? "unknown" : null;
      const toolCalls = capability.toolCalls === "supported" ? "supported"
        : capability.toolCalls === "unsupported" ? "unsupported"
          : capability.toolCalls === "unknown" ? "unknown" : null;
      return id && inputState && toolCalls ? { id, input, inputState, toolCalls } : null;
    }).filter((item): item is AiModelCapability => Boolean(item))
    : [];
  if (!SAFE_ID.test(id) || !name || !SAFE_PROVIDERS.has(provider) || !baseUrl || !model) return null;
  return {
    id,
    name,
    provider,
    protocol,
    baseUrl,
    model,
    availableModels: availableModels.includes(model) ? availableModels : [model, ...availableModels].slice(0, 256),
    temperature: finiteNumber(row.temperature, 0.7, 0, 2),
    maxOutputTokens: Math.round(finiteNumber(row.maxOutputTokens, 2048, 64, 32768)),
    contextWindowTokens: Math.round(finiteNumber(row.contextWindowTokens, 32768, 1024, 2_000_000)),
    enabled: row.enabled === true,
    apiKeyConfigured: row.apiKeyConfigured === true,
    agentCompatible: row.agentCompatible === true,
    ...(boundedText(row.sourceIdentity, 256) ? { sourceIdentity: boundedText(row.sourceIdentity, 256) } : {}),
    ...(boundedText(row.sourceProvider, 128) ? { sourceProvider: boundedText(row.sourceProvider, 128) } : {}),
    modelCapabilities,
  };
}

function projectLightSeekModelSyncResult(value: unknown): LightSeekModelSyncResult {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const allowed = new Set(["synced", "partial", "stale", "not-ready", "unavailable"]);
  const outcome = boundedText(source.outcome, 32);
  if (!allowed.has(outcome)) throw new Error("lightseek-model-sync-invalid");
  const message = boundedText(source.message, 240);
  if (!message) throw new Error("lightseek-model-sync-invalid");
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value) : 0;
  const items = Array.isArray(source.items) ? source.items.map((value): LightSeekModelSyncItem | null => {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const status = item.status === "synced" || item.status === "skipped" || item.status === "unsupported"
      ? item.status : null;
    const sourceIdentity = boundedText(item.sourceIdentity, 256);
    const displayName = boundedText(item.displayName, 256);
    const provider = boundedText(item.provider, 128);
    const reason = boundedText(item.reason, 64);
    const profileId = boundedText(item.profileId, 64) || undefined;
    return status && sourceIdentity && displayName && provider && reason
      ? { sourceIdentity, displayName, provider, status, reason, ...(profileId ? { profileId } : {}) }
      : null;
  }).filter((item): item is LightSeekModelSyncItem => Boolean(item)) : [];
  return {
    outcome: outcome as LightSeekModelSyncResult["outcome"],
    message,
    synced: count(source.synced),
    skipped: count(source.skipped),
    unsupported: count(source.unsupported),
    items,
    ...(source.snapshot ? { snapshot: projectAiModelProfilesSnapshot(source.snapshot) } : {}),
  };
}

export function projectAiModelProfilesSnapshot(value: unknown): AiModelProfilesSnapshot {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const profiles = Array.isArray(source.profiles)
    ? source.profiles.map(projectProfile).filter((profile): profile is AiModelProfile => Boolean(profile))
    : [];
  const requestedActive = boundedText(source.activeProfileId, 64);
  const activeProfileId = profiles.some((profile) => profile.id === requestedActive)
    ? requestedActive
    : profiles[0]?.id || "";
  return { version: 1, activeProfileId, profiles };
}

export function selectConfiguredModelOptions(snapshot: AiModelProfilesSnapshot): AiModelMenuOption[] {
  return snapshot.profiles
    .filter((profile) => profile.enabled && profile.apiKeyConfigured)
    .flatMap((profile) => profile.availableModels.map((model) => ({
      id: `${profile.id}:${model}`,
      profileId: profile.id,
      label: profile.name,
      model,
      provider: profile.provider,
      active: profile.id === snapshot.activeProfileId && model === profile.model,
      agentCompatible: profile.agentCompatible,
    })));
}

export function testActiveAiModelMessage(
  bridge: ActiveAiModelMessageBridge,
): Promise<ActiveAiModelMessageResult> {
  return bridge.aiChatComplete(
    [{ role: "user", content: "请只回复 OK，用于连接测试。" }],
    { temperature: 0, maxTokens: 16 },
  );
}

export function createAiModelProfilesClient(invoke: Invoke) {
  return {
    list: async () => projectAiModelProfilesSnapshot(await invoke("ai_model_profiles_list")),
    save: async (profile: AiModelProfileInput) => {
      const apiKey = String(profile.apiKey || "").trim();
      const payload: AiModelProfileInput = {
        ...profile,
        ...(apiKey && !profile.clearApiKey ? { apiKey } : {}),
      };
      if (!apiKey || profile.clearApiKey) delete payload.apiKey;
      return projectAiModelProfilesSnapshot(await invoke("ai_model_profile_upsert", { profile: payload }));
    },
    activate: async (profileId: string) => projectAiModelProfilesSnapshot(
      await invoke("ai_model_profile_activate", { profileId }),
    ),
    test: async (profileId: string) => projectAiModelProfilesSnapshot(
      await invoke("ai_model_profile_test_connection", { profileId }),
    ),
    selectModel: async (profileId: string, model: string) => projectAiModelProfilesSnapshot(
      await invoke("ai_model_profile_select_model", { profileId, model }),
    ),
    remove: async (profileId: string) => projectAiModelProfilesSnapshot(
      await invoke("ai_model_profile_delete", { profileId }),
    ),
    syncFromLightSeek: async () => projectLightSeekModelSyncResult(
      await invoke("ai_model_profile_sync_from_lightseek"),
    ),
  };
}

export async function createDefaultAiModelProfilesClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createAiModelProfilesClient(invoke as Invoke);
}
