export type AgentSearchProvider = "off" | "tavily" | "searxng";

export type AgentSearchSettingsStatus = {
  enabled: boolean;
  provider: AgentSearchProvider;
  selectedProvider: "tavily" | "searxng";
  tavilyConfigured: boolean;
  searxngEndpoint: string | null;
  searxngAllowLocal: boolean;
  ready: boolean;
  code: string;
};

export type AgentSearchSettingsUpdate = {
  enabled: boolean;
  provider: "tavily" | "searxng";
  tavilyApiKey?: string | null;
  clearTavilyApiKey: boolean;
  searxngEndpoint?: string | null;
  clearSearxngEndpoint: boolean;
  searxngAllowLocal: boolean;
};

export type AgentSearchConnectionResult = {
  ok: boolean;
  provider: AgentSearchProvider;
  code: string;
  label: string;
};

type SearchInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const SAFE_CODES = new Set([
  "ready",
  "web-network-disabled",
  "web-search-unavailable",
  "web-search-config-invalid",
  "web-search-unauthorized",
  "web-search-rate-limited",
  "web-search-timeout",
  "web-search-empty",
  "web-search-invalid-response",
]);

function safeProvider(value: unknown): AgentSearchProvider {
  return value === "tavily" || value === "searxng" ? value : "off";
}

function safeSelectedProvider(value: unknown): "tavily" | "searxng" {
  return value === "searxng" ? "searxng" : "tavily";
}

function safeEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).length > 4096) return null;
  if ([...value].some((character) => /[\u0000-\u001f\u007f]/u.test(character))) return null;
  return value;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && SAFE_CODES.has(value) ? value : "web-search-unavailable";
}

function projectStatus(value: unknown): AgentSearchSettingsStatus {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: source.enabled === true,
    provider: safeProvider(source.provider),
    selectedProvider: safeSelectedProvider(source.selectedProvider),
    tavilyConfigured: source.tavilyConfigured === true,
    searxngEndpoint: safeEndpoint(source.searxngEndpoint),
    searxngAllowLocal: source.searxngAllowLocal === true,
    ready: source.ready === true,
    code: safeCode(source.code),
  };
}

function projectConnection(value: unknown): AgentSearchConnectionResult {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = safeCode(source.code);
  const fixedLabels: Record<string, string> = {
    ready: "连接成功",
    "web-network-disabled": "联网搜索未启用",
    "web-search-unauthorized": "搜索服务授权失败",
    "web-search-rate-limited": "搜索服务请求过于频繁",
    "web-search-timeout": "搜索服务连接超时",
    "web-search-config-invalid": "搜索服务配置无效",
    "web-search-empty": "搜索服务未返回结果",
    "web-search-unavailable": "搜索服务暂不可用",
  };
  return {
    ok: source.ok === true && code === "ready",
    provider: safeProvider(source.provider),
    code,
    label: fixedLabels[code] || "搜索服务暂不可用",
  };
}

function validateUpdate(update: AgentSearchSettingsUpdate): AgentSearchSettingsUpdate {
  if (update.provider !== "tavily" && update.provider !== "searxng") throw new Error("web-search-config-invalid");
  const key = update.tavilyApiKey;
  if (key != null && (key.length === 0 || new TextEncoder().encode(key).length > 1024 || /[\s\u0000-\u001f\u007f]/u.test(key))) {
    throw new Error("web-search-config-invalid");
  }
  if (key != null && update.clearTavilyApiKey) throw new Error("web-search-config-invalid");
  const endpoint = update.searxngEndpoint;
  if (endpoint != null && update.clearSearxngEndpoint) throw new Error("web-search-config-invalid");
  if (endpoint != null && (new TextEncoder().encode(endpoint).length > 4096 || /[\u0000-\u001f\u007f]/u.test(endpoint))) {
    throw new Error("web-search-config-invalid");
  }
  return { ...update };
}

export function createAgentSearchSettingsClient(invoke: SearchInvoke) {
  return {
    async status(): Promise<AgentSearchSettingsStatus> {
      return projectStatus(await invoke("agent_search_settings_status"));
    },
    async update(update: AgentSearchSettingsUpdate): Promise<AgentSearchSettingsStatus> {
      return projectStatus(await invoke("agent_search_settings_update", { update: validateUpdate(update) }));
    },
    async testConnection(): Promise<AgentSearchConnectionResult> {
      return projectConnection(await invoke("agent_search_test_connection"));
    },
  };
}

export async function createDefaultAgentSearchSettingsClient() {
  const { invoke } = await import("@tauri-apps/api/core");
  return createAgentSearchSettingsClient(invoke as SearchInvoke);
}

export function createAgentSearchSettingsLifecycle(
  applyStatus: (status: AgentSearchSettingsStatus) => void,
) {
  let nextOwnerId = 0;
  let activeOwnerId: number | null = null;
  let requestEpoch = 0;
  return {
    attach() {
      const ownerId = ++nextOwnerId;
      activeOwnerId = ownerId;
      requestEpoch += 1;
      let released = false;
      return {
        async run(request: () => Promise<AgentSearchSettingsStatus>) {
          const epoch = ++requestEpoch;
          const status = await request();
          if (!released && activeOwnerId === ownerId && requestEpoch === epoch) {
            applyStatus(status);
          }
          return status;
        },
        isActive() {
          return !released && activeOwnerId === ownerId;
        },
        release() {
          if (released) return;
          released = true;
          if (activeOwnerId === ownerId) {
            activeOwnerId = null;
            requestEpoch += 1;
          }
        },
      };
    },
  };
}

export function describeSearchPrivacy(): string {
  return "搜索词会发送给所选搜索服务；抓取并读取的网页内容可能发送给当前模型提供商。";
}

export function describeAgentSearchToggleState(
  status: AgentSearchSettingsStatus | null,
  loadFailed: boolean,
): { state: "loading" | "error" | "ready"; enabled?: boolean; label: string } {
  if (!status) {
    return loadFailed
      ? { state: "error", label: "联网搜索设置读取失败" }
      : { state: "loading", label: "正在读取联网搜索设置" };
  }
  return {
    state: "ready",
    enabled: status.enabled,
    label: status.enabled ? "已开启" : "已关闭",
  };
}
