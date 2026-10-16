import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiSettingsForFrontend,
  sanitizeAiSettingsForBrowserStorage,
} from "../src/core/services/aiSettingsPrivacy.ts";

import {
  appendAiConversationMessage,
  buildOrdinaryAiConversationMessages,
  createAiVisibleContentStream,
  finalizeAiAssistantResponse,
  finalizeAiConversationPair,
  loadAiConversationMessages,
  persistAiConversationPair,
  projectAiIncompleteAssistantContent,
  runPersistedAiChatTurn,
  safeAiStreamFailure,
  sanitizeAiVisibleContent,
  streamAiChatWithTransport,
  streamAiChatWithDependencies,
} from "../src/core/services/ai.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("streamed reasoning tags are never exposed across arbitrary chunk boundaries", () => {
  const vectors = [
    {
      chunks: ["可见A", "<", "thi", "nk", ">", "PRIVATE-REASONING-A", "</thi", "nk>", "可见B"],
      expected: "可见A可见B",
    },
    {
      chunks: ["前", "<TH", "INK>", "PRIVATE-REASONING-B", "</THINK>", "中", "<think>x</think>", "后"],
      expected: "前中后",
    },
    {
      chunks: ["保留", "<think>", "PRIVATE-UNCLOSED", "以及剩余正文"],
      expected: "保留",
    },
  ];

  for (const vector of vectors) {
    const stream = createAiVisibleContentStream();
    let visible = "";
    for (const chunk of vector.chunks) {
      visible += stream.push(chunk);
      assert.equal(visible.includes("PRIVATE"), false);
      assert.equal(/<\/?(?:t|th|thi|thin|think)/i.test(visible), false);
    }
    visible += stream.finish();
    assert.equal(visible, vector.expected);
    assert.equal(stream.retainedBytes(), 0);
  }
});

test("an ordinary reply still persists after its AI page owner is released", async () => {
  const terminal = deferred<{ success: true; content: string }>();
  const appended: Array<{ role: string; content: string }> = [];
  const visible: string[] = [];
  let ownerActive = true;
  const completion = runPersistedAiChatTurn({
    bridge: {
      async appendAiMessage(_conversationId: string, role: string, content: string) {
        appended.push({ role, content });
      },
    },
    conversationId: "conversation-route-release",
    userContentForPersistence: "question",
    messages: [{ role: "user", content: "question" }],
    options: { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    streamId: "route-release-stream",
    ownerIsActive: () => ownerActive,
    onVisibleText: (text) => visible.push(text),
    runStream: async (_bridge, _messages, _options, onDelta) => {
      onDelta("可见片段", "可见片段");
      return terminal.promise;
    },
  });
  ownerActive = false;
  terminal.resolve({ success: true, content: "切页后仍保存的回复" });

  const settlement = await completion;
  assert.equal(settlement.persisted, true);
  assert.deepEqual(appended, [
    { role: "user", content: "question" },
    { role: "assistant", content: "切页后仍保存的回复" },
  ]);
  assert.deepEqual(visible, ["可见片段"]);
});

test("ordinary chat sends complete stored turns plus the current user content", async () => {
  const messages = await buildOrdinaryAiConversationMessages(
    {
      async getAiMessages() {
        return [
          { id: "orphan-a", role: "assistant", content: "orphan", createdAt: "2026-07-22T00:00:00Z" },
          { id: "u1", role: "user", content: "first question", createdAt: "2026-07-22T00:00:01Z" },
          { id: "a1", role: "assistant", content: "<think>PRIVATE</think>first answer", createdAt: "2026-07-22T00:00:02Z" },
          { id: "u2", role: "user", content: "stored copy of current", createdAt: "2026-07-22T00:00:03Z" },
        ];
      },
    },
    "conversation-history",
    "current structured content",
  );

  assert.deepEqual(messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "current structured content" },
  ]);
  assert.equal(JSON.stringify(messages).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(messages).includes("orphan"), false);
});

test("AI provider keys never survive frontend settings or browser-storage projections", () => {
  const frontend = projectAiSettingsForFrontend({
    aiProvider: "minimax",
    aiApiKey: "PRIVATE-PROVIDER-KEY",
    aiModel: "MiniMax-M3",
  });
  assert.equal(frontend.aiApiKey, null);
  assert.equal(frontend.aiApiKeyConfigured, true);
  assert.equal(JSON.stringify(frontend).includes("PRIVATE-PROVIDER-KEY"), false);

  const storage = sanitizeAiSettingsForBrowserStorage({
    "ai.provider": "minimax",
    "ai.apiKey": "PRIVATE-PROVIDER-KEY",
    "ai.model": "MiniMax-M3",
  });
  assert.equal(storage["ai.apiKey"], "");
  assert.equal(JSON.stringify(storage).includes("PRIVATE-PROVIDER-KEY"), false);
});

test("conversation persistence commits only a complete user and assistant pair", async () => {
  const pairs: Array<{ user: string; assistant: string }> = [];
  const bridge = {
    async appendAiConversationPair(_conversationId: string, userContent: string, assistantContent: string) {
      pairs.push({ user: userContent, assistant: assistantContent });
    },
  };
  const failed = await finalizeAiConversationPair(
    bridge,
    "conversation-pair",
    "failed question",
    { success: false, error_kind: "timeout" },
    "partial",
  );
  assert.equal(failed.persisted, false);
  assert.deepEqual(pairs, []);

  const completed = await finalizeAiConversationPair(
    bridge,
    "conversation-pair",
    "completed question",
    { success: true, content: "<think>PRIVATE</think>completed answer" },
    "",
  );
  assert.equal(completed.persisted, true);
  assert.deepEqual(pairs, [{ user: "completed question", assistant: "completed answer" }]);
});

test("an Agent failure persists one safe pair that survives remount without partial output", async () => {
  const rows: Array<{ conversationId: string; role: "user" | "assistant"; content: string }> = [];
  const bridge = {
    async appendAiConversationPair(conversationId: string, userContent: string, assistantContent: string) {
      rows.push(
        { conversationId, role: "user", content: userContent },
        { conversationId, role: "assistant", content: assistantContent },
      );
    },
    async getAiMessages(conversationId: string) {
      return rows
        .filter((row) => row.conversationId === conversationId)
        .map((row, index) => ({
          id: `row-${index}`,
          role: row.role,
          content: row.content,
          createdAt: "2026-07-23T00:00:00.000Z",
        }));
    },
  };

  const safeFailure = "Agent 未完成：Agent 运行失败";
  const persisted = await persistAiConversationPair(
    bridge,
    "agent-failed-remount",
    "请联网搜索天气",
    safeFailure,
  );
  assert.equal(persisted, true);
  const remounted = await loadAiConversationMessages(bridge, "agent-failed-remount");
  assert.deepEqual(remounted.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "请联网搜索天气" },
    { role: "assistant", content: safeFailure },
  ]);
  const serialized = JSON.stringify(rows);
  for (const forbidden of [
    "（Agent 响应未完成）",
    "PRIVATE-TOOL-OBSERVATION",
    "token=SECRET",
    "https://provider.invalid/private?q=SECRET",
    "C:\\\\private\\\\note.md",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("an Agent failure preserves safe visible progress and marks it incomplete", () => {
  const projected = projectAiIncompleteAssistantContent(
    "已找到公开资料。<think>PRIVATE-REASONING</think>正在整理结论。",
    "Agent 未完成：Agent 运行失败",
  );

  assert.equal(
    projected,
    "已找到公开资料。正在整理结论。\n\n（Agent 未完成：Agent 运行失败）",
  );
  assert.equal(projected.includes("PRIVATE-REASONING"), false);
  assert.equal(projected.includes("<think>"), false);
  assert.equal(
    projectAiIncompleteAssistantContent("<think>PRIVATE-ONLY</think>", "Agent 未完成：Agent 运行失败"),
    "Agent 未完成：Agent 运行失败",
  );
});

test("nested and orphan reasoning boundaries fail closed without publishing private suffixes", () => {
  const vectors = [
    {
      chunks: ["公开", "</thi", "nk>", "PRIVATE-ORPHAN"],
      expected: "公开",
    },
    {
      chunks: ["公开", "<think>", "PRIVATE-A", "<THINK>", "PRIVATE-B", "</think>", "PRIVATE-C", "</think>", "答案"],
      expected: "公开答案",
    },
    {
      chunks: ["公开", "<think>PRIVATE</think>", "</think>", "PRIVATE-EXTRA"],
      expected: "公开",
    },
  ];

  for (const vector of vectors) {
    const stream = createAiVisibleContentStream();
    let visible = "";
    for (const chunk of vector.chunks) {
      visible += stream.push(chunk);
      assert.equal(visible.includes("PRIVATE"), false);
      assert.equal(/<\/?think/i.test(visible), false);
    }
    visible += stream.finish();
    assert.equal(visible, vector.expected);
  }
});

test("reasoning grammar preserves unknown tags and caps nested depth", () => {
  const ordinary = createAiVisibleContentStream();
  let visible = "";
  for (const chunk of [..."公开<foo data-x='1'>答案"]) visible += ordinary.push(chunk);
  visible += ordinary.finish();
  assert.equal(visible, "公开<foo data-x='1'>答案");
  assert.equal(ordinary.failureKind(), null);

  const tooDeep = createAiVisibleContentStream();
  const nested = "<think>".repeat(33) + "PRIVATE-DEPTH" + "</think>".repeat(33);
  for (const chunk of [...nested]) {
    assert.equal(tooDeep.push(chunk).includes("PRIVATE"), false);
  }
  tooDeep.finish();
  assert.equal(tooDeep.failureKind(), "invalid_stream");
  assert.equal(tooDeep.retainedBytes(), 0);
});

test("a started stream never falls back to a second provider request", async () => {
  let streamRequests = 0;
  let fallbackRequests = 0;
  let unlistenCount = 0;
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {
        unlistenCount += 1;
      };
    },
    async invoke(_command: string, args: Record<string, any>) {
      streamRequests += 1;
      listener?.({ payload: { stream_id: args.request.stream_id, delta: "公开 partial" } });
      throw new Error("PRIVATE-INVOKE-ERROR https://provider.invalid/path?q=SECRET");
    },
  };
  const published: string[] = [];

  const response = await streamAiChatWithDependencies(
    {
      transport,
      async complete() {
        fallbackRequests += 1;
        return { success: true, content: "DUPLICATE-FALLBACK" };
      },
    },
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => published.push(fullText),
  );

  assert.equal(streamRequests, 1);
  assert.equal(fallbackRequests, 0);
  assert.equal(unlistenCount, 1);
  assert.deepEqual(published, ["公开 partial"]);
  assert.deepEqual(response, {
    success: false,
    error_kind: "provider_error",
    error_message: "AI 服务返回错误",
  });
  assert.equal(JSON.stringify({ response, published }).includes("PRIVATE"), false);
  assert.equal(JSON.stringify({ response, published }).includes("DUPLICATE"), false);
});

test("done and typed timeout events never fall back while pre-start unavailability falls back once", async () => {
  let fallbackRequests = 0;
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {};
    },
    async invoke(_command: string, args: Record<string, any>) {
      const streamId = args.request.stream_id;
      listener?.({ payload: { stream_id: streamId, error_kind: "timeout", error_message: "PRIVATE-TIMEOUT", done: true } });
      return { success: false, error_kind: "timeout", error_message: "PRIVATE-TIMEOUT" };
    },
  };
  const timeout = await streamAiChatWithDependencies(
    {
      transport,
      async complete() {
        fallbackRequests += 1;
        return { success: true, content: "DUPLICATE" };
      },
    },
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    () => assert.fail("timeout does not publish content"),
  );
  assert.deepEqual(timeout, { success: false, error_kind: "timeout", error_message: "AI 请求超时" });
  assert.equal(fallbackRequests, 0);

  const fallbackPublished: string[] = [];
  const fallback = await streamAiChatWithDependencies(
    {
      async complete() {
        fallbackRequests += 1;
        return { success: true, content: "可见<think>PRIVATE-FALLBACK</think>答案" };
      },
    },
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => fallbackPublished.push(fullText),
  );
  assert.deepEqual(fallback, { success: true, content: "可见答案" });
  assert.deepEqual(fallbackPublished, ["可见答案"]);
  assert.equal(fallbackRequests, 1);
});

test("failed streams expose only fixed inline status and never persist an assistant success", async () => {
  const rawFailure = {
    success: false,
    error_kind: "connection",
    error_message: "PRIVATE-ERROR token=SECRET https://provider.invalid/path?q=SECRET C:\\private\\note.md SQL stack",
  };
  assert.deepEqual(safeAiStreamFailure(rawFailure), {
    kind: "connection",
    message: "AI 服务连接失败",
  });

  const appended: string[] = [];
  const bridge = {
    async appendAiMessage(_conversationId: string, _role: "user" | "assistant" | "system", content: string) {
      appended.push(content);
    },
  };
  const settlement = await finalizeAiAssistantResponse(
    bridge,
    "conversation-failed",
    rawFailure,
    "公开的安全 partial",
  );

  assert.deepEqual(settlement, {
    content: "公开的安全 partial\n\n（响应未完成）",
    status: "AI 服务连接失败",
    persisted: false,
  });
  assert.deepEqual(appended, []);
  assert.equal(JSON.stringify(settlement).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(settlement).includes("provider.invalid"), false);
  assert.equal(JSON.stringify(settlement).includes("private\\note"), false);
});

test("the production stream seam publishes and returns only visible assistant content", async () => {
  const privateReasoning = "PRIVATE-STREAM-REASONING";
  const published: Array<{ delta: string; fullText: string }> = [];
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {};
    },
    async invoke(_command: string, args: Record<string, any>) {
      const streamId = args.request.stream_id;
      for (const delta of ["公开", "<", "think>", privateReasoning, "</thi", "nk>", "答案"]) {
        listener?.({ payload: { stream_id: streamId, delta } });
      }
      listener?.({ payload: { stream_id: streamId, done: true } });
      return { success: true };
    },
  };

  const response = await streamAiChatWithTransport(
    transport,
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (delta, fullText) => published.push({ delta, fullText }),
    "test-stream-safe",
  );

  assert.deepEqual(response, { success: true, content: "公开答案" });
  assert.equal(JSON.stringify(published).includes(privateReasoning), false);
  assert.equal(JSON.stringify(published).includes("<thi"), false);
  assert.deepEqual(published.at(-1), { delta: "答案", fullText: "公开答案" });
});

test("typed command return settles a stream when the terminal event is lost", async () => {
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  let unlistenCount = 0;
  const published: string[] = [];
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {
        unlistenCount += 1;
      };
    },
    async invoke(_command: string, args: Record<string, any>) {
      listener?.({ payload: { stream_id: args.request.stream_id, delta: "visible answer" } });
      return { success: true };
    },
  };

  const response = await Promise.race([
    streamAiChatWithTransport(
      transport,
      [{ role: "user", content: "question" }],
      { systemPrompt: "system", temperature: 0, maxTokens: 64 },
      (_delta, fullText) => published.push(fullText),
      "typed-terminal-safe",
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);

  assert.notEqual(response, "hung");
  assert.deepEqual(response, { success: true, content: "visible answer" });
  assert.deepEqual(published, ["visible answer"]);
  assert.equal(unlistenCount, 1);
});

test("typed terminal content remains the persistence truth when all delta events are lost", async () => {
  let unlistenCount = 0;
  const appended: Array<{ role: string; content: string }> = [];
  const response = await streamAiChatWithTransport(
    {
      async listen() {
        return () => {
          unlistenCount += 1;
        };
      },
      async invoke() {
        return { success: true, content: "可恢复的助手回复" };
      },
    },
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    () => {
      throw new Error("delta event should be absent in this fixture");
    },
    "typed-content-persistence",
  );
  const settlement = await finalizeAiAssistantResponse(
    {
      async appendAiMessage(_conversationId: string, role: string, content: string) {
        appended.push({ role, content });
      },
    },
    "conversation-typed-content",
    response,
    "",
  );

  assert.deepEqual(response, { success: true, content: "可恢复的助手回复" });
  assert.deepEqual(settlement, { content: "可恢复的助手回复", status: null, persisted: true });
  assert.deepEqual(appended, [{ role: "assistant", content: "可恢复的助手回复" }]);
  assert.equal(unlistenCount, 1);
});

test("event-first and duplicate terminals still settle from one typed command return", async () => {
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  let unlistenCount = 0;
  const published: string[] = [];
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {
        unlistenCount += 1;
      };
    },
    async invoke(_command: string, args: Record<string, any>) {
      const streamId = args.request.stream_id;
      listener?.({ payload: { stream_id: streamId, delta: "visible", done: true } });
      listener?.({ payload: { stream_id: streamId, delta: "PRIVATE-DUPLICATE", done: true } });
      await Promise.resolve();
      return { success: true };
    },
  };

  const response = await streamAiChatWithTransport(
    transport,
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => published.push(fullText),
    "event-first-safe",
  );

  assert.deepEqual(response, { success: true, content: "visible" });
  assert.deepEqual(published, ["visible"]);
  assert.equal(unlistenCount, 1);
});

test("event-only done cannot authorize assistant success without a typed command terminal", async () => {
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  let fallbackRequests = 0;
  let unlistenCount = 0;
  const published: string[] = [];
  const appended: string[] = [];
  let streamId = "";
  const response = await streamAiChatWithDependencies(
    {
      transport: {
        async listen(_eventName: string, handler: typeof listener) {
          listener = handler;
          return () => {
            unlistenCount += 1;
          };
        },
        async invoke(_command: string, args: Record<string, any>) {
          streamId = args.request.stream_id;
          listener?.({
            payload: {
              stream_id: args.request.stream_id,
              delta: "visible answer",
              done: true,
            },
          });
          return undefined;
        },
      },
      async complete() {
        fallbackRequests += 1;
        return { success: true, content: "PRIVATE-FALLBACK" };
      },
    },
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => published.push(fullText),
  );

  listener?.({ payload: { stream_id: streamId, delta: "PRIVATE-LATE", done: true } });
  const settlement = await finalizeAiAssistantResponse(
    {
      async appendAiMessage(_conversationId: string, _role: "user" | "assistant" | "system", content: string) {
        appended.push(content);
      },
    },
    "conversation-event-only",
    response,
    published.at(-1) || "",
  );

  assert.deepEqual(response, {
    success: false,
    error_kind: "invalid_stream",
    error_message: safeAiStreamFailure("invalid_stream").message,
  });
  assert.deepEqual(published, ["visible answer"]);
  assert.equal(settlement.persisted, false);
  assert.deepEqual(appended, []);
  assert.equal(fallbackRequests, 0);
  assert.equal(unlistenCount, 1);
  assert.equal(JSON.stringify({ response, published, settlement }).includes("PRIVATE"), false);
});

test("typed failure is terminal once and late events cannot update the UI", async () => {
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  let unlistenCount = 0;
  const published: string[] = [];
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {
        unlistenCount += 1;
      };
    },
    async invoke(_command: string, args: Record<string, any>) {
      listener?.({ payload: { stream_id: args.request.stream_id, delta: "safe partial" } });
      return {
        success: false,
        error_kind: "timeout",
        error_message: "PRIVATE raw timeout https://provider.invalid/path?q=TOKEN",
      };
    },
  };

  const response = await streamAiChatWithTransport(
    transport,
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => published.push(fullText),
    "typed-failure-safe",
  );
  listener?.({ payload: { stream_id: "typed-failure-safe", delta: "PRIVATE-LATE", done: true } });

  assert.deepEqual(response, {
    success: false,
    error_kind: "timeout",
    error_message: safeAiStreamFailure("timeout").message,
  });
  assert.deepEqual(published, ["safe partial"]);
  assert.equal(unlistenCount, 1);
  assert.equal(JSON.stringify({ response, published }).includes("PRIVATE"), false);
});

test("every production onDelta snapshot stays clean through nested and orphan boundaries", async () => {
  let listener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
  const snapshots: string[] = [];
  const transport = {
    async listen(_eventName: string, handler: typeof listener) {
      listener = handler;
      return () => {};
    },
    async invoke(_command: string, args: Record<string, any>) {
      const streamId = args.request.stream_id;
      for (const delta of [
        "公开",
        "<thi",
        "nk>PRIVATE-A<think>PRIVATE-B</think>PRIVATE-C</think>",
        "答案",
        "</thi",
        "nk>PRIVATE-ORPHAN",
      ]) {
        listener?.({ payload: { stream_id: streamId, delta } });
      }
      return { success: false, error_kind: "invalid_stream" };
    },
  };

  const response = await streamAiChatWithTransport(
    transport,
    [{ role: "user", content: "question" }],
    { systemPrompt: "system", temperature: 0, maxTokens: 64 },
    (_delta, fullText) => {
      snapshots.push(fullText);
      assert.equal(fullText.includes("PRIVATE"), false);
      assert.equal(/<\/?think/i.test(fullText), false);
    },
    "nested-orphan-stream",
  );

  assert.deepEqual(snapshots, ["公开", "公开答案"]);
  assert.equal(response.success, false);
  assert.equal(response.error_kind, "invalid_stream");
});

test("assistant display and persistence share the same reasoning-safe projection", async () => {
  const privateReasoning = "PRIVATE-REASONING-SINK";
  const raw = `公开答案<think>${privateReasoning}</think>完成`;
  const appended: Array<{ role: string; content: string }> = [];
  const bridge = {
    async getAiMessages() {
      return [
        { id: "assistant-old", role: "assistant", content: raw, createdAt: "2026-07-17T00:00:00.000Z" },
        { id: "user-old", role: "user", content: raw, createdAt: "2026-07-17T00:00:01.000Z" },
      ];
    },
    async appendAiMessage(_conversationId: string, role: "user" | "assistant" | "system", content: string) {
      appended.push({ role, content });
    },
  };

  assert.equal(sanitizeAiVisibleContent(raw), "公开答案完成");
  const loaded = await loadAiConversationMessages(bridge, "conversation-1");
  assert.equal(loaded[0]?.content, "公开答案完成");
  assert.equal(loaded[1]?.content, raw, "user-authored text is not rewritten as model reasoning");

  await appendAiConversationMessage(bridge, "conversation-1", "assistant", raw);
  assert.deepEqual(appended, [{ role: "assistant", content: "公开答案完成" }]);
  assert.equal(JSON.stringify({ loaded, appended }).includes(privateReasoning), true, "user fixture remains present only in the user-authored row");
  assert.equal(appended.some((entry) => entry.content.includes(privateReasoning)), false);
  assert.equal(loaded[0]?.content.includes(privateReasoning), false);
});

test("completed assistant response persists to SQLite and survives remount load", async () => {
  const appended: Array<{ conversationId: string; role: string; content: string }> = [];
  const bridge = {
    async getAiMessages(conversationId: string) {
      return appended
        .filter((entry) => entry.conversationId === conversationId)
        .map((entry, index) => ({
          id: `msg-${index}`,
          role: entry.role,
          content: entry.content,
          createdAt: new Date(Date.now() + index).toISOString(),
        }));
    },
    async appendAiMessage(conversationId: string, role: "user" | "assistant" | "system", content: string) {
      appended.push({ conversationId, role, content });
    },
  };

  const convId = "conv-success-persist";

  // User sends a message
  await appendAiConversationMessage(bridge, convId, "user", "帮我联网搜索");

  // Agent completes successfully
  const settlement = await finalizeAiAssistantResponse(
    bridge,
    convId,
    { success: true, content: "搜索结果显示：LuckyRay 最新版本已发布。" },
    "搜索结果显示：LuckyRay 最新版本已发布。",
  );
  assert.equal(settlement.persisted, true);
  assert.equal(settlement.status, null);

  // Simulate remount: load from "SQLite" via bridge
  const loaded = await loadAiConversationMessages(bridge, convId);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].role, "user");
  assert.equal(loaded[0].content, "帮我联网搜索");
  assert.equal(loaded[1].role, "assistant");
  assert.equal(loaded[1].content, "搜索结果显示：LuckyRay 最新版本已发布。");
});

test("empty assistant response is not persisted and survives remount with only user message", async () => {
  const appended: Array<{ conversationId: string; role: string; content: string }> = [];
  const bridge = {
    async getAiMessages(conversationId: string) {
      return appended
        .filter((entry) => entry.conversationId === conversationId)
        .map((entry, index) => ({
          id: `msg-${index}`,
          role: entry.role,
          content: entry.content,
          createdAt: new Date(Date.now() + index).toISOString(),
        }));
    },
    async appendAiMessage(conversationId: string, role: "user" | "assistant" | "system", content: string) {
      appended.push({ conversationId, role, content });
    },
  };

  const convId = "conv-empty-response";
  await appendAiConversationMessage(bridge, convId, "user", "test");

  const settlement = await finalizeAiAssistantResponse(
    bridge,
    convId,
    { success: true, content: "" },
    "",
  );
  assert.equal(settlement.persisted, false);

  const loaded = await loadAiConversationMessages(bridge, convId);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].role, "user");
});
