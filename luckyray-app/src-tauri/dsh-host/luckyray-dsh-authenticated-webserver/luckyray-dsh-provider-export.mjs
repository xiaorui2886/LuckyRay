const MAX_PROVIDER_MODELS = 256;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_MODEL_ID_BYTES = 256;

function boundedText(value, maxBytes) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0
    && Buffer.byteLength(text, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : "";
}

function boundedPositiveInteger(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

function detachedInputModalities(value) {
  if (!Array.isArray(value)) return Object.freeze({ input: Object.freeze([]), inputState: "unknown" });
  const input = [];
  for (const modality of value) {
    if ((modality === "text" || modality === "image") && !input.includes(modality)) input.push(modality);
  }
  return Object.freeze({ input: Object.freeze(input), inputState: "declared" });
}

/**
 * Project the official LLM registry's final per-model facts without resolving
 * provider configuration a second time. Raw catalog, model override, and route
 * defaults remain owned by the registered DSH adapter.
 */
export async function projectResolvedModels({ llm, provider, selectedModel = "" }) {
  const route = boundedText(provider, MAX_PROVIDER_ID_BYTES);
  if (!route || typeof llm?.listModels !== "function" || typeof llm?.resolveModelInfo !== "function") {
    throw new Error("dsh-provider-export-invalid");
  }
  const selected = boundedText(selectedModel, MAX_MODEL_ID_BYTES);
  const listed = await llm.listModels(route);
  if (!Array.isArray(listed)) throw new Error("dsh-provider-export-invalid");
  const ids = [];
  const add = (value) => {
    const id = boundedText(value, MAX_MODEL_ID_BYTES);
    if (id && !ids.includes(id) && ids.length < MAX_PROVIDER_MODELS) ids.push(id);
  };
  add(selected);
  for (const model of listed) add(model?.id);

  const projected = [];
  for (const id of ids) {
    const resolved = await llm.resolveModelInfo(route, id);
    if (!resolved || boundedText(resolved.provider, MAX_PROVIDER_ID_BYTES) !== route
      || boundedText(resolved.id, MAX_MODEL_ID_BYTES) !== id) {
      throw new Error("dsh-provider-export-invalid");
    }
    const capability = detachedInputModalities(resolved.inputModalities);
    projected.push(Object.freeze({
      id,
      name: boundedText(resolved.name, MAX_MODEL_ID_BYTES) || id,
      input: capability.input,
      inputState: capability.inputState,
      toolCalls: "unknown",
      maxOutputTokens: boundedPositiveInteger(resolved.defaultMaxTokens, 2_000_000),
      contextWindowTokens: boundedPositiveInteger(resolved.context?.contextWindow, 16_000_000),
    }));
  }
  return Object.freeze(projected);
}

function validSource(source) {
  return source
    && boundedText(source.id, 96) === source.id
    && boundedText(source.settingsNs, 128) === source.settingsNs
    && typeof source.project === "function";
}

/** One app-owned export registration seam with Cordis-style atomic handles. */
export function createProviderExportRegistry() {
  const registrations = new Map();
  let generation = 0;
  return Object.freeze({
    register(source) {
      if (!validSource(source)) throw new Error("dsh-provider-export-invalid");
      if (registrations.has(source.id)) throw new Error("dsh-provider-export-duplicate");
      let current = source;
      let disposed = false;
      registrations.set(current.id, current);
      generation += 1;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        registrations.delete(current.id);
        generation += 1;
      };
      dispose.replace = (next) => {
        if (disposed) throw new Error("dsh-provider-export-disposed");
        if (!validSource(next)) throw new Error("dsh-provider-export-invalid");
        if (next.id !== current.id && registrations.has(next.id)) {
          throw new Error("dsh-provider-export-duplicate");
        }
        const ordered = [...registrations.values()].map((entry) => entry === current ? next : entry);
        registrations.clear();
        for (const entry of ordered) registrations.set(entry.id, entry);
        current = next;
        generation += 1;
      };
      return dispose;
    },
    snapshot() {
      return Object.freeze({
        generation,
        sources: Object.freeze([...registrations.values()]),
      });
    },
  });
}

function deepSeekRegistration() {
  return Object.freeze({
    id: "llm-deepseek",
    settingsNs: "llm-deepseek",
    project({ value, launchEnvironment }) {
      const source = value && typeof value === "object" ? value : {};
      return [Object.freeze({
        provider: "deepseek-official",
        profileId: "default",
        displayName: "DeepSeek",
        endpoint: source.baseURL ?? launchEnvironment?.get?.("DEEPSEEK_BASE_URL")?.value
          ?? "https://api.deepseek.com",
        wireProtocol: "openai-completions",
        credentialRef: source.apiKeyEnv ?? "DEEPSEEK_API_KEY",
        settingsPath: Object.freeze([]),
      })];
    },
  });
}

function piAiRegistration() {
  return Object.freeze({
    id: "llm-pi-ai",
    settingsNs: "llm-pi-ai",
    project({ value }) {
      const providers = value && typeof value === "object" && value.providers
        && typeof value.providers === "object" && !Array.isArray(value.providers)
        ? value.providers
        : {};
      return Object.entries(providers).map(([provider, profile]) => {
        const source = profile && typeof profile === "object" ? profile : {};
        return Object.freeze({
          provider,
          profileId: provider,
          displayName: source.displayName ?? provider,
          endpoint: source.baseURL,
          wireProtocol: source.api,
          credentialRef: source.apiKeyEnv,
          settingsPath: Object.freeze(["providers", provider]),
        });
      });
    },
  });
}

/** Built-ins opt into the same seam that third-party DSH plugins may use. */
export function createBuiltInProviderExportRegistry() {
  const registry = createProviderExportRegistry();
  registry.register(deepSeekRegistration());
  registry.register(piAiRegistration());
  return registry;
}

function settingsSnapshot(settings) {
  const rows = settings?.describe?.({ redactSecrets: true });
  if (!Array.isArray(rows)) throw new Error("dsh-provider-export-unavailable");
  const descriptors = new Map();
  for (const row of rows) {
    const ns = boundedText(row?.ns, 128);
    if (!ns || descriptors.has(ns) || !Number.isSafeInteger(row?.revision) || row.revision < 0) {
      throw new Error("dsh-provider-export-invalid");
    }
    descriptors.set(ns, Object.freeze({
      ns,
      revision: row.revision,
      value: row?.value && typeof row.value === "object" ? row.value : {},
    }));
  }
  return descriptors;
}

function snapshotFingerprint(snapshot) {
  return JSON.stringify([...snapshot.values()].map((entry) => [entry.ns, entry.revision]));
}

function normalizedEndpoint(value) {
  const text = boundedText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function normalizedSettingsPath(value) {
  if (!Array.isArray(value) || value.length > 8) return null;
  const path = [];
  for (const segment of value) {
    const text = boundedText(segment, 128);
    if (!text) return null;
    path.push(text);
  }
  return Object.freeze(path);
}

function normalizedSourceConnection(source, raw) {
  const provider = boundedText(raw?.provider, MAX_PROVIDER_ID_BYTES);
  const profileId = boundedText(raw?.profileId, 128);
  const displayName = boundedText(raw?.displayName, 256) || provider;
  const settingsPath = normalizedSettingsPath(raw?.settingsPath);
  if (!provider || !profileId || !displayName || settingsPath === null) {
    throw new Error("dsh-provider-export-invalid");
  }
  const endpoint = normalizedEndpoint(raw.endpoint);
  const wireProtocol = boundedText(raw.wireProtocol, 128) || null;
  const credentialRef = boundedText(raw.credentialRef, 256) || null;
  const reason = endpoint === null ? "endpoint-unresolved"
    : wireProtocol === null ? "protocol-unresolved"
      : credentialRef === null ? "credential-ref-unresolved"
        : "ready";
  return Object.freeze({
    sourceIdentity: `dsh:${source.id}:${provider}:${profileId}`,
    source: source.id,
    provider,
    profileId,
    displayName,
    settingsNs: source.settingsNs,
    settingsPath,
    endpoint,
    wireProtocol,
    credentialRef,
    portable: reason === "ready",
    syncable: reason === "ready",
    reason,
  });
}

function providerTopology(llm) {
  const providers = llm?.listProviders?.();
  if (!Array.isArray(providers)) throw new Error("dsh-provider-export-unavailable");
  const routes = new Map();
  for (const entry of providers) {
    const id = boundedText(entry?.id, MAX_PROVIDER_ID_BYTES);
    if (!id || routes.has(id)) throw new Error("dsh-provider-export-invalid");
    routes.set(id, boundedText(entry?.name, 256) || id);
  }
  return routes;
}

function directoryTopology(llm) {
  const directory = llm?.listConfigurableProviders?.();
  if (!Array.isArray(directory)) return new Map();
  const entries = new Map();
  for (const row of directory) {
    const provider = boundedText(row?.provider, MAX_PROVIDER_ID_BYTES);
    const settingsNs = boundedText(row?.settingsNs, 128);
    const settingsPath = normalizedSettingsPath(row?.settingsPath);
    if (provider && settingsNs && settingsPath !== null && !entries.has(provider)) {
      entries.set(provider, Object.freeze({ settingsNs, settingsPath }));
    }
  }
  return entries;
}

function topologyFingerprint(routes) {
  return JSON.stringify([...routes.keys()]);
}

function selectionSnapshot(agentDefaultModel) {
  const current = agentDefaultModel?.currentSelection?.();
  const provider = boundedText(current?.provider, MAX_PROVIDER_ID_BYTES);
  const model = boundedText(current?.model, MAX_MODEL_ID_BYTES);
  return Object.freeze({ provider, model });
}

/**
 * Export a detached, secret-free connection directory. Each source provides
 * only connection facts; models and final modalities always come from llm.
 */
export async function projectProviderExports({
  registry,
  settings,
  llm,
  agentDefaultModel,
  launchEnvironment,
}) {
  const registered = registry?.snapshot?.();
  if (!registered || !Number.isSafeInteger(registered.generation) || !Array.isArray(registered.sources)) {
    throw new Error("dsh-provider-export-invalid");
  }
  const initialSettings = settingsSnapshot(settings);
  const initialRoutes = providerTopology(llm);
  const directory = directoryTopology(llm);
  const initialSelection = selectionSnapshot(agentDefaultModel);
  const connections = [];
  const claimedRoutes = new Set();
  for (const source of registered.sources) {
    const descriptor = initialSettings.get(source.settingsNs);
    if (!descriptor) continue;
    const rawConnections = await source.project({
      value: descriptor.value,
      revision: descriptor.revision,
      launchEnvironment,
    });
    if (!Array.isArray(rawConnections)) throw new Error("dsh-provider-export-invalid");
    for (const raw of rawConnections) {
      const connection = normalizedSourceConnection(source, raw);
      if (claimedRoutes.has(connection.provider)) throw new Error("dsh-provider-export-duplicate");
      claimedRoutes.add(connection.provider);
      connections.push(connection);
    }
  }

  const providers = [];
  for (const connection of connections) {
    if (!initialRoutes.has(connection.provider)) continue;
    const models = await projectResolvedModels({
      llm,
      provider: connection.provider,
      selectedModel: initialSelection.provider === connection.provider ? initialSelection.model : "",
    });
    providers.push(Object.freeze(models.length > 0
      ? { ...connection, models }
      : {
          ...connection,
          portable: false,
          syncable: false,
          reason: "models-unresolved",
          models,
        }));
  }
  for (const [provider, displayName] of initialRoutes) {
    if (claimedRoutes.has(provider)) continue;
    const address = directory.get(provider);
    const models = await projectResolvedModels({
      llm,
      provider,
      selectedModel: initialSelection.provider === provider ? initialSelection.model : "",
    });
    providers.push(Object.freeze({
      sourceIdentity: `dsh:unregistered:${provider}:default`,
      source: "unregistered",
      provider,
      profileId: "default",
      displayName,
      settingsNs: address?.settingsNs ?? "unregistered",
      settingsPath: address?.settingsPath ?? Object.freeze([]),
      endpoint: null,
      wireProtocol: null,
      credentialRef: null,
      portable: false,
      syncable: false,
      reason: "export-not-registered",
      models,
    }));
  }

  const latestRegistry = registry.snapshot();
  const latestSettings = settingsSnapshot(settings);
  const latestRoutes = providerTopology(llm);
  const latestSelection = selectionSnapshot(agentDefaultModel);
  if (latestRegistry.generation !== registered.generation
    || snapshotFingerprint(latestSettings) !== snapshotFingerprint(initialSettings)
    || topologyFingerprint(latestRoutes) !== topologyFingerprint(initialRoutes)
    || latestSelection.provider !== initialSelection.provider
    || latestSelection.model !== initialSelection.model) {
    return Object.freeze({ outcome: "stale" });
  }
  const selected = providers.find((entry) => entry.provider === initialSelection.provider && entry.syncable);
  return Object.freeze({
    outcome: "ready",
    defaultSourceIdentity: selected?.sourceIdentity ?? null,
    providers: Object.freeze(providers),
  });
}

function boundedSecret(value) {
  const secret = typeof value === "string" ? value.trim() : "";
  return secret.length > 0
    && Buffer.byteLength(secret, "utf8") <= 8192
    && !/[\u0000-\u001f\u007f]/u.test(secret)
    ? secret
    : "";
}

/**
 * Resolve one explicit synchronization request entirely inside the DSH Host.
 * The public directory remains secret-free; resolved values travel in a
 * separate backend-only collection keyed by stable source identity.
 */
export async function projectProviderSync({ credentials, ...context }) {
  const exported = await projectProviderExports(context);
  if (exported.outcome !== "ready") return exported;
  const projected = [];
  const secrets = [];
  for (const provider of exported.providers) {
    if (!provider.syncable) {
      projected.push(provider);
      continue;
    }
    const resolved = await credentials?.resolve?.(provider.credentialRef);
    const secret = boundedSecret(resolved?.value);
    if (!secret) {
      projected.push(Object.freeze({
        ...provider,
        syncable: false,
        reason: "credential-missing",
      }));
      continue;
    }
    projected.push(provider);
    secrets.push(Object.freeze({ sourceIdentity: provider.sourceIdentity, value: secret }));
  }
  const latest = await projectProviderExports(context);
  if (latest.outcome !== "ready"
    || JSON.stringify(latest) !== JSON.stringify(exported)) {
    return Object.freeze({ outcome: "stale" });
  }
  const selected = projected.find((provider) => (
    provider.sourceIdentity === exported.defaultSourceIdentity && provider.syncable
  ));
  return Object.freeze({
    outcome: "ready",
    defaultSourceIdentity: selected?.sourceIdentity ?? null,
    providers: Object.freeze(projected),
    secrets: Object.freeze(secrets),
  });
}
