/** Text generation Adapter for LuckyRay's existing AI chat bridge. */

import type { CanvasGenerationAdapter } from "./generationRunner";
import { sanitizeCanvasGenerationErrorDetail } from "./generationTasks";
import { sanitizeAiVisibleContent } from "../services/ai";

export type CanvasAiChatCompletion = (
  messages: Array<{ role: string; content: string }>,
  options?: { systemPrompt?: string; temperature?: number; maxTokens?: number; model?: string; textProfileId?:string; textProfileRevision?:number },
) => Promise<{
  success: boolean;
  content?: string;
  error_kind?: string;
  error_message?: string;
  error_detail?: string;
}>;

const REFERENCE_ROLE_LABELS: Record<string, string> = {
  promptContext: "上下文",
  reference: "参考",
  firstFrame: "首帧",
  lastFrame: "尾帧",
  videoReference: "视频参考",
  generic: "输入",
};

/** Remove provider reasoning/scaffolding that must never reach a canvas text card. */
export function sanitizeCanvasTextGenerationOutput(content: string): string {
  let output = sanitizeAiVisibleContent(content).trim();

  // Some reasoning models expose an English drafting label after </think>.
  output = output.replace(
    /^(?:(?:draft(?:\s+\d+)?|final(?:\s+answer)?|answer|response|output)\s*:\s*)+/i,
    "",
  );

  return output.trim();
}

function mapCanvasTextGenerationError(
  requestModel: string,
  response: Awaited<ReturnType<CanvasAiChatCompletion>>,
) {
  const kind = response.error_kind || "api_error";
  const providerMessage = response.error_message || response.error_detail || "文本生成请求失败";
  const detail = sanitizeCanvasGenerationErrorDetail(response.error_detail);
  const modelUnavailable = /(?:model|模型)/i.test(providerMessage)
    && /(?:not found|does not exist|invalid|unsupported|unavailable|不存在|无效|不支持|不可用)/i.test(providerMessage);

  if (modelUnavailable) {
    return {
      code: "AI_MODEL_UNAVAILABLE",
      message: `模型“${requestModel}”不可用：${providerMessage}`,
      retryable: false,
      detail,
    };
  }

  const mapped = {
    profile_changed: {code:"AI_PROFILE_CHANGED",message:"画布文本配置已变化或删除，请使用当前配置重新生成。",retryable:false},
    profile_disabled: {code:"AI_PROFILE_DISABLED",message:"这套配置未启用独立文本生成。",retryable:false},
    no_api_key: { code: "AI_NOT_CONFIGURED", message: "尚未配置 AI API Key，请先到设置中完成 AI 服务配置", retryable: false },
    unauthorized: { code: "AI_AUTH_FAILED", message: `AI 服务鉴权失败：${providerMessage}`, retryable: false },
    rate_limited: { code: "AI_RATE_LIMITED", message: `AI 服务请求过多：${providerMessage}`, retryable: true },
    timeout: { code: "AI_REQUEST_TIMEOUT", message: "AI 服务响应超时，请稍后重新生成", retryable: true },
    connection: { code: "AI_CONNECTION_FAILED", message: `无法连接 AI 服务：${providerMessage}`, retryable: true },
    empty_response: { code: "AI_EMPTY_RESPONSE", message: "AI 服务没有返回文本内容，请重新生成", retryable: true },
  }[kind];

  return mapped ? { ...mapped, detail } : {
    code: "AI_CHAT_REQUEST_FAILED",
    message: providerMessage,
    retryable: true,
    detail,
  };
}
export function createCanvasTextGenerationAdapter(
  complete: CanvasAiChatCompletion,
): CanvasGenerationAdapter {
  return {
    id: "luckyray.ai-chat",
    supports: (request) => request.kind === "text",
    execute: async (request) => {
      const references = request.references.length
        ? `画布参考：\n${request.references.map((reference, index) => (
            `${index + 1}. [${REFERENCE_ROLE_LABELS[reference.role] || "参考"}] ${reference.label}`
          )).join("\n")}\n\n`
        : "";
      const prompt = request.prompt || "请根据当前画布上下文生成可直接放回画布的文本结果。";
      const response = await complete(
        [{ role: "user", content: `${references}${prompt}` }],
        {
          systemPrompt: "你是 LuckyRay 画布的文本生成助手。只输出可直接写回文本卡片的最终正文。禁止输出思考过程、<think> 或 <analysis> 标签、Draft/Answer 等草稿前缀，也不要解释工作过程。",
          temperature: 0.4,
          maxTokens: 1200,
          model: request.model,
          ...(request.textProfileId ? {textProfileId:request.textProfileId,textProfileRevision:request.textProfileRevision} : {}),
        },
      );

      if (!response.success) {
        return {
          ok: false,
          error: mapCanvasTextGenerationError(request.model, response),
        };
      }

      const text = response.content
        ? sanitizeCanvasTextGenerationOutput(response.content)
        : "";
      if (!text) {
        return {
          ok: false,
          error: {
            code: "AI_CHAT_EMPTY_RESULT",
            message: "生成服务没有返回文本内容",
            retryable: true,
          },
        };
      }

      return { ok: true, output: { kind: "text", text } };
    },
  };
}
