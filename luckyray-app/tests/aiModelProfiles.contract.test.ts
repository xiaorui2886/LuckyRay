import assert from "node:assert/strict";
import test from "node:test";

import {
  createAiModelProfilesClient,
  selectConfiguredModelOptions,
  testActiveAiModelMessage,
} from "../src/core/services/aiModelProfiles.ts";
import { resolveAiProviderPreset } from "../src/core/services/aiProviders.ts";

test("AI model menu exposes only configured and enabled profiles", async () => {
  const client = createAiModelProfilesClient(async (command) => {
    assert.equal(command, "ai_model_profiles_list");
    return {
      version: 1,
      activeProfileId: "mini-main",
      profiles: [
        {
          id: "mini-main",
          name: "MiniMax 主力",
          provider: "minimax",
          protocol: "openai-compatible",
          baseUrl: "https://api.minimax.io/v1",
          model: "MiniMax-M3",
          availableModels: ["MiniMax-M3", "MiniMax-M2.7"],
          temperature: 0.7,
          maxOutputTokens: 4096,
          contextWindowTokens: 204800,
          enabled: true,
          apiKeyConfigured: true,
          agentCompatible: true,
          apiKey: "PRIVATE-MUST-NOT-PROJECT",
        },
        {
          id: "disabled-lab",
          name: "停用实验模型",
          provider: "custom",
          protocol: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          model: "lab-model",
          temperature: 0.2,
          maxOutputTokens: 2048,
          contextWindowTokens: 32768,
          enabled: false,
          apiKeyConfigured: true,
          agentCompatible: true,
        },
      ],
    };
  });

  const snapshot = await client.list();
  assert.deepEqual(selectConfiguredModelOptions(snapshot), [{
    id: "mini-main:MiniMax-M3",
    profileId: "mini-main",
    label: "MiniMax 主力",
    model: "MiniMax-M3",
    provider: "minimax",
    active: true,
    agentCompatible: true,
  }, {
    id: "mini-main:MiniMax-M2.7",
    profileId: "mini-main",
    label: "MiniMax 主力",
    model: "MiniMax-M2.7",
    provider: "minimax",
    active: false,
    agentCompatible: true,
  }]);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE-MUST-NOT-PROJECT"), false);
});

test("clearing a model key never sends an empty replacement key beside the clear intent", async () => {
  let captured: Record<string, unknown> | undefined;
  const client = createAiModelProfilesClient(async (command, args) => {
    assert.equal(command, "ai_model_profile_upsert");
    captured = args;
    return { version: 1, activeProfileId: "default", profiles: [] };
  });
  await client.save({
    id: "default",
    name: "默认模型",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    temperature: 0.7,
    maxOutputTokens: 4096,
    contextWindowTokens: 128000,
    enabled: true,
    apiKey: "",
    clearApiKey: true,
  });
  const profile = captured?.profile as Record<string, unknown>;
  assert.equal(Object.hasOwn(profile, "apiKey"), false);
  assert.equal(profile.clearApiKey, true);
});

test("testing one API connection refreshes its models and selecting one model uses the same profile", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const client = createAiModelProfilesClient(async (command, args) => {
    calls.push({ command, args });
    return {
      version: 1,
      activeProfileId: "deepseek-main",
      profiles: [{
        id: "deepseek-main",
        name: "DeepSeek",
        provider: "deepseek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        model: command === "ai_model_profile_select_model" ? "deepseek-v4-pro" : "deepseek-v4-flash",
        availableModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
        temperature: 0.7,
        maxOutputTokens: 4096,
        contextWindowTokens: 128000,
        enabled: true,
        apiKeyConfigured: true,
        agentCompatible: true,
      }],
    };
  });

  const tested = await client.test("deepseek-main");
  assert.deepEqual(tested.profiles[0].availableModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const selected = await client.selectModel("deepseek-main", "deepseek-v4-pro");
  assert.equal(selected.profiles[0].model, "deepseek-v4-pro");
  assert.deepEqual(calls.map((call) => call.command), [
    "ai_model_profile_test_connection",
    "ai_model_profile_select_model",
  ]);
  assert.deepEqual(calls[1].args, { profileId: "deepseek-main", model: "deepseek-v4-pro" });
});

test("provider presets use their official protocol-specific base URLs", () => {
  assert.deepEqual(resolveAiProviderPreset("deepseek", "openai-compatible"), {
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
  });
  assert.equal(
    resolveAiProviderPreset("deepseek", "anthropic-messages").baseUrl,
    "https://api.deepseek.com/anthropic",
  );
  assert.equal(
    resolveAiProviderPreset("minimax", "anthropic-messages").baseUrl,
    "https://api.minimax.io/anthropic",
  );
});

test("current-model message test uses the active backend connection without rewriting settings", async () => {
  const calls: Array<{ messages: unknown; options: unknown }> = [];
  const result = await testActiveAiModelMessage({
    aiChatComplete: async (messages, options) => {
      calls.push({ messages, options });
      return { success: true, content: "OK" };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    messages: [{ role: "user", content: "请只回复 OK，用于连接测试。" }],
    options: { temperature: 0, maxTokens: 16 },
  }]);
});

test("LightSeek model sync is one explicit backend operation and never projects a credential", async () => {
  const client = createAiModelProfilesClient(async (command) => {
    assert.equal(command, "ai_model_profile_sync_from_lightseek");
    return {
      outcome: "synced",
      message: "已同步当前 LightSeek 模型配置",
      synced: 1,
      skipped: 0,
      unsupported: 0,
      items: [{
        sourceIdentity: "dsh:llm-deepseek:deepseek-official:default",
        displayName: "DeepSeek",
        provider: "deepseek-official",
        status: "synced",
        reason: "ready",
        profileId: "lightseek-sync",
      }],
      snapshot: {
        version: 1,
        activeProfileId: "lightseek-sync",
        profiles: [{
          id: "lightseek-sync",
          name: "LightSeek · deepseek-v4-pro",
          provider: "deepseek",
          protocol: "openai-compatible",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          availableModels: ["deepseek-v4-pro"],
          temperature: 0.7,
          maxOutputTokens: 32768,
          contextWindowTokens: 1000000,
          enabled: true,
          apiKeyConfigured: true,
          agentCompatible: true,
          sourceIdentity: "dsh:llm-deepseek:deepseek-official:default",
          sourceProvider: "deepseek-official",
          modelCapabilities: [{
            id: "deepseek-v4-pro",
            input: ["text"],
            inputState: "declared",
            toolCalls: "unknown",
          }],
          apiKey: "MUST-NOT-LEAVE-BACKEND",
        }],
      },
    };
  });
  const result = await client.syncFromLightSeek();
  assert.equal(result.outcome, "synced");
  assert.equal(result.synced, 1);
  assert.equal(result.items[0].profileId, "lightseek-sync");
  assert.equal(result.snapshot?.activeProfileId, "lightseek-sync");
  assert.equal(JSON.stringify(result).includes("MUST-NOT-LEAVE-BACKEND"), false);
});
