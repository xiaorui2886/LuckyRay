import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentSearchSettingsClient,
  createAgentSearchSettingsLifecycle,
  describeAgentSearchToggleState,
  describeSearchPrivacy,
} from "../src/core/services/agentSearch.ts";

test("search settings use a write-only Tavily key and return only configured state", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const client = createAgentSearchSettingsClient(async (command, args) => {
    calls.push([command, args]);
    if (command === "agent_search_settings_update") {
      return {
        enabled: true,
        provider: "tavily",
        selectedProvider: "tavily",
        tavilyConfigured: true,
        searxngEndpoint: null,
        searxngAllowLocal: false,
        ready: true,
        code: "ready",
        ignoredApiKey: "PRIVATE-RETURNED-KEY",
      };
    }
    throw new Error("unexpected command");
  });

  const status = await client.update({
    enabled: true,
    provider: "tavily",
    tavilyApiKey: "tvly-PRIVATE-KEY",
    clearTavilyApiKey: false,
    searxngEndpoint: null,
    clearSearxngEndpoint: true,
    searxngAllowLocal: false,
  });
  assert.equal(status.tavilyConfigured, true);
  assert.equal((status as Record<string, unknown>).ignoredApiKey, undefined);
  assert.equal(JSON.stringify(status).includes("PRIVATE"), false);
  assert.deepEqual(calls, [["agent_search_settings_update", {
    update: {
      enabled: true,
      provider: "tavily",
      tavilyApiKey: "tvly-PRIVATE-KEY",
      clearTavilyApiKey: false,
      searxngEndpoint: null,
      clearSearxngEndpoint: true,
      searxngAllowLocal: false,
    },
  }]]);
});

test("search privacy disclosure is fixed and contains no configuration", () => {
  const disclosure = describeSearchPrivacy();
  assert.match(disclosure, /搜索词会发送给所选搜索服务/);
  assert.match(disclosure, /网页内容可能发送给当前模型提供商/);
  assert.equal(disclosure.includes("http"), false);
});

test("a failed settings read is never presented as the search toggle being off", () => {
  assert.deepEqual(describeAgentSearchToggleState(null, false), {
    state: "loading",
    label: "正在读取联网搜索设置",
  });
  assert.deepEqual(describeAgentSearchToggleState(null, true), {
    state: "error",
    label: "联网搜索设置读取失败",
  });
  assert.deepEqual(describeAgentSearchToggleState({
    enabled: true,
    provider: "tavily",
    selectedProvider: "tavily",
    tavilyConfigured: true,
    searxngEndpoint: null,
    searxngAllowLocal: false,
    ready: true,
    code: "ready",
  }, false), {
    state: "ready",
    enabled: true,
    label: "已开启",
  });
});

test("a late page load cannot overwrite a newer persisted toggle status", async () => {
  let resolveLoad!: (status: any) => void;
  let resolveToggle!: (status: any) => void;
  const applied: boolean[] = [];
  const lifecycle = createAgentSearchSettingsLifecycle((status) => {
    applied.push(status.enabled);
  });
  const owner = lifecycle.attach();
  const load = owner.run(() => new Promise((resolve) => {
    resolveLoad = resolve;
  }));
  const toggle = owner.run(() => new Promise((resolve) => {
    resolveToggle = resolve;
  }));

  resolveToggle({
    enabled: true,
    provider: "tavily",
    selectedProvider: "tavily",
    tavilyConfigured: true,
    searxngEndpoint: null,
    searxngAllowLocal: false,
    ready: true,
    code: "ready",
  });
  await toggle;
  resolveLoad({
    enabled: false,
    provider: "off",
    selectedProvider: "tavily",
    tavilyConfigured: false,
    searxngEndpoint: null,
    searxngAllowLocal: false,
    ready: false,
    code: "web-network-disabled",
  });
  await load;

  assert.deepEqual(applied, [true]);
  owner.release();
});

test("route remount invalidates the old Settings owner without resetting the new status", async () => {
  let resolveOld!: (status: any) => void;
  const applied: boolean[] = [];
  const lifecycle = createAgentSearchSettingsLifecycle((status) => applied.push(status.enabled));
  const oldOwner = lifecycle.attach();
  const oldLoad = oldOwner.run(() => new Promise((resolve) => {
    resolveOld = resolve;
  }));
  oldOwner.release();

  const newOwner = lifecycle.attach();
  await newOwner.run(async () => ({
    enabled: true,
    provider: "tavily",
    selectedProvider: "tavily",
    tavilyConfigured: true,
    searxngEndpoint: null,
    searxngAllowLocal: false,
    ready: true,
    code: "ready",
  }));
  resolveOld({
    enabled: false,
    provider: "off",
    selectedProvider: "tavily",
    tavilyConfigured: false,
    searxngEndpoint: null,
    searxngAllowLocal: false,
    ready: false,
    code: "web-network-disabled",
  });
  await oldLoad;

  assert.deepEqual(applied, [true]);
  newOwner.release();
});
