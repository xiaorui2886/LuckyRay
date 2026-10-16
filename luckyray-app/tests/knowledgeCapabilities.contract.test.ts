import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityRunSuccessText,
  createCapabilityRunHistoryEntry,
  isCapabilityRunnable,
  prepareCapabilityRunInput,
  readCapabilityRunLogs,
  recordCapabilityRunHistory,
  runCapabilityWithSafeHistory,
  type LocalCapability,
} from "../src/core/services/capabilities.ts";
import {
  buildAiSkillInsertion,
  buildAiSkillCommands,
  parseAiCommand,
  resolveAiCommandDispatch,
  runAiCapabilityCommand,
  runAiCapabilityForConversation,
} from "../src/core/services/aiCapabilities.ts";
import { appendAiConversationMessage } from "../src/core/services/ai.ts";

const documentRef = { vaultId: "vault-a", relativePath: "Inbox/Source.md" };

const researchCommand = {
  key: "research",
  label: "深度研究",
  desc: "联网、浏览与本地资料综合",
  prompt: "",
  source: "builtin" as const,
  commandOnly: true,
};

test("one visible research slash owns durable background semantics and the old alias migrates to it", () => {
  const commands = buildAiSkillCommands([], [researchCommand]);
  assert.deepEqual(commands.filter((command) => command.key.startsWith("research")).map((command) => command.key), ["research"]);
  const parsed = parseAiCommand("/research 比较两种方案", commands);
  assert.equal(resolveAiCommandDispatch(parsed), "research");
  assert.deepEqual(parsed.intent, { kind: "research", query: "比较两种方案" });
  assert.equal(parsed.finalText, "比较两种方案");
  assert.equal(parsed.displayText, "/research 比较两种方案");
  assert.equal(buildAiSkillInsertion("/res", researchCommand), "/research ");

  const empty = parseAiCommand("/research", commands);
  assert.equal(resolveAiCommandDispatch(empty), "research");
  assert.deepEqual(empty.intent, { kind: "research", query: "" });
  assert.equal(empty.finalText, "");

  const migrated = parseAiCommand("/research-bg 比较两种方案", commands);
  assert.equal(resolveAiCommandDispatch(migrated), "research");
  assert.deepEqual(migrated.intent, { kind: "research", query: "比较两种方案" });
  assert.equal(migrated.finalText, "比较两种方案");
  assert.equal(migrated.displayText, "/research 比较两种方案");

  const emptyMigrated = parseAiCommand("/research-bg", commands);
  assert.equal(resolveAiCommandDispatch(emptyMigrated), "research");
  assert.equal(emptyMigrated.finalText, "");
});

test("a local capability cannot shadow the reserved research command", () => {
  const collision = {
    id: "research",
    name: "PRIVATE research override",
    description: "must not replace the product command",
    type: "skill",
    enabled: true,
    available: true,
  } as LocalCapability;
  const commands = buildAiSkillCommands([collision], [researchCommand]);
  const selected = commands.find((item) => item.key === "research");
  assert.equal(selected?.source, "builtin");
  assert.equal(selected?.label, "深度研究");
});

function installHistoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("luckyray-capability-run-logs-v1", initial);
  let writes = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { writes += 1; values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  return {
    raw: () => values.get("luckyray-capability-run-logs-v1") ?? "",
    writes: () => writes,
  };
}

async function exerciseAiDispatch(options: {
  text: string;
  capabilities?: LocalCapability[];
  catalogState?: "ready" | "loading" | "error";
  run?: (id: string, input?: unknown) => Promise<any>;
}) {
  const capabilities = options.capabilities;
  const commands = buildAiSkillCommands(capabilities || [], []);
  const parsed = parseAiCommand(options.text.trim(), commands, {
    capabilities,
    capabilityCatalogState: options.catalogState || "ready",
  });
  const route = resolveAiCommandDispatch(parsed);
  let ordinaryAppends = 0;
  let ordinaryEnsures = 0;
  let modelCalls = 0;
  let transportCalls = 0;
  const persisted: unknown[] = [];
  if (route === "invalid-capability") {
    return { parsed, route, ordinaryAppends, ordinaryEnsures, modelCalls, transportCalls, persisted, error: null, execution: null };
  }
  if (route === "ordinary") {
    ordinaryEnsures += 1;
    ordinaryAppends += 1;
    modelCalls += 1;
    return { parsed, route, ordinaryAppends, ordinaryEnsures, modelCalls, transportCalls, persisted, error: null, execution: null };
  }
  let error: unknown = null;
  let execution: Awaited<ReturnType<typeof runAiCapabilityForConversation>> | null = null;
  try {
    execution = await runAiCapabilityForConversation(
      parsed.skill!,
      parsed.skillInput,
      parsed.parameters,
      {
        async run(id, input) {
          transportCalls += 1;
          return options.run ? options.run(id, input) : { ok: true, summary: "safe immediate output" };
        },
        async persist(record) { persisted.push(record); },
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { parsed, route, ordinaryAppends, ordinaryEnsures, modelCalls, transportCalls, persisted, error, execution };
}

test("capability history stores only bounded metadata for a sensitive successful run", () => {
  const storage = installHistoryStorage();
  const sentinel = "PRIVATE-CONTENT-SENTINEL";
  const url = "https://private.example/secret/path?token=TOP-SECRET#fragment";
  const title = "PRIVATE-TITLE-SENTINEL";
  const relativePath = "Private/Result.md";
  const kdoc = "kdoc-PRIVATE-OPAQUE-PAYLOAD";
  const log = recordCapabilityRunHistory({
    capabilityId: "wf.web_to_note",
    surface: "ai",
    input: {
      text: sentinel.repeat(24_000),
      params: { content: sentinel.repeat(1_000), url, title, documentId: kdoc },
      documentRef: { vaultId: "private-vault", relativePath },
    },
    result: {
      ok: true,
      summary: sentinel,
      lastResult: title,
      result: { kind: "document-created", id: kdoc, title, excerpt: sentinel, url, documentRef: { vaultId: "private-vault", relativePath } },
      indexWarning: { code: "knowledge-index-refresh-failed", message: sentinel },
      indexStale: true,
    },
    time: 123,
  });

  const raw = storage.raw();
  for (const secret of [sentinel, "secret/path", "TOP-SECRET", title, relativePath, kdoc, "private-vault"]) {
    assert.equal(raw.includes(secret), false, `history leaked ${secret}`);
  }
  assert.equal(raw.length <= 16 * 1024, true);
  assert.equal(storage.writes(), 1);
  assert.equal(log.version, 2);
  assert.equal(readCapabilityRunLogs()[0].outcome.indexWarningCode, "knowledge-index-refresh-failed");
});

test("available Knowledge capabilities are discoverable while disabled capabilities remain un-runnable", () => {
  const capabilities: LocalCapability[] = [
    { id: "skill.summary", type: "skill", name: "Summary", enabled: true, available: true },
    { id: "skill.search_intent", type: "skill", name: "Search", enabled: true, available: true },
    { id: "wf.web_to_note", type: "workflow", name: "Web", enabled: true, available: true },
    { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: false, available: true },
  ];
  assert.equal(isCapabilityRunnable(capabilities[0]), true);
  assert.equal(isCapabilityRunnable(capabilities[3]), false);
  assert.deepEqual(
    buildAiSkillCommands(capabilities, []).map((command) => command.key),
    ["skill.summary", "skill.search_intent", "wf.web_to_note"],
  );
});

test("reserved disabled Knowledge capability commands remain capability intents", () => {
  const capabilities: LocalCapability[] = [
    { id: "skill.summary", type: "skill", name: "Summary", enabled: false, available: true },
    { id: "skill.search_intent", type: "skill", name: "Search", enabled: false, available: true },
    { id: "wf.web_to_note", type: "workflow", name: "Web", enabled: false, available: true },
    { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: false, available: true },
  ];
  const commands = buildAiSkillCommands(capabilities, []);
  assert.equal(commands.length, 0);
  for (const [canonicalId, aliasId] of [
    ["skill.summary", "skill_summary"],
    ["skill.search_intent", "skill_search_intent"],
    ["wf.web_to_note", "wf_web_to_note"],
    ["wf.note_to_summary", "wf_note_to_summary"],
  ]) {
    for (const token of [canonicalId, aliasId]) {
      const parsed = parseAiCommand(`/${token} PRIVATE-CAPABILITY-SENTINEL`, commands, { capabilities });
      assert.equal(parsed.intent?.kind, "capability");
      assert.equal(parsed.intent?.capabilityId, canonicalId);
      assert.equal(parsed.intent?.state, "disabled");
      assert.equal(parsed.skill?.key, canonicalId);
    }
  }
});

test("AI dispatch keeps disabled canonical and alias commands out of ordinary chat", async () => {
  for (const text of [
    "/wf.note_to_summary PRIVATE-CAPABILITY-SENTINEL",
    "/wf_note_to_summary PRIVATE-ALIAS-SENTINEL",
  ]) {
    installHistoryStorage();
    const result = await exerciseAiDispatch({
      text,
      capabilities: [
        { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: false, available: true },
      ],
    });
    assert.equal(result.route, "capability");
    assert.equal(result.parsed.intent?.capabilityId, "wf.note_to_summary");
    assert.equal(result.ordinaryAppends, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.transportCalls, 0);
    assert.equal(result.persisted.length, 1);
    assert.equal((result.error as { code?: string })?.code, "capability-disabled");
    const sink = JSON.stringify(result.persisted);
    assert.equal(sink.includes("PRIVATE-CAPABILITY-SENTINEL"), false);
    assert.equal(sink.includes("PRIVATE-ALIAS-SENTINEL"), false);
  }
});

test("AI dispatch fails closed for unavailable and missing capability catalog entries", async () => {
  for (const fixture of [
    {
      capabilities: [{
        id: "skill.summary",
        type: "skill",
        name: "Summary",
        enabled: true,
        available: false,
        unavailableCode: "knowledge-capability-migration-pending",
      } satisfies LocalCapability],
      catalogState: "ready" as const,
      code: "capability-unavailable",
    },
    { capabilities: [] as LocalCapability[], catalogState: "loading" as const, code: "capability-catalog-not-ready" },
    { capabilities: [] as LocalCapability[], catalogState: "error" as const, code: "capability-catalog-not-ready" },
    {
      capabilities: [{ id: "skill.summary", type: "skill", name: "Stale summary", enabled: true, available: true } satisfies LocalCapability],
      catalogState: "error" as const,
      code: "capability-catalog-not-ready",
    },
  ]) {
    installHistoryStorage();
    const result = await exerciseAiDispatch({
      text: "/skill.summary PRIVATE-CATALOG-SENTINEL",
      capabilities: fixture.capabilities,
      catalogState: fixture.catalogState,
    });
    assert.equal(result.route, "capability");
    assert.equal(result.ordinaryAppends, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.transportCalls, 0);
    assert.equal(result.persisted.length, 1);
    assert.equal((result.error as { code?: string })?.code, fixture.code);
    if (fixture.code === "capability-unavailable") {
      assert.equal(result.parsed.intent?.unavailableCode, "knowledge-capability-migration-pending");
      assert.equal((result.error as { reasonCode?: string })?.reasonCode, "knowledge-capability-migration-pending");
    }
    assert.equal(JSON.stringify(result.persisted).includes("PRIVATE-CATALOG-SENTINEL"), false);
  }
});

test("AI dispatch runs enabled canonical and alias commands exactly once without model dispatch", async () => {
  for (const text of [
    "/wf.web_to_note content=CAPTURED",
    "/wf_web_to_note content=CAPTURED",
  ]) {
    installHistoryStorage();
    const calls: Array<{ id: string; input: unknown }> = [];
    const result = await exerciseAiDispatch({
      text,
      capabilities: [
        { id: "wf.web_to_note", type: "workflow", name: "Web to note", enabled: true, available: true },
      ],
      async run(id, input) {
        calls.push({ id, input });
        return { ok: true, summary: "RAW-IMMEDIATE-RESULT", result: { kind: "document-created" } };
      },
    });
    assert.equal(result.route, "capability");
    assert.equal(result.parsed.intent?.capabilityId, "wf.web_to_note");
    assert.equal(result.ordinaryAppends, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.transportCalls, 1);
    assert.equal(result.persisted.length, 1);
    assert.equal(calls[0]?.id, "wf.web_to_note");
    assert.equal(result.execution?.result.summary, "RAW-IMMEDIATE-RESULT");
    assert.equal(JSON.stringify(result.persisted).includes("RAW-IMMEDIATE-RESULT"), false);
  }
});

test("AI dispatch parser has exact reserved-command boundaries", async () => {
  const capabilities: LocalCapability[] = [
    { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: true, available: true },
  ];
  for (const text of [
    "/wf.note_to_summary",
    "/wf.note_to_summary\u2003quoted=\"private words\"",
    "/wf_note_to_summary\tquoted=\"private words\"",
  ]) {
    const parsed = parseAiCommand(text, buildAiSkillCommands(capabilities, []), { capabilities });
    assert.equal(resolveAiCommandDispatch(parsed), "capability");
    assert.equal(parsed.intent?.capabilityId, "wf.note_to_summary");
  }
  for (const text of [
    "please summarize this",
    "/wf.note_to_summary_extra PRIVATE",
    "/WF.note_to_summary PRIVATE",
    "/wf.note_to_summaryPRIVATE",
    "/future.capability PRIVATE",
  ]) {
    const result = await exerciseAiDispatch({ text, capabilities });
    assert.equal(result.route, "ordinary");
    assert.equal(result.ordinaryAppends, 1);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.transportCalls, 0);
  }
});

test("reserved slash commands containing NUL fail closed before ordinary AI", async () => {
  installHistoryStorage();
  const result = await exerciseAiDispatch({
    text: "/wf.note_to_summary\u0000PRIVATE-NUL-SENTINEL",
    capabilities: [{ id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: true, available: true }],
  });
  assert.equal(result.route, "invalid-capability");
  assert.equal(result.parsed.intent?.kind, "invalid-capability");
  assert.equal(result.ordinaryAppends, 0);
  assert.equal(result.ordinaryEnsures, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.transportCalls, 0);
  assert.equal(result.persisted.length, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE-NUL-SENTINEL"), false);
});

test("slash tokenizer rejects dangerous controls and format characters without leaking raw input", async () => {
  const dangerousCommands = [
    "/wf.note_to_summary\u0001PRIVATE-SOH-SENTINEL",
    "/wf.note_to_summary\u007fPRIVATE-DEL-SENTINEL",
    "/wf.note_to_summary\u0085PRIVATE-C1-SENTINEL",
    "/wf_note_to_summary\u0000PRIVATE-ALIAS-NUL-SENTINEL",
    "/wf.note\u0001_to_summary PRIVATE-INTERNAL-CONTROL-SENTINEL",
    "/wf.note\u200b_to_summary PRIVATE-ZERO-WIDTH-SENTINEL",
    "/wf.note\u202e_to_summary PRIVATE-BIDI-SENTINEL",
    "/wf.note_to_summary!PRIVATE-ILLEGAL-SEPARATOR-SENTINEL",
    "/wf.note_to_summary content=PRIVATE-PARAM\u0000-SENTINEL",
  ];
  const capabilities: LocalCapability[] = [
    { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: true, available: true },
  ];
  for (const text of dangerousCommands) {
    installHistoryStorage();
    const result = await exerciseAiDispatch({ text, capabilities });
    assert.equal(result.route, "invalid-capability");
    assert.equal(result.parsed.intent?.kind, "invalid-capability");
    assert.equal(result.ordinaryEnsures, 0);
    assert.equal(result.ordinaryAppends, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.transportCalls, 0);
    assert.equal(result.persisted.length, 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE-"), false);
  }
});

test("slash tokenizer accepts safe Unicode whitespace and normal multiline arguments", () => {
  const capabilities: LocalCapability[] = [
    { id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: true, available: true },
  ];
  const commands = buildAiSkillCommands(capabilities, []);
  for (const fixture of [
    ["/wf.note_to_summary\u2003quoted=\"private words\"", "quoted=\"private words\""],
    ["/wf_note_to_summary\tfirst line\nsecond line", "first line\nsecond line"],
    ["/wf.note_to_summary\r\ncontent=ok", "content=ok"],
  ]) {
    const parsed = parseAiCommand(fixture[0], commands, { capabilities });
    assert.equal(resolveAiCommandDispatch(parsed), "capability");
    assert.equal(parsed.intent?.kind, "capability");
    assert.equal(parsed.skillInput, fixture[1]);
  }
});

test("capability intent resolution exceptions return a typed invalid command without raw fallback", () => {
  const commands = new Proxy([], {
    get() { throw new Error("PRIVATE-RESOLVER-ERROR-SENTINEL"); },
  }) as unknown as ReturnType<typeof buildAiSkillCommands>;
  const parsed = parseAiCommand("/wf.note_to_summary PRIVATE-RESOLVER-INPUT-SENTINEL", commands, {
    capabilities: [{ id: "wf.note_to_summary", type: "workflow", name: "Note summary", enabled: true, available: true }],
  });
  assert.equal(resolveAiCommandDispatch(parsed), "invalid-capability");
  assert.equal(parsed.intent?.kind, "invalid-capability");
  assert.equal(JSON.stringify(parsed).includes("PRIVATE-RESOLVER"), false);
});

test("reserved capability validation and transport failures never fall through to ordinary AI", async () => {
  installHistoryStorage();
  const validation = await exerciseAiDispatch({
    text: "/wf.web_to_note",
    capabilities: [{
      id: "wf.web_to_note",
      type: "workflow",
      name: "Web",
      enabled: true,
      available: true,
      parameters: [{ key: "content", label: "Content", type: "string", required: true }],
    }],
  });
  assert.equal(validation.ordinaryAppends, 0);
  assert.equal(validation.modelCalls, 0);
  assert.equal(validation.transportCalls, 0);
  assert.equal(validation.persisted.length, 1);

  installHistoryStorage();
  const rawError = Object.assign(new Error("PRIVATE-SERVER-ERROR"), {
    code: "knowledge-vault-required",
    details: { token: "PRIVATE-TOKEN", path: "C:\\private\\Vault.md" },
  });
  const failure = await exerciseAiDispatch({
    text: "/skill.summary PRIVATE-INPUT",
    capabilities: [{ id: "skill.summary", type: "skill", name: "Summary", enabled: true, available: true }],
    async run() { throw rawError; },
  });
  assert.equal(failure.ordinaryAppends, 0);
  assert.equal(failure.modelCalls, 0);
  assert.equal(failure.transportCalls, 1);
  assert.equal(failure.persisted.length, 1);
  assert.equal(failure.error, rawError);
  const sink = JSON.stringify(failure.persisted);
  for (const secret of ["PRIVATE-SERVER-ERROR", "PRIVATE-TOKEN", "private", "PRIVATE-INPUT"]) {
    assert.equal(sink.includes(secret), false);
  }
});

test("UI Knowledge mutations attach one active source epoch and canonical current document identity", async () => {
  let activations = 0;
  const deps = {
    async ensureActiveSource() {
      activations += 1;
      return { vaultId: "vault-a", sourceEpoch: 17 };
    },
    readContext() {
      return { note: { id: "kdoc-fixture", title: "Source", documentRef, revision: "rev-a" } };
    },
  };
  const prepared = await prepareCapabilityRunInput(
    "wf.note_to_summary",
    { params: { title: "Digest" }, source: "ai" },
    deps,
  );
  assert.deepEqual(prepared, {
    params: { title: "Digest" },
    source: "ai",
    sourceEpoch: 17,
    documentRef,
    expectedRevision: "rev-a",
  });
  assert.equal(activations, 1);

  const web = await prepareCapabilityRunInput(
    "wf_web_to_note",
    { text: "captured", source: "community" },
    deps,
  );
  assert.equal(typeof web === "object" && web.sourceEpoch, 17);
  assert.equal(activations, 2);
});

test("read-only summary text and index search do not activate a UI write source", async () => {
  const deps = {
    async ensureActiveSource(): Promise<never> {
      throw new Error("read-only capability must not activate writes");
    },
    readContext() {
      return {};
    },
  };
  assert.deepEqual(await prepareCapabilityRunInput("skill.summary", "explicit text", deps), {
    text: "explicit text",
  });
  assert.equal(await prepareCapabilityRunInput("skill.search_intent", "query", deps), "query");
});

test("source activation failure stops a Knowledge mutation before transport dispatch", async () => {
  await assert.rejects(
    prepareCapabilityRunInput(
      "wf.web_to_note",
      { text: "captured" },
      {
        async ensureActiveSource(): Promise<never> {
          throw new Error("knowledge-source-inactive");
        },
        readContext() {
          return {};
        },
      },
    ),
    /knowledge-source-inactive/,
  );
});

test("AI and Community success text preserves committed index warnings", () => {
  assert.equal(
    capabilityRunSuccessText({
      ok: true,
      summary: "摘要笔记已写入 Vault",
      indexWarning: { code: "knowledge-index-refresh-failed", message: "stale" },
      indexStale: true,
    }),
    "摘要笔记已写入 Vault，索引刷新稍后重试",
  );
  assert.equal(
    capabilityRunSuccessText({ ok: true, summary: "网页内容已保存到 Vault，索引刷新稍后重试" }),
    "网页内容已保存到 Vault，索引刷新稍后重试",
  );
});

test("AI production capability adapter runs exactly once and returns the typed warning text", async () => {
  const storage = installHistoryStorage();
  const secretInput = "AI-PRIVATE-INPUT-SENTINEL";
  const secretResult = "AI-PRIVATE-RESULT-SENTINEL";
  let runs = 0;
  const output = await runAiCapabilityCommand(
    {
      key: "wf.web_to_note",
      label: "Web to note",
      desc: "fixture",
      prompt: "fixture",
      source: "capability",
      parameters: [],
    },
    secretInput,
    undefined,
    {
      async run(id, input) {
        runs += 1;
        assert.equal(id, "wf.web_to_note");
        assert.equal(input, secretInput);
        return {
          ok: true,
          summary: "网页内容已保存到 Vault",
          lastResult: secretResult,
          indexWarning: { code: "knowledge-index-refresh-failed", message: "stale" },
          indexStale: true,
        };
      },
    },
  );
  assert.equal(runs, 1);
  assert.equal(output, "网页内容已保存到 Vault，索引刷新稍后重试");
  assert.equal(readCapabilityRunLogs().length, 1);
  assert.equal(storage.raw().includes(secretInput), false);
  assert.equal(storage.raw().includes(secretResult), false);
  assert.equal(storage.writes(), 1);
});

test("Community production capability adapter records one safe final success", async () => {
  const storage = installHistoryStorage();
  const secretInput = "COMMUNITY-PRIVATE-INPUT-SENTINEL";
  const secretResult = "COMMUNITY-PRIVATE-RESULT-SENTINEL";
  let runs = 0;
  const capability: LocalCapability = {
    id: "skill.summary",
    type: "skill",
    name: "Summary",
    enabled: true,
    available: true,
    parameters: [],
  };
  const result = await runCapabilityWithSafeHistory(capability, secretInput, "community", {
    async run(id, input) {
      runs += 1;
      assert.equal(id, capability.id);
      assert.equal(input, secretInput);
      return { ok: true, summary: secretResult };
    },
  });
  assert.equal(result.summary, secretResult);
  assert.equal(runs, 1);
  assert.equal(readCapabilityRunLogs().length, 1);
  assert.equal(storage.raw().includes(secretInput), false);
  assert.equal(storage.raw().includes(secretResult), false);
  assert.equal(storage.writes(), 1);
});

test("AI failure persists one allowlisted outcome while preserving the detailed immediate error", async () => {
  const storage = installHistoryStorage();
  const secretInput = "AI-FAILURE-INPUT-SENTINEL";
  const secretError = "AI-RAW-ERROR-SENTINEL";
  const failure = Object.assign(new Error(secretError), {
    code: "knowledge-revision-conflict",
    status: 409,
    details: { path: "C:\\private\\Source.md", token: "AI-TOKEN-SENTINEL", body: secretInput },
  });
  await assert.rejects(
    runAiCapabilityCommand(
      { key: "skill.summary", label: "Summary", desc: "fixture", prompt: "fixture", source: "capability", parameters: [] },
      secretInput,
      undefined,
      { async run() { throw failure; } },
    ),
    (error: unknown) => error === failure,
  );
  const raw = storage.raw();
  for (const secret of [secretInput, secretError, "private", "AI-TOKEN-SENTINEL"]) {
    assert.equal(raw.includes(secret), false, `AI failure history leaked ${secret}`);
  }
  assert.equal(storage.writes(), 1);
  assert.deepEqual(readCapabilityRunLogs()[0].outcome, {
    status: "failure",
    code: "knowledge-revision-conflict",
    category: "knowledge",
    message: "Knowledge capability failed",
    httpStatus: 409,
    resultKind: undefined,
    documentCount: undefined,
    assetCount: undefined,
    indexWarningCode: undefined,
    indexStale: undefined,
  });
});

test("Community failure then immediate retry creates exactly one safe entry per final run", async () => {
  const storage = installHistoryStorage();
  const secret = "COMMUNITY-RETRY-SECRET-SENTINEL";
  const capability: LocalCapability = {
    id: "wf.note_to_summary",
    type: "workflow",
    name: "Note summary",
    enabled: true,
    available: true,
    parameters: [],
  };
  let attempts = 0;
  const deps = {
    async run() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error(secret), { code: "request-timeout", stack: secret });
      return { ok: true, summary: secret, result: { kind: "summary", summary: secret } };
    },
  };
  await assert.rejects(runCapabilityWithSafeHistory(capability, secret, "community", deps));
  await runCapabilityWithSafeHistory(capability, secret, "community", deps);
  assert.equal(attempts, 2);
  assert.equal(storage.writes(), 2);
  assert.equal(readCapabilityRunLogs().length, 2);
  assert.equal(storage.raw().includes(secret), false);
});

test("unknown cyclic and throwing-proxy inputs are deny-by-default and bounded", () => {
  const storage = installHistoryStorage();
  const secret = "FUTURE-CAPABILITY-SECRET-SENTINEL";
  const cyclic: Record<string, unknown> = { secret };
  cyclic.self = cyclic;
  const throwing = new Proxy(cyclic, {
    get() { throw new Error(secret); },
    ownKeys() { throw new Error(secret); },
  });
  assert.doesNotThrow(() => recordCapabilityRunHistory({
    capabilityId: "future.capability",
    surface: "community",
    input: throwing,
    result: { ok: true, summary: secret, result: new Proxy({}, { get() { throw new Error(secret); } }) },
  }));
  const raw = storage.raw();
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.length <= 16 * 1024, true);
  assert.equal(readCapabilityRunLogs()[0].inputSummary.kind, "structured");
});

test("legacy and unknown run history schemas are removed without replaying raw values", () => {
  const secret = "LEGACY-HISTORY-SECRET-SENTINEL";
  const storage = installHistoryStorage(JSON.stringify([{
    id: "old",
    capabilityId: "wf.web_to_note",
    input: secret,
    output: { content: secret },
    error: { stack: secret },
    time: 1,
  }]));
  assert.deepEqual(readCapabilityRunLogs(), []);
  assert.equal(storage.raw(), "");
});

test("versioned history is canonicalized and strips injected raw fields", () => {
  const secret = "INJECTED-V2-RAW-SECRET-SENTINEL";
  const safe = createCapabilityRunHistoryEntry({
    capabilityId: "skill.search_intent",
    surface: "ai",
    input: secret,
    result: { ok: true, summary: secret },
    time: 77,
  });
  const storage = installHistoryStorage(JSON.stringify([{ ...safe, input: secret, output: secret, error: { stack: secret } }]));
  const logs = readCapabilityRunLogs();
  assert.equal(logs.length, 1);
  assert.equal(storage.raw().includes(secret), false);
  assert.equal(storage.writes(), 1);
});

test("AI capability success persists only the canonical safe conversation record", async () => {
  installHistoryStorage();
  const content = "SQLITE-CAPABILITY-INPUT-SENTINEL".repeat(16_000);
  const url = "https://private.example/hidden/path?token=SQLITE-TOKEN#fragment";
  const title = "SQLITE-PRIVATE-TITLE";
  const kdoc = "kdoc-SQLITE-PRIVATE-PAYLOAD";
  const rawInput = `content=${content} url="${url}" title=${title} documentId=${kdoc}`;
  const rawSummary = "SQLITE-CAPABILITY-RESULT-SENTINEL".repeat(60);
  const persisted: unknown[] = [];
  const execution = await runAiCapabilityForConversation(
    {
      key: "wf.web_to_note",
      label: "Web",
      desc: "fixture",
      prompt: "fixture",
      source: "capability",
      parameters: [
        { key: "content", label: "Content", type: "string", required: true },
        { key: "url", label: "URL", type: "string" },
        { key: "title", label: "Title", type: "string" },
        { key: "documentId", label: "Document", type: "string" },
      ],
    },
    rawInput,
    undefined,
    {
      async run() {
        return {
          ok: true,
          summary: rawSummary,
          result: { kind: "document-created", title, content, id: kdoc, url, documentRef: { vaultId: "private-vault", relativePath: "Private/Result.md" } },
          indexWarning: { code: "knowledge-index-refresh-failed", message: "SQLITE-RAW-WARNING-MESSAGE" },
          indexStale: true,
        };
      },
      async persist(record) {
        persisted.push(record);
      },
    },
  );
  assert.equal(execution.output.startsWith(rawSummary), true);
  assert.equal(execution.output.endsWith("索引刷新稍后重试"), true);
  assert.equal(execution.result.summary, rawSummary);
  assert.equal(persisted.length, 1);
  const record = persisted[0] as { title?: string; userMessage?: string; assistantMessage?: string };
  assert.equal(record.title, "Capability wf.web_to_note");
  assert.match(
    record.userMessage || "",
    /^Capability request: wf\.web_to_note \(structured input; \d+ chars; \d+ bytes; 4 parameters; URL present \(https\); document reference present\)$/,
  );
  assert.equal(
    record.assistantMessage,
    "Capability succeeded; document-created; index warning knowledge-index-refresh-failed; index refresh pending",
  );
  const sink = JSON.stringify(persisted);
  assert.equal(sink.length < 2_048, true);
  for (const secret of [content.slice(0, 64), "hidden/path", "SQLITE-TOKEN", title, kdoc, "Private/Result.md", "private-vault", rawSummary.slice(0, 64), "SQLITE-RAW-WARNING-MESSAGE"]) {
    assert.equal(sink.includes(secret), false, `conversation sink leaked ${secret}`);
  }
  assert.equal(sink.includes("knowledge-index-refresh-failed"), true);
});

test("AI capability failures persist only fixed safe records and preserve the immediate raw error", async () => {
  for (const fixture of [
    { code: "knowledge-vault-required", label: "NO-VAULT-RAW-SENTINEL" },
    { code: "capability-disabled", label: "DISABLED-RAW-SENTINEL" },
    { code: "request-timeout", label: "TIMEOUT-RAW-SENTINEL" },
  ]) {
    installHistoryStorage();
    const rawError = Object.assign(new Error(fixture.label), {
      code: fixture.code,
      details: { path: "C:\\Users\\Private\\Vault.md", token: "DB-SINK-TOKEN", sql: "SELECT private", body: fixture.label },
      stack: `STACK-${fixture.label}`,
    });
    const persisted: unknown[] = [];
    await assert.rejects(
      runAiCapabilityForConversation(
        { key: "skill.summary", label: "Summary", desc: "fixture", prompt: "fixture", source: "capability", parameters: [] },
        `PRIVATE-INPUT-${fixture.label}`,
        undefined,
        {
          async run() { throw rawError; },
          async persist(record) { persisted.push(record); },
        },
      ),
      (error: unknown) => error === rawError,
    );
    assert.equal(persisted.length, 1);
    const sink = JSON.stringify(persisted);
    for (const secret of [fixture.label, "PRIVATE-INPUT", "Users", "Vault.md", "DB-SINK-TOKEN", "SELECT private", "STACK-"]) {
      assert.equal(sink.includes(secret), false, `failure conversation leaked ${secret}`);
    }
  }
});

test("AI capability validation failure creates a safe record without transport or raw fallback", async () => {
  installHistoryStorage();
  let runs = 0;
  const persisted: unknown[] = [];
  await assert.rejects(runAiCapabilityForConversation(
    {
      key: "wf.web_to_note",
      label: "Web",
      desc: "fixture",
      prompt: "fixture",
      source: "capability",
      parameters: [{ key: "content", label: "Content", type: "string", required: true }],
    },
    "",
    undefined,
    {
      async run() { runs += 1; return { ok: true }; },
      async persist(record) { persisted.push(record); },
    },
  ));
  assert.equal(runs, 0);
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("参数校验失败"), false);
});

test("AI capability retries use their own safe record without reading the previous persisted run", async () => {
  installHistoryStorage();
  const persisted: Array<{ history?: { id?: string; outcome?: { status?: string } } }> = [];
  let attempts = 0;
  const deps = {
    async run() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("RETRY-RAW-ERROR"), { code: "request-timeout" });
      return { ok: true, summary: "RETRY-RAW-SUCCESS", result: { kind: "summary" } };
    },
    async persist(record: { history?: { id?: string; outcome?: { status?: string } } }) { persisted.push(record); },
  };
  const skill = { key: "skill.summary", label: "Summary", desc: "fixture", prompt: "fixture", source: "capability" as const, parameters: [] };
  await assert.rejects(runAiCapabilityForConversation(skill, "RETRY-INPUT-ONE", undefined, deps));
  const success = await runAiCapabilityForConversation(skill, "RETRY-INPUT-TWO", undefined, deps);
  assert.equal(success.output, "RETRY-RAW-SUCCESS");
  assert.equal(persisted.length, 2);
  assert.notEqual(persisted[0].history?.id, persisted[1].history?.id);
  assert.deepEqual(persisted.map((item) => item.history?.outcome?.status), ["failure", "success"]);
  assert.equal(JSON.stringify(persisted).includes("RETRY-RAW"), false);
});

test("ordinary AI conversation persistence keeps its existing raw message contract", async () => {
  const calls: unknown[][] = [];
  const bridge = {
    async appendAiMessage(...args: unknown[]) { calls.push(args); },
  };
  const ordinaryPrompt = "ORDINARY-AI-PROMPT-IS-STILL-PERSISTED";
  await appendAiConversationMessage(bridge, "conv-1", "user", ordinaryPrompt);
  assert.deepEqual(calls, [["conv-1", "user", ordinaryPrompt]]);
});
