import type { ActiveContext } from "../activeContext";
import { formatAiFileSize } from "./aiAttachments";
import type { AiAttachment, AiUserContent } from "./aiAttachments";

export type { AiAttachment, AssetAttachmentPayload, AiUserContent } from "./aiAttachments";
export { assetToAiAttachment, buildAiUserContent, fileToAiAttachment, formatAiFileSize } from "./aiAttachments";
export { filesToAiAttachmentsWithWorker as filesToAiAttachments } from "./aiAttachmentWorker";
export {
  createPendingAiAttachment,
  parsePendingAiAttachment,
  readAiAttachmentQueue,
  writeAiAttachmentQueue,
} from "./aiAttachmentQueue";

export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  actionTruth?: AgentActionTruthDto | null;
};

export type AgentActionTruthDto = Readonly<{
  workspace: "not-requested" | "not-applied" | "verified" | "partial" | "uncertain";
  execution: "not-requested" | "no-result" | "verified" | "uncertain";
}>;

const AGENT_ACTION_WORKSPACE_VALUES = new Set<AgentActionTruthDto["workspace"]>([
  "not-requested",
  "not-applied",
  "verified",
  "partial",
  "uncertain",
]);
const AGENT_ACTION_EXECUTION_VALUES = new Set<AgentActionTruthDto["execution"]>([
  "not-requested",
  "no-result",
  "verified",
  "uncertain",
]);

export function parseAgentActionTruthDto(value: unknown): AgentActionTruthDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "execution" || keys[1] !== "workspace") return null;
  if (!AGENT_ACTION_WORKSPACE_VALUES.has(record.workspace as AgentActionTruthDto["workspace"])) {
    return null;
  }
  if (!AGENT_ACTION_EXECUTION_VALUES.has(record.execution as AgentActionTruthDto["execution"])) {
    return null;
  }
  return Object.freeze({
    workspace: record.workspace as AgentActionTruthDto["workspace"],
    execution: record.execution as AgentActionTruthDto["execution"],
  });
}

export type AiConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

const AI_REASONING_OPEN_TAG = "<think>";
const AI_REASONING_CLOSE_TAG = "</think>";
const AI_REASONING_MAX_DEPTH = 32;
const AI_REASONING_MAX_HIDDEN_BYTES = 4 * 1024 * 1024;
const AI_VISIBLE_MAX_BYTES = 4 * 1024 * 1024;

export type AiVisibleContentStream = {
  push: (chunk: string) => string;
  finish: () => string;
  retainedBytes: () => number;
  failureKind: () => "invalid_stream" | null;
};

function reasoningBoundaryAtStart(value: string): "open" | "close" | "partial" | "other" {
  const lowerValue = value.toLowerCase();
  if (lowerValue.startsWith(AI_REASONING_OPEN_TAG)) return "open";
  if (lowerValue.startsWith(AI_REASONING_CLOSE_TAG)) return "close";
  if (AI_REASONING_OPEN_TAG.startsWith(lowerValue) || AI_REASONING_CLOSE_TAG.startsWith(lowerValue)) {
    return "partial";
  }
  return "other";
}

export function createAiVisibleContentStream(): AiVisibleContentStream {
  let mode: "visible" | "reasoning" | "tainted" = "visible";
  let depth = 0;
  let hiddenBytes = 0;
  let visibleBytes = 0;
  let failure: "invalid_stream" | null = null;
  let pending = "";
  const encoder = new TextEncoder();

  const consumeHidden = (value: string): boolean => {
    hiddenBytes += encoder.encode(value).byteLength;
    if (hiddenBytes > AI_REASONING_MAX_HIDDEN_BYTES) {
      failure = "invalid_stream";
      mode = "tainted";
      pending = "";
      return true;
    }
    return false;
  };

  return {
    push(chunk) {
      if (!chunk || mode === "tainted") return "";
      pending += chunk;
      let visible = "";

      while (pending) {
        if (mode === "visible") {
          const tagStart = pending.indexOf("<");
          if (tagStart < 0) {
            visible += pending;
            pending = "";
            break;
          }
          if (tagStart > 0) {
            visible += pending.slice(0, tagStart);
            pending = pending.slice(tagStart);
          }

          const boundary = reasoningBoundaryAtStart(pending);
          if (boundary === "partial") break;
          if (boundary === "open") {
            pending = pending.slice(AI_REASONING_OPEN_TAG.length);
            mode = "reasoning";
            depth = 1;
            consumeHidden(AI_REASONING_OPEN_TAG);
            continue;
          }
          if (boundary === "close") {
            failure = "invalid_stream";
            mode = "tainted";
            pending = "";
            break;
          }

          visible += pending[0];
          pending = pending.slice(1);
          continue;
        }

        const tagStart = pending.indexOf("<");
        if (tagStart < 0) {
          consumeHidden(pending);
          pending = "";
          break;
        }
        if (tagStart > 0) {
          const overflowed = consumeHidden(pending.slice(0, tagStart));
          pending = pending.slice(tagStart);
          if (overflowed) break;
        }

        const boundary = reasoningBoundaryAtStart(pending);
        if (boundary === "partial") break;
        if (boundary === "open") {
          if (depth >= AI_REASONING_MAX_DEPTH) {
            failure = "invalid_stream";
            mode = "tainted";
            pending = "";
            break;
          }
          depth += 1;
          consumeHidden(AI_REASONING_OPEN_TAG);
          pending = pending.slice(AI_REASONING_OPEN_TAG.length);
          continue;
        }
        if (boundary === "close") {
          consumeHidden(AI_REASONING_CLOSE_TAG);
          pending = pending.slice(AI_REASONING_CLOSE_TAG.length);
          depth -= 1;
          if (depth === 0) mode = "visible";
          continue;
        }

        consumeHidden(pending[0]);
        pending = pending.slice(1);
      }

      const nextVisibleBytes = visibleBytes + encoder.encode(visible).byteLength;
      if (!Number.isSafeInteger(nextVisibleBytes) || nextVisibleBytes > AI_VISIBLE_MAX_BYTES) {
        failure = "invalid_stream";
        mode = "tainted";
        pending = "";
        return "";
      }
      visibleBytes = nextVisibleBytes;
      return visible;
    },
    finish() {
      pending = "";
      if (mode === "reasoning") failure = "invalid_stream";
      mode = "tainted";
      return "";
    },
    retainedBytes() {
      return encoder.encode(pending).byteLength;
    },
    failureKind() {
      return failure;
    },
  };
}

export function sanitizeAiVisibleContent(content: string): string {
  const stream = createAiVisibleContentStream();
  const visible = stream.push(content);
  stream.finish();
  return visible;
}

export function projectAiIncompleteAssistantContent(
  visibleContent: string,
  safeFailureContent: string,
): string {
  const visible = sanitizeAiVisibleContent(visibleContent).trim();
  const failure = sanitizeAiVisibleContent(safeFailureContent).trim() || "Agent 未完成";
  return visible ? `${visible}\n\n（${failure}）` : failure;
}

export type AiPromptInput = {
  model: string;
  permissions: Record<"workspace" | "files" | "network", boolean>;
  activeContext: ActiveContext;
  attachments: AiAttachment[];
};

type AiBridge = {
  listAiConversations?: () => Promise<AiConversation[]>;
  createAiConversation?: (title?: string) => Promise<AiConversation>;
  getAiMessages?: (conversationId: string) => Promise<Array<{
    id: string;
    role: string;
    content?: string;
    createdAt?: string;
    actionTruth?: unknown;
  }>>;
  appendAiMessage?: (conversationId: string, role: "user" | "assistant" | "system", content: string) => Promise<unknown>;
  appendAiConversationPair?: (conversationId: string, userContent: string, assistantContent: string) => Promise<unknown>;
  aiChatComplete?: (messages: AiChatMessage[], options: { systemPrompt: string; temperature: number; maxTokens: number }) => Promise<any>;
};

export type AiChatMessage = {
  role: "user" | "assistant";
  content: AiUserContent;
};

export function buildAiSystemPrompt(input: AiPromptInput): string {
  const enabled = Object.entries(input.permissions).filter(([, value]) => value).map(([key]) => key).join(", ") || "none";
  const note = input.activeContext.note;
  const asset = input.activeContext.asset;
  const canvas = input.activeContext.canvas;
  const graph = input.activeContext.graph;
  const contextLines = input.permissions.workspace ? [
    note ? `【当前笔记】${note.title}\n${(note.contentText || "").slice(0, 4000)}${note.selection ? `\n【当前选区】${note.selection}` : ""}` : "",
    asset ? `【当前素材】${asset.name}${asset.kind ? ` | ${asset.kind}` : ""}${asset.description ? `\n描述: ${asset.description}` : ""}${asset.libraryPath ? `\n路径: ${asset.libraryPath}` : ""}` : "",
    canvas?.id ? `【当前画布】${canvas.title || canvas.id}${canvas.selectionId ? `\n选中节点: ${canvas.selectionId}` : ""}` : "",
    graph?.nodeId || graph?.label ? `【当前图谱】${graph.label || graph.nodeId || "节点"}${graph.nodeType ? ` | ${graph.nodeType}` : ""}${graph.nodeId ? `\n节点ID: ${graph.nodeId}` : ""}` : "",
  ].filter(Boolean) : [];
  return [
    "你是 LuckyRay 内置 AI 助手。回答要简洁、可执行，优先围绕素材库、知识库、标签和画布。",
    `当前模型选择: ${input.model}。`,
    `本轮允许的上下文范围: ${enabled}。不要声称已经访问未授权的系统资源。`,
    contextLines.length ? `当前工作区上下文:\n${contextLines.join("\n\n")}` : "",
    input.attachments.length ? `用户附加文件: ${input.attachments.map((file) => `${file.name} (${formatAiFileSize(file.size)})`).join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

export async function listAiConversations(bridge: AiBridge | null | undefined): Promise<AiConversation[]> {
  if (!bridge?.listAiConversations) return [];
  const convs = await bridge.listAiConversations();
  return Array.isArray(convs) ? convs : [];
}

export async function createAiConversation(bridge: AiBridge | null | undefined, title: string): Promise<AiConversation | null> {
  if (!bridge?.createAiConversation) return null;
  return bridge.createAiConversation(title.substring(0, 30) || "新对话");
}

export async function loadAiConversationMessages(bridge: AiBridge | null | undefined, convId: string): Promise<AiMessage[]> {
  if (!bridge?.getAiMessages) return [];
  const rows = await bridge.getAiMessages(convId);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.role !== "system")
    .map((row) => ({
      id: row.id,
      role: row.role === "user" ? "user" : "assistant",
      content: row.role === "user" ? row.content || "" : sanitizeAiVisibleContent(row.content || ""),
      timestamp: row.createdAt ? Date.parse(row.createdAt) : Date.now(),
      actionTruth: row.role === "assistant" ? parseAgentActionTruthDto(row.actionTruth) : null,
    }));
}

export async function appendAiConversationMessage(bridge: AiBridge | null | undefined, convId: string | null, role: "user" | "assistant" | "system", content: string): Promise<void> {
  if (!convId || !bridge?.appendAiMessage) return;
  const safeContent = role === "assistant" ? sanitizeAiVisibleContent(content) : content;
  if (role === "assistant" && !safeContent.trim()) return;
  await bridge.appendAiMessage(convId, role, safeContent);
}

const ORDINARY_HISTORY_MAX_MESSAGES = 32;
const ORDINARY_HISTORY_MAX_BYTES = 64 * 1024;

export async function buildOrdinaryAiConversationMessages(
  bridge: AiBridge | null | undefined,
  conversationId: string,
  currentUserContent: AiUserContent,
): Promise<AiChatMessage[]> {
  const rows = bridge?.getAiMessages ? await bridge.getAiMessages(conversationId) : [];
  const pairs: Array<[AiChatMessage, AiChatMessage]> = [];
  let pendingUser: string | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.role === "user") {
      pendingUser = typeof row.content === "string" ? row.content : "";
      continue;
    }
    if (row.role !== "assistant" || pendingUser === null) continue;
    const assistant = sanitizeAiVisibleContent(typeof row.content === "string" ? row.content : "");
    if (assistant.trim()) {
      pairs.push([
        { role: "user", content: pendingUser },
        { role: "assistant", content: assistant },
      ]);
    }
    pendingUser = null;
  }

  const encoder = new TextEncoder();
  const contentBytes = (content: AiUserContent) => encoder.encode(
    typeof content === "string" ? content : JSON.stringify(content),
  ).byteLength;
  let usedBytes = contentBytes(currentUserContent);
  const selected: Array<[AiChatMessage, AiChatMessage]> = [];
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if ((selected.length + 1) * 2 + 1 > ORDINARY_HISTORY_MAX_MESSAGES) break;
    const pair = pairs[index]!;
    const pairBytes = contentBytes(pair[0].content) + contentBytes(pair[1].content);
    if (pairBytes > ORDINARY_HISTORY_MAX_BYTES - usedBytes) continue;
    usedBytes += pairBytes;
    selected.push(pair);
  }
  selected.reverse();
  return [
    ...selected.flatMap(([user, assistant]) => [user, assistant]),
    { role: "user", content: currentUserContent },
  ];
}

const SAFE_AI_STREAM_ERRORS = {
  no_api_key: "AI 尚未配置",
  unauthorized: "AI 服务认证失败",
  rate_limited: "AI 服务请求过于频繁",
  timeout: "AI 请求超时",
  connection: "AI 服务连接失败",
  invalid_stream: "AI 流式响应格式无效",
  empty_response: "AI 未返回可显示内容",
  cancelled: "AI 响应已停止",
  provider_error: "AI 服务返回错误",
} as const;

export type SafeAiStreamFailure = {
  kind: keyof typeof SAFE_AI_STREAM_ERRORS;
  message: string;
};

export function safeAiStreamFailure(value: unknown): SafeAiStreamFailure {
  const candidate = value && typeof value === "object"
    ? (value as { error_kind?: unknown; errorKind?: unknown }).error_kind
      ?? (value as { errorKind?: unknown }).errorKind
    : value;
  const kind = typeof candidate === "string" && candidate in SAFE_AI_STREAM_ERRORS
    ? candidate as keyof typeof SAFE_AI_STREAM_ERRORS
    : "provider_error";
  return { kind, message: SAFE_AI_STREAM_ERRORS[kind] };
}

export async function finalizeAiAssistantResponse(
  bridge: AiBridge | null | undefined,
  conversationId: string | null,
  response: any,
  streamedContent: string,
): Promise<{ content: string; status: string | null; persisted: boolean }> {
  const settlement = projectAiAssistantResponse(response, streamedContent);
  if (!settlement.persisted) return settlement;
  await appendAiConversationMessage(bridge, conversationId, "assistant", settlement.content);
  if (conversationId) publishAiConversationUpdated(conversationId);
  return settlement;
}

function projectAiAssistantResponse(
  response: any,
  streamedContent: string,
): { content: string; status: string | null; persisted: boolean } {
  if (response?.success === false) {
    const failure = safeAiStreamFailure(response);
    const partial = sanitizeAiVisibleContent(streamedContent);
    return {
      content: partial ? `${partial}\n\n（响应未完成）` : "",
      status: failure.message,
      persisted: false,
    };
  }
  const content = sanitizeAiVisibleContent(response?.content || streamedContent || response?.text || "");
  if (!content.trim()) {
    return { content: "", status: SAFE_AI_STREAM_ERRORS.empty_response, persisted: false };
  }
  return { content, status: null, persisted: true };
}

export async function finalizeAiConversationPair(
  bridge: AiBridge | null | undefined,
  conversationId: string | null,
  userContent: string,
  response: any,
  streamedContent: string,
): Promise<{ content: string; status: string | null; persisted: boolean }> {
  const settlement = projectAiAssistantResponse(response, streamedContent);
  if (!settlement.persisted || !conversationId) return settlement;
  await persistAiConversationPair(bridge, conversationId, userContent, settlement.content);
  return settlement;
}

export async function persistAiConversationPair(
  bridge: AiBridge | null | undefined,
  conversationId: string | null,
  userContent: string,
  assistantContent: string,
): Promise<boolean> {
  if (!conversationId) return false;
  const safeAssistantContent = sanitizeAiVisibleContent(assistantContent);
  if (!safeAssistantContent.trim()) return false;
  if (bridge?.appendAiConversationPair) {
    await bridge.appendAiConversationPair(conversationId, userContent, safeAssistantContent);
  } else {
    await appendAiConversationMessage(bridge, conversationId, "user", userContent);
    await appendAiConversationMessage(bridge, conversationId, "assistant", safeAssistantContent);
  }
  publishAiConversationUpdated(conversationId);
  return true;
}

export async function completeAiChat(bridge: AiBridge | null | undefined, messages: AiChatMessage[], options: { systemPrompt: string; temperature: number; maxTokens: number }) {
  if (!bridge?.aiChatComplete) throw new Error("AI 功能未就绪，请检查桥接层。");
  return bridge.aiChatComplete(messages, options);
}

type AiStreamPayload = {
  stream_id?: string;
  streamId?: string;
  delta?: string | null;
  done?: boolean;
  error_kind?: string | null;
  errorKind?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
};

type AiStreamTerminalResult = {
  success?: boolean;
  content?: string | null;
  error_kind?: string | null;
  errorKind?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
};

export type AiStreamTransport = {
  listen: (eventName: string, handler: (event: { payload?: AiStreamPayload }) => void) => Promise<() => void>;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
};

export async function streamAiChatWithTransport(
  transport: AiStreamTransport,
  messages: AiChatMessage[],
  options: { systemPrompt: string; temperature: number; maxTokens: number },
  onDelta: (delta: string, fullText: string) => void,
  streamId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`,
) {
  const visibleStream = createAiVisibleContentStream();
  let fullText = "";
  let eventTerminal = false;
  let settled = false;
  const unlisten = await transport.listen("luckyray-ai-stream", (event) => {
    if (settled || eventTerminal) return;
    const payload = event.payload || {};
    const payloadId = payload.stream_id || payload.streamId;
    if (payloadId !== streamId) return;
    if (payload.delta) {
      const safeDelta = visibleStream.push(payload.delta);
      if (safeDelta) {
        fullText += safeDelta;
        onDelta(safeDelta, fullText);
      }
    }
    if (payload.done) eventTerminal = true;
  });
  let terminal: unknown;
  try {
    const raw = await transport.invoke("ai_chat_stream", {
      request: {
        stream_id: streamId,
        messages,
        system_prompt: options.systemPrompt,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      },
    });
    terminal = typeof raw === "object" && raw !== null
      ? { ...(raw as Record<string, unknown>), content: (raw as Record<string, unknown>).content || sanitizeAiVisibleContent(fullText) || undefined }
      : raw;
  } finally {
    settled = true;
    visibleStream.finish();
    unlisten();
  }

  const typedTerminal = terminal && typeof terminal === "object"
    && typeof (terminal as AiStreamTerminalResult).success === "boolean"
    ? terminal as AiStreamTerminalResult
    : null;
  const failure = visibleStream.failureKind()
    ? safeAiStreamFailure("invalid_stream")
    : typedTerminal?.success === false
      ? safeAiStreamFailure(typedTerminal)
      : typedTerminal?.success === true
        ? null
        : safeAiStreamFailure("invalid_stream");
  if (failure) {
    return { success: false, error_kind: failure.kind, error_message: failure.message };
  }
  const terminalContent = sanitizeAiVisibleContent(typedTerminal?.content || fullText);
  if (!terminalContent.trim()) {
    return { success: false, error_kind: "empty_response", error_message: "AI 未返回可显示内容" };
  }
  return { success: true, content: terminalContent };
}

export type AiChatStreamDependencies = {
  transport?: AiStreamTransport;
  complete: () => Promise<any>;
};

export async function streamAiChatWithDependencies(
  dependencies: AiChatStreamDependencies,
  messages: AiChatMessage[],
  options: { systemPrompt: string; temperature: number; maxTokens: number },
  onDelta: (delta: string, fullText: string) => void,
  streamId?: string,
) {
  const runFallback = async () => {
    try {
      const response = await dependencies.complete();
      if (response?.success === false) {
        const failure = safeAiStreamFailure(response);
        return { success: false, error_kind: failure.kind, error_message: failure.message };
      }
      const content = sanitizeAiVisibleContent(response?.content || response?.text || "");
      if (!content.trim()) {
        const failure = safeAiStreamFailure("empty_response");
        return { success: false, error_kind: failure.kind, error_message: failure.message };
      }
      onDelta(content, content);
      return { success: true, content };
    } catch {
      const failure = safeAiStreamFailure("provider_error");
      return { success: false, error_kind: failure.kind, error_message: failure.message };
    }
  };

  if (!dependencies.transport) return runFallback();
  let invokeStarted = false;
  const trackedTransport: AiStreamTransport = {
    listen: dependencies.transport.listen,
    invoke: (command, args) => {
      invokeStarted = true;
      return dependencies.transport!.invoke(command, args);
    },
  };
  try {
    return await streamAiChatWithTransport(trackedTransport, messages, options, onDelta, streamId);
  } catch {
    if (!invokeStarted) return runFallback();
    const failure = safeAiStreamFailure("provider_error");
    return { success: false, error_kind: failure.kind, error_message: failure.message };
  }
}

export async function streamAiChat(
  bridge: AiBridge | null | undefined,
  messages: AiChatMessage[],
  options: { systemPrompt: string; temperature: number; maxTokens: number },
  onDelta: (delta: string, fullText: string) => void,
  streamId?: string,
) {
  let transport: AiStreamTransport | undefined;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    transport = {
      invoke: (command, args) => invoke(command, args),
      listen: (eventName, handler) => listen<AiStreamPayload>(eventName, handler),
    };
  } catch {
    transport = undefined;
  }
  return streamAiChatWithDependencies({
    transport,
    complete: () => completeAiChat(bridge, messages, options),
  }, messages, options, onDelta, streamId);
}

export const AI_CONVERSATION_UPDATED_EVENT = "luckyray:ai-conversation-updated";

export function publishAiConversationUpdated(conversationId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AI_CONVERSATION_UPDATED_EVENT, {
    detail: { conversationId },
  }));
}

type AiChatStreamRunner = typeof streamAiChat;

export async function runPersistedAiChatTurn(input: {
  bridge: AiBridge | null | undefined;
  conversationId: string;
  userContentForPersistence: string;
  messages: AiChatMessage[];
  options: { systemPrompt: string; temperature: number; maxTokens: number };
  streamId: string;
  ownerIsActive: () => boolean;
  onVisibleText: (text: string) => void;
  runStream?: AiChatStreamRunner;
}) {
  let streamedContent = "";
  const response = await (input.runStream ?? streamAiChat)(
    input.bridge,
    input.messages,
    input.options,
    (_delta, fullText) => {
      streamedContent = fullText;
      if (input.ownerIsActive()) input.onVisibleText(fullText);
    },
    input.streamId,
  );
  const settlement = await finalizeAiConversationPair(
    input.bridge,
    input.conversationId,
    input.userContentForPersistence,
    response,
    streamedContent,
  );
  return settlement;
}

export async function cancelAiChatStream(streamId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_chat_cancel", { streamId });
}
