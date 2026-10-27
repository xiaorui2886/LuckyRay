/** Safe media-generation diagnostics. Never persist provider text, URLs or request bodies. */
const failures = {
  bigmodel_reference_invalid: ["BIGMODEL_REFERENCE_INVALID", "智谱参考图需为 PNG/JPEG，且不超过 5 MB", false],
  bigmodel_prompt_too_long: ["BIGMODEL_PROMPT_TOO_LONG", "智谱 CogVideoX-Flash 的提示词最多 512 个字符，请缩短后重新生成", false],
  submission_binding_changed: ["SUBMISSION_BINDING_CHANGED", "原视频任务的配置或输入已改变，无法安全恢复；请检查原任务后再决定是否重新生成", false],
  stable_task_id_required: ["STABLE_TASK_ID_REQUIRED", "缺少可恢复的视频任务标识，请更新客户端后重新操作", false],
  submission_unknown: ["SUBMISSION_UNKNOWN", "提交结果尚未确认。为避免重复生成，请先在服务端确认原任务状态，不要重新提交", false],
  profile_changed: ["PROFILE_CHANGED", "原生成配置已更改、删除或未绑定，请检查配置后重新发起", false],
  no_api_key: ["NOT_CONFIGURED", "尚未配置画布生成服务", false],
  unauthorized: ["AUTH_FAILED", "画布生成服务认证失败，请检查密钥与访问权限", false],
  rate_limited: ["RATE_LIMITED", "生成服务返回请求限制，具体限制原因未知", true],
  account_rate_limited: ["ACCOUNT_RATE_LIMITED", "供应商报告账户已达到速率限制；当前占用情况尚未确认", false],
  provider_overloaded: ["PROVIDER_OVERLOADED", "供应商报告该模型当前访问量过大", false],
  permission_denied: ["PERMISSION_DENIED", "供应商报告当前账户、订阅或密钥无此接口权限", false],
  insufficient_balance: ["INSUFFICIENT_BALANCE", "供应商报告账户欠费或余额不足", false],
  account_restricted: ["ACCOUNT_RESTRICTED", "供应商报告账户或套餐使用受限，请核对对应错误码", false],
  usage_limit: ["USAGE_LIMIT", "供应商报告使用上限已达到，请核对对应错误码", false],
  timeout: ["REQUEST_TIMEOUT", "画布生成请求超时，请稍后重试", true],
  connection: ["CONNECTION_FAILED", "画布生成服务连接失败，请检查网络与服务地址", true],
  moderation_blocked: ["CONTENT_BLOCKED", "生成服务因内容安全规则拒绝了本次请求或输出，请调整内容后重新提交", false],
  model_unavailable: ["MODEL_UNAVAILABLE", "当前模型不可用或不支持此生成操作，请检查模型配置", false],
  unsupported_model_protocol: ["MODEL_PROTOCOL_UNRESOLVED", "当前模型无法自动识别图片协议，请在配置中选择固定协议", false],
  unsupported_protocol: ["PROTOCOL_UNSUPPORTED", "当前模型与生成接口协议不匹配，请检查服务协议配置", false],
  unsupported_input: ["INPUT_UNSUPPORTED", "当前生成服务不支持该输入，请检查输入与生成选项", false],
  invalid_request: ["REQUEST_INVALID", "生成服务拒绝了请求参数，请检查模型、协议与生成选项", false],
  invalid_response: ["RESPONSE_INVALID", "画布生成服务响应无效", true],
  empty_response: ["EMPTY_RESULT", "画布生成服务没有返回可用结果", true],
  provider_error: ["PROVIDER_ERROR", "画布生成服务返回错误，具体原因未知", true],
} as const;
type FailureKind = keyof typeof failures;
const aliases: Record<string, FailureKind> = {
  content_policy_violation: "moderation_blocked", content_blocked: "moderation_blocked",
  safety_blocked: "moderation_blocked", model_not_found: "model_unavailable",
  unsupported_model: "model_unavailable", invalid_api_key: "unauthorized",
  rate_limit_exceeded: "rate_limited", unsupported_endpoint: "unsupported_protocol",
  "canvas-media-profile-missing": "profile_changed", "canvas-media-profile-conflict": "profile_changed",
  "canvas-media-profile-invalid": "profile_changed",
};
function knownKind(value: unknown): FailureKind | undefined {
  if (typeof value !== "string") return undefined;
  if (Object.prototype.hasOwnProperty.call(failures, value)) return value as FailureKind;
  return Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value] : undefined;
}
function classify(value: unknown, depth = 0): FailureKind | undefined {
  if (depth > 3) return undefined;
  const known = knownKind(value);
  if (known) return known;
  if (typeof value === "string" && value.length <= 16384) {
    // Tauri may reject with serialized JSON or a plain machine-readable kind.
    try { return classify(JSON.parse(value), depth + 1); } catch { return undefined; }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["error_kind", "code", "kind", "type"]) {
    const kind = knownKind(record[key]);
    if (kind && kind !== "provider_error") return kind;
  }
  const nested = classify(record.error, depth + 1);
  if (nested) return nested;
  // Error.message is accepted only when it is an exact code, never displayed.
  return knownKind(record.message) || knownKind(record.error_kind);
}
export function canvasGenerationFailure(error: unknown = "connection") {
  const error_kind = classify(error) || "provider_error";
  const detail = error && typeof error === 'object' ? safeCanvasGenerationDiagnostic((error as Record<string,unknown>).error_detail) : undefined;
  return { error_kind, error_message: failures[error_kind][1], error_detail: detail || null };
}
export function canvasGenerationTaskError(media: "image" | "video", error: unknown) {
  const failure = canvasGenerationFailure(error);
  const [code, message, retryable] = failures[failure.error_kind];
  const uncertainSubmit = media === 'video' && failure.error_kind === 'provider_error'
    && failure.error_detail && JSON.parse(failure.error_detail).stage === 'submit';
  return { code: `${media.toUpperCase()}_${code}`, message, retryable: uncertainSubmit ? false : retryable, detail: failure.error_detail || undefined };
}

/** Defense in depth at the native boundary. Never treat provider prose as diagnostics. */
export function safeCanvasGenerationDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1024) return undefined;
  try {
    const data = JSON.parse(value);
    if (!data || !['prepare','submit','poll','download'].includes(data.stage)) return undefined;
    const identifier = (v:unknown, max:number) => typeof v === 'string' && v.length <= max
      && /^[A-Za-z0-9_-]+$/.test(v) && !/^sk[-_]/i.test(v) ? v : null;
    return JSON.stringify({stage:data.stage,
      httpStatus:Number.isInteger(data.httpStatus) && data.httpStatus >= 100 && data.httpStatus <= 599 ? data.httpStatus : null,
      vendorCode:identifier(data.vendorCode,64),requestId:identifier(data.requestId,128)});
  } catch { return undefined; }
}
