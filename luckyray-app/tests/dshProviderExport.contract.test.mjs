import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  createBuiltInProviderExportRegistry,
  createProviderExportRegistry,
  projectProviderExports,
  projectProviderSync,
  projectResolvedModels,
} from "../src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs";

const appRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/[A-Za-z]:/u, (value) => value.slice(1)));

test("provider export takes model capabilities only from the official LLM resolver", async () => {
  const calls = [];
  const llm = {
    async listModels(provider) {
      assert.equal(provider, "mixed-route");
      return [
        { id: "text-model", name: "Text" },
        { id: "vision-model", name: "Vision" },
        { id: "vision-by-name-only", name: "Vision-looking unknown" },
      ];
    },
    async resolveModelInfo(provider, model) {
      calls.push([provider, model]);
      if (model === "text-model") {
        return {
          provider,
          id: model,
          name: "Text",
          inputModalities: ["text"],
          defaultMaxTokens: 4096,
          context: { contextWindow: 32_768 },
        };
      }
      if (model === "vision-model") {
        return {
          provider,
          id: model,
          name: "Vision",
          inputModalities: ["text", "image"],
          defaultMaxTokens: 8192,
          context: { contextWindow: 131_072 },
        };
      }
      return { provider, id: model, name: "Vision-looking unknown" };
    },
  };

  const models = await projectResolvedModels({
    llm,
    provider: "mixed-route",
    selectedModel: "vision-model",
  });

  assert.deepEqual(calls, [
    ["mixed-route", "vision-model"],
    ["mixed-route", "text-model"],
    ["mixed-route", "vision-by-name-only"],
  ]);
  assert.deepEqual(models, [
    {
      id: "vision-model",
      name: "Vision",
      input: ["text", "image"],
      inputState: "declared",
      toolCalls: "unknown",
      maxOutputTokens: 8192,
      contextWindowTokens: 131_072,
    },
    {
      id: "text-model",
      name: "Text",
      input: ["text"],
      inputState: "declared",
      toolCalls: "unknown",
      maxOutputTokens: 4096,
      contextWindowTokens: 32_768,
    },
    {
      id: "vision-by-name-only",
      name: "Vision-looking unknown",
      input: [],
      inputState: "unknown",
      toolCalls: "unknown",
      maxOutputTokens: null,
      contextWindowTokens: null,
    },
  ]);
  assert.equal(
    models.find((model) => model.id === "vision-by-name-only")?.input.includes("image"),
    false,
    "model names never create a LuckyRay capability guess",
  );
});

test("the frozen pi-ai adapter remains the only raw catalog/defaultInput/modelOverride resolver", async () => {
  const official = await readFile(
    resolve(appRoot, "src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"),
    "utf8",
  );
  const exporter = await readFile(
    resolve(appRoot, "src-tauri/dsh-host/luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
    "utf8",
  );

  assert.match(
    official,
    /input:\s*declaredInput\(entry\.input\)\s*\?\?\s*base\?\.input\s*\?\?\s*\[\.\.\.request\.defaultInput\]/u,
    "per-model entry/modelOverride, installed catalog, then route defaultInput stays official truth",
  );
  assert.doesNotMatch(exporter, /modelOverrides|defaultInput|\bvision\b|multimodal|\bmimo\b/iu);
  assert.match(exporter, /resolveModelInfo/u);
});

function fakeLlm(routes) {
  return {
    listProviders: () => Object.keys(routes).map((id) => ({ id, name: routes[id].displayName || id })),
    listConfigurableProviders: () => Object.entries(routes).map(([provider, route]) => ({
      provider,
      displayName: route.displayName || provider,
      settingsNs: route.settingsNs,
      settingsPath: route.settingsPath,
      ...(route.declared ? { declared: true } : {}),
    })),
    listModels: async (provider) => routes[provider]?.models || [],
    resolveModelInfo: async (provider, model) => {
      const value = routes[provider]?.models.find((entry) => entry.id === model);
      if (!value) throw new Error("missing-model");
      return { provider, ...value };
    },
  };
}

test("provider export registration has one atomic register/replace/dispose truth", () => {
  const registry = createProviderExportRegistry();
  const first = { id: "third-party-a", settingsNs: "llm-third-a", project: () => [] };
  const second = { id: "third-party-b", settingsNs: "llm-third-b", project: () => [] };
  const handle = registry.register(first);
  assert.deepEqual(registry.snapshot().sources.map((source) => source.id), ["third-party-a"]);
  assert.throws(() => registry.register(first), /dsh-provider-export-duplicate/u);
  const before = registry.snapshot().generation;
  handle.replace(second);
  const replaced = registry.snapshot();
  assert.equal(replaced.generation, before + 1);
  assert.deepEqual(replaced.sources.map((source) => source.id), ["third-party-b"]);
  handle();
  assert.deepEqual(registry.snapshot().sources, []);
  assert.throws(() => handle.replace(first), /dsh-provider-export-disposed/u);
});

test("DeepSeek, pi-ai, and an opt-in third party export through one provider-neutral registry", async () => {
  const registry = createBuiltInProviderExportRegistry();
  registry.register({
    id: "third-party-export",
    settingsNs: "llm-third-party",
    project({ value }) {
      return [{
        provider: "third-party-route",
        profileId: "primary",
        displayName: value.displayName,
        endpoint: value.endpoint,
        wireProtocol: value.protocol,
        credentialRef: value.credentialRef,
        settingsPath: [],
      }];
    },
  });
  const descriptors = [
    { ns: "llm-deepseek", revision: 3, value: {
      baseURL: "https://deepseek.example.test/v1/",
      apiKeyEnv: "DEEPSEEK_FIXTURE_KEY",
    } },
    { ns: "llm-pi-ai", revision: 5, value: { providers: {
      "openai-route": {
        displayName: "OpenAI fixture",
        api: "openai-completions",
        baseURL: "https://openai.example.test/v1",
        apiKeyEnv: "OPENAI_FIXTURE_KEY",
      },
      "bai-style-custom": {
        displayName: "BAI-style custom",
        api: "anthropic-messages",
        baseURL: "https://custom.example.test/anthropic",
        apiKeyEnv: "CUSTOM_FIXTURE_KEY",
      },
    } } },
    { ns: "llm-third-party", revision: 2, value: {
      displayName: "Third party fixture",
      endpoint: "https://third.example.test/v1",
      protocol: "openai-completions",
      credentialRef: "THIRD_FIXTURE_KEY",
    } },
  ];
  const settings = { describe(options) {
    assert.deepEqual(options, { redactSecrets: true });
    return structuredClone(descriptors);
  } };
  const llm = fakeLlm({
    "deepseek-official": {
      settingsNs: "llm-deepseek", settingsPath: [],
      models: [{ id: "deepseek-text", name: "DeepSeek text", inputModalities: ["text"] }],
    },
    "openai-route": {
      settingsNs: "llm-pi-ai", settingsPath: ["providers", "openai-route"],
      models: [{ id: "openai-vision", name: "OpenAI vision", inputModalities: ["text", "image"] }],
    },
    "bai-style-custom": {
      settingsNs: "llm-pi-ai", settingsPath: ["providers", "bai-style-custom"], declared: true,
      models: [{ id: "custom-text", name: "Custom text", inputModalities: ["text"] }],
    },
    "third-party-route": {
      settingsNs: "llm-third-party", settingsPath: [], declared: true,
      models: [{ id: "third-model", name: "Third", inputModalities: undefined }],
    },
  });

  const result = await projectProviderExports({
    registry,
    settings,
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: "bai-style-custom", model: "custom-text" }) },
    launchEnvironment: { get: () => undefined },
  });

  assert.equal(result.outcome, "ready");
  assert.equal(result.defaultSourceIdentity, "dsh:llm-pi-ai:bai-style-custom:bai-style-custom");
  assert.deepEqual(result.providers.map((entry) => [
    entry.provider, entry.endpoint, entry.wireProtocol, entry.syncable, entry.reason,
  ]), [
    ["deepseek-official", "https://deepseek.example.test/v1", "openai-completions", true, "ready"],
    ["openai-route", "https://openai.example.test/v1", "openai-completions", true, "ready"],
    ["bai-style-custom", "https://custom.example.test/anthropic", "anthropic-messages", true, "ready"],
    ["third-party-route", "https://third.example.test/v1", "openai-completions", true, "ready"],
  ]);
  assert.deepEqual(result.providers[1].models[0].input, ["text", "image"]);
  assert.equal(JSON.stringify(result).includes("FIXTURE_KEY"), true, "credential refs are public metadata");
  assert.equal(JSON.stringify(result).includes("secret-value"), false, "descriptors never contain secret values");
});

test("unregistered providers remain usable in DSH and are reported as non-syncable", async () => {
  const registry = createBuiltInProviderExportRegistry();
  const descriptors = [
    { ns: "llm-deepseek", revision: 1, value: {} },
    { ns: "llm-pi-ai", revision: 1, value: { providers: {} } },
  ];
  const result = await projectProviderExports({
    registry,
    settings: { describe: () => structuredClone(descriptors) },
    llm: fakeLlm({
      "deepseek-official": { settingsNs: "llm-deepseek", settingsPath: [], models: [] },
      "plugin-private": {
        settingsNs: "private-plugin", settingsPath: ["connection"], declared: true,
        models: [{ id: "private-model", name: "Private", inputModalities: ["text"] }],
      },
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "plugin-private", model: "private-model" }) },
    launchEnvironment: { get: () => undefined },
  });
  const privateRoute = result.providers.find((entry) => entry.provider === "plugin-private");
  assert.equal(privateRoute.syncable, false);
  assert.equal(privateRoute.reason, "export-not-registered");
  assert.deepEqual(privateRoute.models[0].input, ["text"]);
  assert.equal(result.defaultSourceIdentity, null);
});

test("provider export rejects mixed settings generations instead of returning a torn snapshot", async () => {
  const registry = createBuiltInProviderExportRegistry();
  let revision = 1;
  const result = await projectProviderExports({
    registry,
    settings: { describe: () => [
      { ns: "llm-deepseek", revision: revision++, value: {} },
      { ns: "llm-pi-ai", revision: 1, value: { providers: {} } },
    ] },
    llm: fakeLlm({
      "deepseek-official": {
        settingsNs: "llm-deepseek",
        settingsPath: [],
        models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inputModalities: ["text"] }],
      },
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-pro" }) },
    launchEnvironment: { get: () => undefined },
  });
  assert.deepEqual(result, { outcome: "stale" });
});

test("backend-only sync resolves credential refs beside, never inside, provider descriptors", async () => {
  const registry = createBuiltInProviderExportRegistry();
  const rows = [
    { ns: "llm-deepseek", revision: 9, value: {
      apiKeyEnv: "DEEPSEEK_SYNC_REF",
      baseURL: "https://deepseek.example.test/v1",
    } },
    { ns: "llm-pi-ai", revision: 4, value: { providers: {
      "custom-route": {
        displayName: "Custom route",
        api: "openai-completions",
        baseURL: "https://custom.example.test/v1",
        apiKeyEnv: "CUSTOM_SYNC_REF",
      },
    } } },
  ];
  const resolvedRefs = [];
  const result = await projectProviderSync({
    registry,
    settings: { describe: () => structuredClone(rows) },
    credentials: { async resolve(ref) {
      resolvedRefs.push(ref);
      return { value: ref === "DEEPSEEK_SYNC_REF" ? "deep-secret" : "custom-secret" };
    } },
    llm: fakeLlm({
      "deepseek-official": {
        settingsNs: "llm-deepseek", settingsPath: [],
        models: [{ id: "deep-model", name: "Deep", inputModalities: ["text"] }],
      },
      "custom-route": {
        settingsNs: "llm-pi-ai", settingsPath: ["providers", "custom-route"], declared: true,
        models: [{ id: "custom-model", name: "Custom", inputModalities: ["text", "image"] }],
      },
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "custom-route", model: "custom-model" }) },
    launchEnvironment: { get: () => undefined },
  });

  assert.deepEqual(resolvedRefs, ["DEEPSEEK_SYNC_REF", "CUSTOM_SYNC_REF"]);
  assert.equal(result.outcome, "ready");
  assert.equal(JSON.stringify(result.providers).includes("deep-secret"), false);
  assert.equal(JSON.stringify(result.providers).includes("custom-secret"), false);
  assert.deepEqual(result.secrets, [
    { sourceIdentity: "dsh:llm-deepseek:deepseek-official:default", value: "deep-secret" },
    { sourceIdentity: "dsh:llm-pi-ai:custom-route:custom-route", value: "custom-secret" },
  ]);
});

test("a missing backend credential is itemized without weakening other providers", async () => {
  const registry = createBuiltInProviderExportRegistry();
  const rows = [
    { ns: "llm-deepseek", revision: 1, value: {} },
    { ns: "llm-pi-ai", revision: 1, value: { providers: {
      usable: {
        api: "openai-completions", baseURL: "https://usable.example.test/v1", apiKeyEnv: "USABLE_REF",
      },
    } } },
  ];
  const result = await projectProviderSync({
    registry,
    settings: { describe: () => structuredClone(rows) },
    credentials: { async resolve(ref) {
      return ref === "USABLE_REF" ? { value: "usable-secret" } : undefined;
    } },
    llm: fakeLlm({
      "deepseek-official": {
        settingsNs: "llm-deepseek", settingsPath: [],
        models: [{ id: "deep-model", name: "Deep", inputModalities: ["text"] }],
      },
      usable: {
        settingsNs: "llm-pi-ai", settingsPath: ["providers", "usable"], declared: true,
        models: [{ id: "usable-model", name: "Usable", inputModalities: ["text"] }],
      },
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "usable", model: "usable-model" }) },
    launchEnvironment: { get: () => undefined },
  });
  assert.equal(result.providers.find((entry) => entry.provider === "deepseek-official").reason, "credential-missing");
  assert.equal(result.providers.find((entry) => entry.provider === "deepseek-official").syncable, false);
  assert.equal(result.providers.find((entry) => entry.provider === "usable").syncable, true);
  assert.equal(result.secrets.length, 1);
});

test("a configured route without resolved models stays itemized and does not resolve a credential", async () => {
  const registry = createBuiltInProviderExportRegistry();
  const rows = [
    { ns: "llm-deepseek", revision: 1, value: {
      apiKeyEnv: "READY_REF", baseURL: "https://ready.example.test/v1",
    } },
    { ns: "llm-pi-ai", revision: 1, value: { providers: {
      empty: {
        api: "openai-completions", baseURL: "https://empty.example.test/v1", apiKeyEnv: "EMPTY_REF",
      },
    } } },
  ];
  const resolvedRefs = [];
  const result = await projectProviderSync({
    registry,
    settings: { describe: () => structuredClone(rows) },
    credentials: { async resolve(ref) {
      resolvedRefs.push(ref);
      return { value: `${ref}-secret` };
    } },
    llm: fakeLlm({
      "deepseek-official": {
        settingsNs: "llm-deepseek", settingsPath: [],
        models: [{ id: "ready-model", name: "Ready", inputModalities: ["text"] }],
      },
      empty: {
        settingsNs: "llm-pi-ai", settingsPath: ["providers", "empty"], declared: true, models: [],
      },
    }),
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "ready-model" }) },
    launchEnvironment: { get: () => undefined },
  });

  const empty = result.providers.find((entry) => entry.provider === "empty");
  assert.equal(empty.syncable, false);
  assert.equal(empty.portable, false);
  assert.equal(empty.reason, "models-unresolved");
  assert.deepEqual(empty.models, []);
  assert.deepEqual(resolvedRefs, ["READY_REF"]);
  assert.deepEqual(result.secrets.map((entry) => entry.sourceIdentity), [
    "dsh:llm-deepseek:deepseek-official:default",
  ]);
});
