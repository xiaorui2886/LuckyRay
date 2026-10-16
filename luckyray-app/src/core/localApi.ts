const FALLBACK_BASE_URL = "http://127.0.0.1:37418";

let cachedBaseUrl: string | null = null;
let cachedClientConfig: { baseUrl: string; credential: string; protocolVersion: number } | null = null;

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/i.test(trimmed)) return null;
  return trimmed;
}

export async function getLocalApiBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;

  const bridgeBase = normalizeBaseUrl(await (window.__LUCKYRAY__ as any)?.getCollectionServerBaseUrl?.().catch?.(() => null));
  if (bridgeBase) {
    cachedBaseUrl = bridgeBase;
    return bridgeBase;
  }

  try {
    const core = await import("@tauri-apps/api/core");
    if (core.isTauri()) {
      const tauriBase = normalizeBaseUrl(await core.invoke<string>("get_collection_server_base_url"));
      if (tauriBase) {
        cachedBaseUrl = tauriBase;
        return tauriBase;
      }
    }
  } catch {
    // Browser fallback keeps storybook/dev preview usable.
  }

  cachedBaseUrl = FALLBACK_BASE_URL;
  return cachedBaseUrl;
}

async function getLocalTransportClientConfig(): Promise<{ baseUrl: string; credential: string; protocolVersion: number }> {
  if (cachedClientConfig) return cachedClientConfig;

  const bridgeConfig = await (window.__LUCKYRAY__ as any)?.getLocalTransportClientConfig?.().catch?.(() => null);
  const bridgeBase = normalizeBaseUrl(bridgeConfig?.baseUrl);
  if (bridgeBase && typeof bridgeConfig?.credential === "string") {
    cachedBaseUrl = bridgeBase;
    cachedClientConfig = {
      baseUrl: bridgeBase,
      credential: bridgeConfig.credential,
      protocolVersion: Number(bridgeConfig.protocolVersion) || 1,
    };
    return cachedClientConfig;
  }

  try {
    const core = await import("@tauri-apps/api/core");
    if (core.isTauri()) {
      const config = await core.invoke<{ baseUrl: string; credential: string; protocolVersion: number }>(
        "get_local_transport_client_config",
      );
      const baseUrl = normalizeBaseUrl(config.baseUrl);
      if (baseUrl && typeof config.credential === "string") {
        cachedBaseUrl = baseUrl;
        cachedClientConfig = { ...config, baseUrl };
        return cachedClientConfig;
      }
    }
  } catch {
    // Browser preview has no privileged credential channel.
  }

  cachedClientConfig = { baseUrl: await getLocalApiBaseUrl(), credential: "", protocolVersion: 1 };
  return cachedClientConfig;
}

export async function localApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { baseUrl, credential } = await getLocalTransportClientConfig();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${baseUrl}${normalizedPath}`, withLocalTransportAuthorization(init, credential));
}

export function withLocalTransportAuthorization(init: RequestInit | undefined, credential: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (credential) headers.set("Authorization", `Bearer ${credential}`);
  return { ...init, headers };
}
