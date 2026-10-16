import { getLocalApiBaseUrl, localApiFetch } from "../localApi";
import { readActiveContext } from "../activeContext";
import {
  ensureActiveKnowledgeUiSource,
  type KnowledgeDocumentRef,
  type KnowledgeMutationResult,
  type KnowledgeUiSourceActivation,
} from "./knowledge";

export type LocalCapability = {
  id: string;
  type: "skill" | "extension" | "workflow" | string;
  name: string;
  description?: string;
  parameters?: CapabilityParameterSchema[];
  resultActions?: CapabilityResultAction[];
  enabled?: boolean;
  available?: boolean;
  unavailableCode?: string | null;
  unavailableReason?: string | null;
  status?: "ready" | "ok" | "error" | "unavailable" | string;
  lastRunAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
};

export function isCapabilityAvailable(capability: LocalCapability): boolean {
  return capability.available !== false;
}

export function isCapabilityRunnable(capability: LocalCapability): boolean {
  return isCapabilityAvailable(capability) && capability.enabled === true;
}

export type CapabilityRunResult = {
  ok?: boolean;
  id?: string;
  status?: string;
  code?: string | null;
  summary?: string;
  lastResult?: string | null;
  lastError?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  indexWarning?: KnowledgeMutationResult["indexWarning"];
  indexStale?: boolean;
};

export type CapabilityRunParameters = Record<string, string | number | boolean>;

export const CAPABILITY_RUN_HISTORY_VERSION = 2 as const;

export type CapabilityRunInputSummary = {
  kind: "empty" | "text" | "structured" | "unknown";
  charCount: number;
  byteCount: number;
  parameterCount: number;
  hasUrl: boolean;
  urlScheme?: "http" | "https" | "other";
  hasDocumentRef: boolean;
  truncated: boolean;
};

export type CapabilityRunOutcomeSummary = {
  status: "success" | "failure";
  code: string;
  category: "success" | "capability" | "knowledge" | "network" | "http" | "unknown";
  message: string;
  httpStatus?: number;
  resultKind?: "summary" | "search" | "document-created" | "success";
  documentCount?: number;
  assetCount?: number;
  indexWarningCode?: string;
  indexStale?: boolean;
};

export type CapabilityActionRisk = "read" | "write" | "dangerous";
export type CapabilityActionPhase = "proposal" | "approved" | "denied" | "invalidated" | "succeeded" | "failed" | "committed-warning";

export type CapabilityActionPolicy = {
  capabilityId: string;
  risk: CapabilityActionRisk;
  impact: string;
};

export type CapabilityRunLog = {
  version: typeof CAPABILITY_RUN_HISTORY_VERSION;
  id: string;
  capabilityId: string;
  ok: boolean;
  surface: "ai" | "community" | "public-iframe" | "unknown";
  risk: CapabilityActionRisk;
  phase: CapabilityActionPhase;
  timeline: CapabilityActionPhase[];
  inputSummary: CapabilityRunInputSummary;
  outcome: CapabilityRunOutcomeSummary;
  time: number;
};

export type CapabilityRunHistoryEvent = {
  capabilityId: string;
  surface?: string;
  input?: unknown;
  result?: CapabilityRunResult | null;
  error?: unknown;
  time?: number;
  actionId?: string;
  risk?: CapabilityActionRisk;
  phase?: CapabilityActionPhase;
  timeline?: CapabilityActionPhase[];
};

export type CapabilityParameterType = "string" | "number" | "boolean" | "select";

export type CapabilityParameterSchema = {
  key: string;
  label: string;
  type: CapabilityParameterType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: string | number | boolean | null;
  options?: Array<{ label: string; value: string | number | boolean }>;
};

export type CapabilityResultAction = "record" | "copy" | "appendCurrentNote" | "createNote" | "navigateDocument";

export type CapabilityRunInput = string | {
  text?: string;
  params?: CapabilityRunParameters;
  source?: "ai" | "community" | "workflow" | string;
  sourceEpoch?: number;
  documentRef?: KnowledgeDocumentRef;
  documentId?: string;
  expectedRevision?: string | null;
};

export class CapabilityServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CapabilityServiceError";
    this.code = code;
  }
}

export type CapabilityRunPreparationDeps = {
  ensureActiveSource(): Promise<KnowledgeUiSourceActivation>;
  readContext(): ReturnType<typeof readActiveContext>;
};

export const KNOWLEDGE_CAPABILITY_IDS = [
  "skill.summary",
  "skill.search_intent",
  "wf.web_to_note",
  "wf.note_to_summary",
] as const;

const KNOWLEDGE_CAPABILITY_ID_SET = new Set<string>(KNOWLEDGE_CAPABILITY_IDS);
const KNOWLEDGE_MUTATION_CAPABILITIES = new Set(["wf.web_to_note", "wf.note_to_summary"]);
const KNOWLEDGE_DOCUMENT_CAPABILITIES = new Set(["skill.summary", "wf.note_to_summary"]);

const CAPABILITY_ACTION_POLICIES: Readonly<Record<string, CapabilityActionPolicy>> = Object.freeze({
  "skill.summary": { capabilityId: "skill.summary", risk: "read", impact: "读取知识库文档并生成摘要" },
  "skill.search_intent": { capabilityId: "skill.search_intent", risk: "read", impact: "搜索知识库索引" },
  "wf.web_to_note": { capabilityId: "wf.web_to_note", risk: "write", impact: "在当前知识库创建 Markdown 文档" },
  "wf.note_to_summary": { capabilityId: "wf.note_to_summary", risk: "write", impact: "读取当前文档并创建摘要文档" },
});

export function canonicalKnowledgeCapabilityId(id: string) {
  switch (id) {
    case "skill_summary": return "skill.summary";
    case "skill_search_intent": return "skill.search_intent";
    case "wf_web_to_note": return "wf.web_to_note";
    case "wf_note_to_summary": return "wf.note_to_summary";
    default: return id;
  }
}

export function isReservedKnowledgeCapabilityId(id: string) {
  return KNOWLEDGE_CAPABILITY_ID_SET.has(canonicalKnowledgeCapabilityId(id));
}

export function capabilityActionPolicy(capabilityId: string): CapabilityActionPolicy {
  const canonicalId = canonicalKnowledgeCapabilityId(capabilityId);
  return CAPABILITY_ACTION_POLICIES[canonicalId] || {
    capabilityId: canonicalId,
    risk: "dangerous",
    impact: "执行未分类的持久操作",
  };
}

function asCapabilityObject(input?: CapabilityRunInput): Exclude<CapabilityRunInput, string> {
  if (!input) return {};
  return typeof input === "string" ? { text: input } : { ...input, params: { ...(input.params || {}) } };
}

export async function prepareCapabilityRunInput(
  id: string,
  input?: CapabilityRunInput,
  deps: CapabilityRunPreparationDeps = {
    ensureActiveSource: ensureActiveKnowledgeUiSource,
    readContext: readActiveContext,
  },
): Promise<CapabilityRunInput | undefined> {
  const canonicalId = canonicalKnowledgeCapabilityId(id);
  if (!KNOWLEDGE_MUTATION_CAPABILITIES.has(canonicalId) && !KNOWLEDGE_DOCUMENT_CAPABILITIES.has(canonicalId)) {
    return input;
  }
  const prepared = asCapabilityObject(input);
  const explicitDocument = prepared.documentRef || prepared.documentId || prepared.params?.documentId;
  const hasExplicitText = Boolean(prepared.text?.trim());

  if (KNOWLEDGE_DOCUMENT_CAPABILITIES.has(canonicalId) && !explicitDocument && !hasExplicitText) {
    const note = deps.readContext().note;
    if (note?.documentRef) {
      prepared.documentRef = note.documentRef;
      prepared.expectedRevision = note.revision || null;
    }
  }
  if (KNOWLEDGE_MUTATION_CAPABILITIES.has(canonicalId)) {
    const activation = await deps.ensureActiveSource();
    prepared.sourceEpoch = activation.sourceEpoch;
  }
  return prepared;
}

export type CapabilityParameterPreview = {
  key: string;
  value: string | number | boolean;
  valueType: "string" | "number" | "boolean";
};

export type CapabilityHealth = {
  baseUrl: string;
  ok: boolean;
  checkedAt: number;
};

export type CapabilityDiagnosticSnapshotInput = {
  capabilities: LocalCapability[];
  logs: CapabilityRunLog[];
  health?: CapabilityHealth | null;
  extensionDir?: string;
  generatedAt?: number;
};

export type CapabilitySchemaOverride = {
  capabilityId: string;
  parameters: CapabilityParameterSchema[];
  updatedAt: number;
};

const CAPABILITY_RUN_LOGS_KEY = "luckyray-capability-run-logs-v1";
const CAPABILITY_SCHEMA_OVERRIDES_KEY = "luckyray-capability-schema-overrides-v1";
const MAX_CAPABILITY_RUN_LOGS = 30;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text || `HTTP ${response.status}`;
}

export async function listCapabilities(init?: RequestInit): Promise<LocalCapability[]> {
  const response = await localApiFetch("/api/capability/list", init);
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json().catch(() => ({}));
  return applyCapabilitySchemaOverrides(Array.isArray(data?.capabilities) ? data.capabilities : []);
}

export async function setCapabilityEnabled(id: string, enabled: boolean): Promise<void> {
  const response = await localApiFetch("/api/capability/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, enabled }),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export function parseCapabilityParameterText(input: string): CapabilityRunParameters {
  const params: CapabilityRunParameters = {};
  for (const match of input.matchAll(/(?:^|\s)([a-zA-Z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    if (/^(true|false)$/i.test(raw)) {
      params[match[1]] = raw.toLowerCase() === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      params[match[1]] = Number(raw);
    } else {
      params[match[1]] = raw;
    }
  }
  return params;
}

export function stripCapabilityParameterText(input: string): string {
  return input
    .replace(/(?:^|\s)([a-zA-Z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getCapabilityParameterPreview(input: string): CapabilityParameterPreview[] {
  return Object.entries(parseCapabilityParameterText(input)).map(([key, value]) => ({
    key,
    value,
    valueType: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",
  }));
}

function coerceCapabilityParameterValue(schema: CapabilityParameterSchema, raw: string | number | boolean): string | number | boolean {
  if (schema.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    return /^(true|1|yes|on)$/i.test(String(raw));
  }
  if (schema.type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }
  return String(raw);
}

function isEmptyCapabilityValue(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function readCapabilityRunParams(input: CapabilityRunInput | string | undefined): CapabilityRunParameters {
  if (!input) return {};
  if (typeof input === "string") return parseCapabilityParameterText(input);
  return input.params || {};
}

function capabilityValueMatchesOption(value: string | number | boolean, schema: CapabilityParameterSchema) {
  return (schema.options || []).some((option) => String(option.value) === String(value));
}

const KNOWLEDGE_CAPABILITY_HISTORY_IDS = KNOWLEDGE_CAPABILITY_ID_SET;
const SAFE_CAPABILITY_HISTORY_CODES = new Set([
  "ok",
  "capability-disabled",
  "capability-unavailable",
  "capability-catalog-not-ready",
  "capability-not-found",
  "capability-run-failed",
  "capability-input-required",
  "capability-input-too-large",
  "capability-input-invalid",
  "capability-web-source-invalid",
  "capability-parameter-invalid",
  "knowledge-vault-required",
  "knowledge-vault-not-current",
  "knowledge-vault-mismatch",
  "knowledge-source-inactive",
  "knowledge-current-context-required",
  "knowledge-revision-conflict",
  "knowledge-invalid-document-ref",
  "knowledge-index-refresh-failed",
  "knowledge-index-stale",
  "legacy-db-note-retired",
  "material-catalog-error",
  "network-error",
  "request-timeout",
  "capability-action-pending",
  "capability-action-approved",
  "capability-action-denied",
  "capability-action-invalidated",
  "capability-action-superseded",
]);
const SAFE_CAPABILITY_ACTION_PHASES = new Set<CapabilityActionPhase>([
  "proposal", "approved", "denied", "invalidated", "succeeded", "failed", "committed-warning",
]);
const SAFE_CAPABILITY_RESULT_KINDS = new Set(["summary", "search", "document-created"]);
const MAX_CAPABILITY_HISTORY_STRING = 96;
const MAX_CAPABILITY_INPUT_SCAN_CHARS = 1024 * 1024;
const MAX_CAPABILITY_INPUT_COUNT = 10_000_000;
const MAX_CAPABILITY_HISTORY_JSON_BYTES = 16 * 1024;
let capabilityHistorySequence = 0;

function safeProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    return Reflect.get(value as object, key);
  } catch {
    return undefined;
  }
}

function safeCapabilityString(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeIdentifier(value: unknown, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, MAX_CAPABILITY_HISTORY_STRING);
  return normalized && /^[a-zA-Z0-9._:-]+$/.test(normalized) ? normalized : fallback;
}

function safeSurface(value: unknown): CapabilityRunLog["surface"] {
  return value === "ai" || value === "community" || value === "public-iframe" ? value : "unknown";
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_CAPABILITY_INPUT_COUNT, Math.floor(value)))
    : 0;
}

function nextCapabilityHistoryId(capabilityId: string, time: number) {
  capabilityHistorySequence = (capabilityHistorySequence + 1) >>> 0;
  const nonce = ((Date.now() >>> 0) ^ capabilityHistorySequence ^ Math.floor(Math.random() * 0xffff_ffff)) >>> 0;
  return `${capabilityId}-${time}-${nonce.toString(16).padStart(8, "0")}`.slice(0, MAX_CAPABILITY_HISTORY_STRING);
}

function normalizedCapabilityHistoryId(value: unknown, capabilityId: string, time: number) {
  const prefix = `${capabilityId}-${time}-`;
  return typeof value === "string"
    && value.startsWith(prefix)
    && /^[0-9a-f]{8}$/.test(value.slice(prefix.length))
    ? value
    : null;
}

function safeBoolean(value: unknown) {
  return value === true;
}

function safeActionRisk(value: unknown, capabilityId: string): CapabilityActionRisk {
  return value === "read" || value === "write" || value === "dangerous"
    ? value
    : capabilityActionPolicy(capabilityId).risk;
}

function safeActionPhase(value: unknown, fallback: CapabilityActionPhase): CapabilityActionPhase {
  return typeof value === "string" && SAFE_CAPABILITY_ACTION_PHASES.has(value as CapabilityActionPhase)
    ? value as CapabilityActionPhase
    : fallback;
}

function safeActionTimeline(value: unknown, phase: CapabilityActionPhase) {
  const source = Array.isArray(value) ? value : [];
  const timeline = source
    .map((item) => safeActionPhase(item, phase))
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, 7);
  if (!timeline.includes(phase)) timeline.push(phase);
  return timeline;
}

function safeHistoryCode(value: unknown, fallback = "capability-run-failed") {
  return typeof value === "string" && SAFE_CAPABILITY_HISTORY_CODES.has(value) ? value : fallback;
}

function errorCategory(code: string): CapabilityRunOutcomeSummary["category"] {
  if (code.startsWith("knowledge-") || code === "legacy-db-note-retired") return "knowledge";
  if (code === "network-error" || code === "request-timeout") return "network";
  if (code.startsWith("http-")) return "http";
  if (code.startsWith("capability-") || code === "material-catalog-error") return "capability";
  return "unknown";
}

function fixedErrorMessage(category: CapabilityRunOutcomeSummary["category"]) {
  switch (category) {
    case "knowledge": return "Knowledge capability failed";
    case "network": return "Capability request failed";
    case "http": return "Capability service returned an error";
    case "capability": return "Capability run failed";
    default: return "Capability run failed";
  }
}

function stringMetrics(value: string) {
  const scan = value.slice(0, MAX_CAPABILITY_INPUT_SCAN_CHARS);
  let bytes = 0;
  for (const character of scan) {
    const point = character.codePointAt(0) || 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return {
    chars: Math.min(value.length, MAX_CAPABILITY_INPUT_COUNT),
    bytes: Math.min(bytes, MAX_CAPABILITY_INPUT_COUNT),
    truncated: value.length > scan.length,
  };
}

function addInputMetric(summary: CapabilityRunInputSummary, value: unknown) {
  if (typeof value !== "string") return;
  const metric = stringMetrics(value);
  summary.charCount = Math.min(MAX_CAPABILITY_INPUT_COUNT, summary.charCount + metric.chars);
  summary.byteCount = Math.min(MAX_CAPABILITY_INPUT_COUNT, summary.byteCount + metric.bytes);
  summary.truncated ||= metric.truncated;
}

function safeObjectKeyCount(value: unknown) {
  if (typeof value !== "object" || value === null) return 0;
  try {
    return Math.min(64, Object.keys(value).length);
  } catch {
    return 0;
  }
}

function safeUrlScheme(value: unknown): CapabilityRunInputSummary["urlScheme"] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  return scheme === "http" || scheme === "https" ? scheme : "other";
}

export function summarizeCapabilityRunInput(capabilityId: string, input: unknown): CapabilityRunInputSummary {
  const summary: CapabilityRunInputSummary = {
    kind: input === undefined || input === null || input === "" ? "empty" : typeof input === "string" ? "text" : typeof input === "object" ? "structured" : "unknown",
    charCount: 0,
    byteCount: 0,
    parameterCount: 0,
    hasUrl: false,
    hasDocumentRef: false,
    truncated: false,
  };
  if (typeof input === "string") {
    addInputMetric(summary, input);
    return summary;
  }
  if (!KNOWLEDGE_CAPABILITY_HISTORY_IDS.has(canonicalKnowledgeCapabilityId(capabilityId)) || typeof input !== "object" || input === null) {
    return summary;
  }
  const params = safeProperty(input, "params");
  summary.parameterCount = safeObjectKeyCount(params);
  for (const key of ["text", "content", "query", "prompt", "title", "documentId", "expectedRevision"]) {
    addInputMetric(summary, safeProperty(input, key));
    addInputMetric(summary, safeProperty(params, key));
  }
  const documentRef = safeProperty(input, "documentRef") ?? safeProperty(params, "documentRef");
  const documentId = safeProperty(input, "documentId") ?? safeProperty(params, "documentId");
  summary.hasDocumentRef = Boolean(documentRef || (typeof documentId === "string" && documentId));
  addInputMetric(summary, safeProperty(documentRef, "vaultId"));
  addInputMetric(summary, safeProperty(documentRef, "relativePath"));
  const url = safeProperty(input, "url") ?? safeProperty(params, "url");
  summary.urlScheme = safeUrlScheme(url);
  summary.hasUrl = summary.urlScheme !== undefined;
  return summary;
}

function safeArrayLength(value: unknown) {
  try {
    return Array.isArray(value) ? Math.min(1_000, value.length) : undefined;
  } catch {
    return undefined;
  }
}

function successOutcome(result: CapabilityRunResult | null | undefined): CapabilityRunOutcomeSummary {
  const resultValue = safeProperty(result, "result");
  const rawKind = safeProperty(resultValue, "kind");
  const resultKind = typeof rawKind === "string" && SAFE_CAPABILITY_RESULT_KINDS.has(rawKind)
    ? rawKind as CapabilityRunOutcomeSummary["resultKind"]
    : "success";
  const warning = safeProperty(result, "indexWarning");
  const indexWarningCode = safeHistoryCode(safeProperty(warning, "code"), "knowledge-index-stale");
  const hasWarning = warning !== undefined && warning !== null;
  return {
    status: "success",
    code: "ok",
    category: "success",
    message: "Capability run succeeded",
    resultKind,
    documentCount: safeArrayLength(safeProperty(resultValue, "documents")),
    assetCount: safeArrayLength(safeProperty(resultValue, "assets")),
    indexWarningCode: hasWarning ? indexWarningCode : undefined,
    indexStale: safeBoolean(safeProperty(result, "indexStale")) || hasWarning || undefined,
  };
}

function failureOutcome(error: unknown): CapabilityRunOutcomeSummary {
  const code = safeHistoryCode(safeProperty(error, "code"));
  const category = errorCategory(code);
  const rawStatus = safeProperty(error, "status");
  const httpStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : undefined;
  return {
    status: "failure",
    code,
    category,
    message: fixedErrorMessage(category),
    httpStatus,
  };
}

export function createCapabilityRunHistoryEntry(event: CapabilityRunHistoryEvent): CapabilityRunLog {
  const capabilityId = safeIdentifier(event.capabilityId, "unknown").slice(0, 48);
  const time = typeof event.time === "number" && Number.isFinite(event.time) ? Math.max(0, Math.floor(event.time)) : Date.now();
  const outcome = event.error === undefined ? successOutcome(event.result) : failureOutcome(event.error);
  const inferredPhase: CapabilityActionPhase = outcome.status === "success"
    ? outcome.indexWarningCode || outcome.indexStale ? "committed-warning" : "succeeded"
    : "failed";
  const phase = safeActionPhase(event.phase, inferredPhase);
  const actionId = normalizedCapabilityHistoryId(event.actionId, capabilityId, time);
  return {
    version: CAPABILITY_RUN_HISTORY_VERSION,
    id: actionId || nextCapabilityHistoryId(capabilityId, time),
    capabilityId,
    ok: outcome.status === "success",
    surface: safeSurface(event.surface),
    risk: safeActionRisk(event.risk, capabilityId),
    phase,
    timeline: safeActionTimeline(event.timeline, phase),
    inputSummary: summarizeCapabilityRunInput(capabilityId, event.input),
    outcome,
    time,
  };
}

function normalizeCapabilityRunLog(item: unknown): CapabilityRunLog | null {
  if (safeProperty(item, "version") !== CAPABILITY_RUN_HISTORY_VERSION) return null;
  const capabilityId = safeIdentifier(safeProperty(item, "capabilityId"), "").slice(0, 48);
  if (!capabilityId) return null;
  const rawTime = safeProperty(item, "time");
  if (typeof rawTime !== "number" || !Number.isFinite(rawTime) || rawTime < 0) return null;
  const time = Math.floor(rawTime);
  const input = safeProperty(item, "inputSummary");
  const outcomeValue = safeProperty(item, "outcome");
  if (typeof input !== "object" || input === null || typeof outcomeValue !== "object" || outcomeValue === null) return null;
  const rawStatus = safeProperty(outcomeValue, "status");
  if (rawStatus !== "success" && rawStatus !== "failure") return null;
  const status = rawStatus;
  const code = status === "success" ? "ok" : safeHistoryCode(safeProperty(outcomeValue, "code"));
  const category = status === "success" ? "success" : errorCategory(code);
  const rawKind = safeProperty(outcomeValue, "resultKind");
  const resultKind = status === "success" && typeof rawKind === "string" && (SAFE_CAPABILITY_RESULT_KINDS.has(rawKind) || rawKind === "success")
    ? rawKind as CapabilityRunOutcomeSummary["resultKind"]
    : status === "success" ? "success" : undefined;
  const httpStatusValue = safeCount(safeProperty(outcomeValue, "httpStatus"));
  const httpStatus = httpStatusValue >= 400 && httpStatusValue <= 599 ? httpStatusValue : undefined;
  const warningValue = safeProperty(outcomeValue, "indexWarningCode");
  const indexWarningCode = typeof warningValue === "string"
    ? safeHistoryCode(warningValue, "knowledge-index-stale")
    : undefined;
  const inputKindValue = safeProperty(input, "kind");
  const kind: CapabilityRunInputSummary["kind"] = inputKindValue === "empty" || inputKindValue === "text" || inputKindValue === "structured"
    ? inputKindValue
    : "unknown";
  const schemeValue = safeProperty(input, "urlScheme");
  const urlScheme = schemeValue === "http" || schemeValue === "https" || schemeValue === "other" ? schemeValue : undefined;
  const id = normalizedCapabilityHistoryId(safeProperty(item, "id"), capabilityId, time);
  if (!id) return null;
  const inferredPhase: CapabilityActionPhase = status === "success"
    ? safeBoolean(safeProperty(outcomeValue, "indexStale")) || warningValue ? "committed-warning" : "succeeded"
    : "failed";
  const phase = safeActionPhase(safeProperty(item, "phase"), inferredPhase);
  return {
    version: CAPABILITY_RUN_HISTORY_VERSION,
    id,
    capabilityId,
    ok: status === "success",
    surface: safeSurface(safeProperty(item, "surface")),
    risk: safeActionRisk(safeProperty(item, "risk"), capabilityId),
    phase,
    timeline: safeActionTimeline(safeProperty(item, "timeline"), phase),
    inputSummary: {
      kind,
      charCount: safeCount(safeProperty(input, "charCount")),
      byteCount: safeCount(safeProperty(input, "byteCount")),
      parameterCount: Math.min(64, safeCount(safeProperty(input, "parameterCount"))),
      hasUrl: safeBoolean(safeProperty(input, "hasUrl")),
      urlScheme,
      hasDocumentRef: safeBoolean(safeProperty(input, "hasDocumentRef")),
      truncated: safeBoolean(safeProperty(input, "truncated")),
    },
    outcome: {
      status,
      code,
      category,
      message: status === "success" ? "Capability run succeeded" : fixedErrorMessage(category),
      httpStatus,
      resultKind,
      documentCount: status === "success" ? safeCount(safeProperty(outcomeValue, "documentCount")) : undefined,
      assetCount: status === "success" ? safeCount(safeProperty(outcomeValue, "assetCount")) : undefined,
      indexWarningCode,
      indexStale: (status === "success" && safeBoolean(safeProperty(outcomeValue, "indexStale"))) || undefined,
    },
    time,
  };
}

function formatCapabilityParameterValue(value: string | number | boolean): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return /\s|"/.test(value) ? JSON.stringify(value) : value;
}

function stringifyCapabilityInput(text: string, params: CapabilityRunParameters): string {
  const paramText = Object.entries(params)
    .map(([key, value]) => `${key}=${formatCapabilityParameterValue(value)}`)
    .join(" ");
  return [text.trim(), paramText].filter(Boolean).join(text.trim() && paramText ? " " : "");
}

export function getCapabilityParameterFieldValue(input: string, schema: CapabilityParameterSchema): string | number | boolean {
  const params = parseCapabilityParameterText(input);
  if (params[schema.key] !== undefined) return params[schema.key];
  if (schema.defaultValue !== undefined && schema.defaultValue !== null) return schema.defaultValue;
  return schema.type === "boolean" ? false : "";
}

export function setCapabilityParameterValue(input: string, schema: CapabilityParameterSchema, rawValue: string | number | boolean): string {
  const text = stripCapabilityParameterText(input);
  const params = parseCapabilityParameterText(input);
  const value = coerceCapabilityParameterValue(schema, rawValue);
  if (value === "" && !schema.required) {
    delete params[schema.key];
  } else {
    params[schema.key] = value;
  }
  return stringifyCapabilityInput(text, params);
}

export function buildCapabilityRunInput(input: string, source = "community", schemas: CapabilityParameterSchema[] = []): CapabilityRunInput {
  const params = parseCapabilityParameterText(input);
  for (const schema of schemas) {
    if (params[schema.key] !== undefined || schema.defaultValue === undefined || schema.defaultValue === null || schema.defaultValue === "") continue;
    params[schema.key] = coerceCapabilityParameterValue(schema, schema.defaultValue);
  }
  const text = stripCapabilityParameterText(input);
  return Object.keys(params).length ? { text, params, source: String(source) } : text;
}

export function validateCapabilityRunInput(input: CapabilityRunInput | string | undefined, schemas: CapabilityParameterSchema[] = []): string[] {
  if (!schemas.length) return [];
  const params = readCapabilityRunParams(input);
  const errors: string[] = [];

  for (const schema of schemas) {
    const label = schema.label || schema.key;
    const value = params[schema.key] !== undefined ? params[schema.key] : schema.defaultValue;
    if (schema.required && isEmptyCapabilityValue(value)) {
      errors.push(`${label} 为必填项`);
      continue;
    }
    if (isEmptyCapabilityValue(value)) continue;
    if (schema.type === "number" && !Number.isFinite(Number(value))) {
      errors.push(`${label} 必须是数字`);
    }
    if (schema.type === "boolean" && typeof value !== "boolean" && !/^(true|false|1|0|yes|no|on|off)$/i.test(String(value))) {
      errors.push(`${label} 必须是开关值`);
    }
    if (schema.type === "select" && !capabilityValueMatchesOption(value as string | number | boolean, schema)) {
      errors.push(`${label} 必须从可选项中选择`);
    }
  }

  return errors;
}

export function assertValidCapabilityRunInput(input: CapabilityRunInput | string | undefined, schemas: CapabilityParameterSchema[] = []) {
  const errors = validateCapabilityRunInput(input, schemas);
  if (errors.length) throw new Error(`参数校验失败：${errors.join("；")}`);
}

function normalizeCapabilityParameterSchema(item: any): CapabilityParameterSchema | null {
  const key = safeCapabilityString(item?.key).trim();
  const type = safeCapabilityString(item?.type).trim() as CapabilityParameterType;
  if (!key || !["string", "number", "boolean", "select"].includes(type)) return null;
  const rawOptions = Array.isArray(item?.options) ? item.options : [];
  const options = rawOptions
    .map((option: any) => {
      if (!option || option.value === undefined || option.value === null) return null;
      return {
        label: safeCapabilityString(option.label || option.value),
        value: typeof option.value === "number" || typeof option.value === "boolean" ? option.value : safeCapabilityString(option.value),
      };
    })
    .filter((option: { label: string; value: string | number | boolean } | null): option is { label: string; value: string | number | boolean } => Boolean(option));
  return {
    key,
    label: safeCapabilityString(item?.label || key),
    type,
    required: Boolean(item?.required),
    placeholder: item?.placeholder ? safeCapabilityString(item.placeholder) : undefined,
    description: item?.description ? safeCapabilityString(item.description) : undefined,
    defaultValue: item?.defaultValue === undefined || item?.defaultValue === null ? undefined : item.defaultValue,
    options: type === "select" ? options : undefined,
  };
}

export function parseCapabilitySchemaJson(value: string): CapabilityParameterSchema[] {
  const parsed = JSON.parse(value || "[]");
  if (!Array.isArray(parsed)) throw new Error("schema 必须是数组");
  const schemas = parsed.map(normalizeCapabilityParameterSchema);
  const invalidIndex = schemas.findIndex((item) => !item);
  if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 个字段缺少 key 或 type`);
  const keys = new Set<string>();
  for (const schema of schemas as CapabilityParameterSchema[]) {
    if (keys.has(schema.key)) throw new Error(`字段 key 重复：${schema.key}`);
    keys.add(schema.key);
    if (schema.type === "select" && !schema.options?.length) throw new Error(`select 字段 ${schema.key} 必须提供 options`);
  }
  return schemas as CapabilityParameterSchema[];
}

export function readCapabilitySchemaOverrides(): Record<string, CapabilitySchemaOverride> {
  try {
    const raw = localStorage.getItem(CAPABILITY_SCHEMA_OVERRIDES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, CapabilitySchemaOverride> = {};
    for (const [capabilityId, value] of Object.entries(parsed as Record<string, any>)) {
      const parameters = Array.isArray(value?.parameters)
        ? value.parameters.map(normalizeCapabilityParameterSchema).filter((item: CapabilityParameterSchema | null): item is CapabilityParameterSchema => Boolean(item))
        : [];
      result[capabilityId] = {
        capabilityId,
        parameters,
        updatedAt: Number(value?.updatedAt) || Date.now(),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeCapabilitySchemaOverrides(overrides: Record<string, CapabilitySchemaOverride>) {
  try {
    localStorage.setItem(CAPABILITY_SCHEMA_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {}
}

export function saveCapabilitySchemaOverride(capabilityId: string, parameters: CapabilityParameterSchema[]) {
  const id = capabilityId.trim();
  if (!id) throw new Error("能力 ID 不能为空");
  const overrides = readCapabilitySchemaOverrides();
  overrides[id] = { capabilityId: id, parameters, updatedAt: Date.now() };
  writeCapabilitySchemaOverrides(overrides);
}

export function clearCapabilitySchemaOverride(capabilityId: string) {
  const overrides = readCapabilitySchemaOverrides();
  delete overrides[capabilityId];
  writeCapabilitySchemaOverrides(overrides);
}

export function applyCapabilitySchemaOverrides(capabilities: LocalCapability[]): LocalCapability[] {
  const overrides = readCapabilitySchemaOverrides();
  return capabilities.map((capability) => {
    if (!isCapabilityAvailable(capability)) {
      return { ...capability, enabled: false, parameters: [], resultActions: [] };
    }
    const override = overrides[capability.id];
    return override ? { ...capability, parameters: override.parameters } : capability;
  });
}

export function formatCapabilityRunInput(input?: CapabilityRunInput): string {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  const text = input.text?.trim() || "";
  const entries = Object.entries(input.params || {});
  if (!entries.length) return text;
  const paramText = entries.map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
  return [text, input.source ? `来源: ${input.source}` : "", `参数:\n${paramText}`].filter(Boolean).join("\n");
}

export async function runCapability(id: string, input?: CapabilityRunInput): Promise<CapabilityRunResult> {
  const preparedInput = await prepareCapabilityRunInput(id, input);
  const normalizedInput = formatCapabilityRunInput(preparedInput);
  const payloadInput = typeof preparedInput === "string"
    ? normalizedInput || undefined
    : preparedInput && (
      normalizedInput
      || Object.keys(preparedInput.params || {}).length
      || preparedInput.sourceEpoch !== undefined
      || preparedInput.documentRef !== undefined
      || preparedInput.documentId !== undefined
    )
      ? preparedInput
      : undefined;
  const response = await localApiFetch("/api/capability/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, input: payloadInput }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new CapabilityServiceError(
      String(data?.code || "capability-run-failed"),
      String(data?.lastError || data?.error || `HTTP ${response.status}`),
    );
  }
  return data;
}

export function capabilityRunSuccessText(result: CapabilityRunResult, fallback = "已运行") {
  const base = result.summary || result.lastResult || fallback;
  if ((result.indexWarning || result.indexStale) && !base.includes("索引刷新")) {
    return `${base}，索引刷新稍后重试`;
  }
  return base;
}

function capabilityHistoryStorage(): Storage | null {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function serializeCapabilityRunLogs(logs: CapabilityRunLog[]) {
  const bounded = logs.slice(0, MAX_CAPABILITY_RUN_LOGS);
  while (bounded.length > 0) {
    const serialized = JSON.stringify(bounded);
    if (new TextEncoder().encode(serialized).byteLength <= MAX_CAPABILITY_HISTORY_JSON_BYTES) return serialized;
    bounded.pop();
  }
  return "[]";
}

export function readCapabilityRunLogs(): CapabilityRunLog[] {
  const storage = capabilityHistoryStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CAPABILITY_RUN_LOGS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const logs = Array.isArray(parsed)
      ? parsed
        .map(normalizeCapabilityRunLog)
        .filter((item): item is CapabilityRunLog => Boolean(item))
        .slice(0, MAX_CAPABILITY_RUN_LOGS)
      : [];
    const sanitized = serializeCapabilityRunLogs(logs);
    if (raw && sanitized !== raw) {
      if (logs.length > 0) storage.setItem(CAPABILITY_RUN_LOGS_KEY, sanitized);
      else storage.removeItem(CAPABILITY_RUN_LOGS_KEY);
    }
    return logs;
  } catch {
    try {
      storage.removeItem(CAPABILITY_RUN_LOGS_KEY);
    } catch {}
    return [];
  }
}

export function writeCapabilityRunLogs(logs: CapabilityRunLog[]) {
  const storage = capabilityHistoryStorage();
  if (!storage) return;
  try {
    const safeLogs = logs
      .map(normalizeCapabilityRunLog)
      .filter((item): item is CapabilityRunLog => Boolean(item))
      .slice(0, MAX_CAPABILITY_RUN_LOGS);
    if (safeLogs.length > 0) storage.setItem(CAPABILITY_RUN_LOGS_KEY, serializeCapabilityRunLogs(safeLogs));
    else storage.removeItem(CAPABILITY_RUN_LOGS_KEY);
  } catch {}
}

export function prependCapabilityRunLog(logs: CapabilityRunLog[], log: CapabilityRunLog): CapabilityRunLog[] {
  return [
    log,
    ...logs.filter((item) => item.id !== log.id),
  ].slice(0, MAX_CAPABILITY_RUN_LOGS);
}

export function recordCapabilityRunHistory(event: CapabilityRunHistoryEvent): CapabilityRunLog {
  const log = createCapabilityRunHistoryEntry(event);
  writeCapabilityRunLogs(prependCapabilityRunLog(readCapabilityRunLogs(), log));
  return log;
}

export type CapabilityActionAuditContext = {
  actionId: string;
  time: number;
  risk: CapabilityActionRisk;
  timeline: CapabilityActionPhase[];
};

export function recordCapabilityActionPhase(event: CapabilityRunHistoryEvent & {
  phase: CapabilityActionPhase;
}): CapabilityRunLog {
  const codeByPhase: Partial<Record<CapabilityActionPhase, string>> = {
    proposal: "capability-action-pending",
    approved: "capability-action-approved",
    denied: "capability-action-denied",
    invalidated: "capability-action-invalidated",
  };
  const code = codeByPhase[event.phase];
  return recordCapabilityRunHistory({
    ...event,
    error: code ? Object.assign(new Error(code), { code }) : event.error,
  });
}

export type CapabilityRunSafeSettlement =
  | { ok: true; result: CapabilityRunResult; history: CapabilityRunLog }
  | { ok: false; error: unknown; history: CapabilityRunLog };

export async function settleCapabilityRunWithSafeHistory(
  capability: Pick<LocalCapability, "id" | "name" | "parameters">,
  input: string | undefined,
  surface: "ai" | "community",
  dependencies: { run: typeof runCapability } = { run: runCapability },
  audit?: CapabilityActionAuditContext,
): Promise<CapabilityRunSafeSettlement> {
  const normalizedInput = input?.trim() || "";
  const runInput = buildCapabilityRunInput(normalizedInput, surface, capability.parameters || []);
  const time = audit?.time ?? Date.now();
  try {
    assertValidCapabilityRunInput(runInput, capability.parameters || []);
    const result = await dependencies.run(capability.id, runInput);
    return {
      ok: true,
      result,
      history: recordCapabilityRunHistory({
        capabilityId: capability.id,
        surface,
        input: runInput,
        result,
        time,
        actionId: audit?.actionId,
        risk: audit?.risk,
        phase: result.indexWarning || result.indexStale ? "committed-warning" : "succeeded",
        timeline: audit?.timeline,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error,
      history: recordCapabilityRunHistory({
        capabilityId: capability.id,
        surface,
        input: runInput,
        error,
        time,
        actionId: audit?.actionId,
        risk: audit?.risk,
        phase: "failed",
        timeline: audit?.timeline,
      }),
    };
  }
}

export async function runCapabilityWithSafeHistory(
  capability: Pick<LocalCapability, "id" | "name" | "parameters">,
  input: string | undefined,
  surface: "ai" | "community",
  dependencies: { run: typeof runCapability } = { run: runCapability },
  audit?: CapabilityActionAuditContext,
) {
  const settlement = await settleCapabilityRunWithSafeHistory(capability, input, surface, dependencies, audit);
  if (settlement.ok) return settlement.result;
  throw settlement.error;
}

export function capabilityRunLogInputText(log: CapabilityRunLog) {
  const input = log.inputSummary;
  const parts = [
    input.kind,
    `${input.charCount} chars`,
    `${input.byteCount} bytes`,
    input.parameterCount ? `${input.parameterCount} params` : "",
    input.hasUrl ? `url:${input.urlScheme || "other"}` : "",
    input.hasDocumentRef ? "document-ref" : "",
    input.truncated ? "bounded" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function capabilityRunLogOutcomeText(log: CapabilityRunLog) {
  if (log.outcome.status === "failure") {
    return `${log.outcome.message} (${log.outcome.code})`;
  }
  const parts = [
    "运行成功",
    log.outcome.resultKind && log.outcome.resultKind !== "success" ? log.outcome.resultKind : "",
    log.outcome.documentCount !== undefined ? `${log.outcome.documentCount} documents` : "",
    log.outcome.assetCount !== undefined ? `${log.outcome.assetCount} assets` : "",
    log.outcome.indexWarningCode ? `索引警告:${log.outcome.indexWarningCode}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function capabilityRunDetailsFromLogs(logs: CapabilityRunLog[]): Record<string, string> {
  const details: Record<string, string> = {};
  for (const log of logs) {
    if (details[log.capabilityId]) continue;
    details[log.capabilityId] = capabilityRunLogOutcomeText(log);
  }
  return details;
}

export function buildCapabilityDiagnosticSnapshot(input: CapabilityDiagnosticSnapshotInput): string {
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  const logs = Array.isArray(input.logs) ? input.logs : [];
  const generatedAt = new Date(input.generatedAt || Date.now()).toISOString();
  const byType = (type: string) => capabilities.filter((item) => item.type === type);
  const countLine = (label: string, items: LocalCapability[]) => {
    const enabled = items.filter((item) => item.enabled).length;
    const ok = items.filter((item) => item.status === "ok").length;
    const error = items.filter((item) => item.status === "error").length;
    return `${label}: total=${items.length}, enabled=${enabled}, ok=${ok}, error=${error}`;
  };
  const latestFailures = logs.filter((log) => !log.ok).slice(0, 5);
  const latestRuns = logs.slice(0, 5);
  return [
    "# LuckyRay community diagnostic",
    `generatedAt: ${generatedAt}`,
    "",
    "## Capability service",
    `status: ${input.health ? (input.health.ok ? "ok" : "error") : "not_checked"}`,
    `baseUrl: ${input.health?.baseUrl || "unknown"}`,
    `checkedAt: ${input.health ? new Date(input.health.checkedAt).toISOString() : "unknown"}`,
    "",
    "## Capability counts",
    countLine("all", capabilities),
    countLine("skills", byType("skill")),
    countLine("extensions", byType("extension")),
    countLine("workflows", byType("workflow")),
    "",
    "## Runtime paths",
    `extensionDir: ${input.extensionDir || "unknown"}`,
    "",
    "## Recent failures",
    latestFailures.length
      ? latestFailures.map((log) => `- ${new Date(log.time).toISOString()} ${log.capabilityId}: ${capabilityRunLogOutcomeText(log)}`).join("\n")
      : "- none",
    "",
    "## Recent runs",
    latestRuns.length
      ? latestRuns.map((log) => `- ${new Date(log.time).toISOString()} ${log.ok ? "ok" : "error"} ${log.capabilityId}`).join("\n")
      : "- none",
  ].join("\n");
}

export async function checkCapabilityService(): Promise<CapabilityHealth> {
  const baseUrl = await getLocalApiBaseUrl();
  await listCapabilities({ cache: "no-store" });
  return { baseUrl, ok: true, checkedAt: Date.now() };
}
