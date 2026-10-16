/** Video generation Adapter for a LuckyRay host-provided async video bridge. */

import type { CanvasGenerationAdapter } from "./generationRunner";
import {
  sanitizeCanvasGenerationErrorDetail,
  type CanvasGenerationRequestSnapshot,
} from "./generationTasks";

export type CanvasVideoGenerationProgress = {
  stage: "queued" | "generating" | "downloading";
  progress?: number;
  providerTaskId?: string;
};

export type CanvasVideoGenerationResponse = {
  success: boolean;
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

export type CanvasAiVideoGeneration = (
  request: CanvasGenerationRequestSnapshot,
  onProgress?: (progress: CanvasVideoGenerationProgress) => void,
  providerTaskId?: string,
) => Promise<CanvasVideoGenerationResponse>;

function mapCanvasVideoGenerationError(response: CanvasVideoGenerationResponse) {
  const kind = response.error_kind || "api_error";
  const providerMessage = response.error_message || response.error_detail || "视频生成请求失败";
  const detail = sanitizeCanvasGenerationErrorDetail(response.error_detail);
  const mapped = {
    profile_changed: { code: "VIDEO_PROFILE_CHANGED", message: "原生成配置已更改、删除或未绑定，已停止恢复以避免切换服务", retryable: false },
    no_api_key: { code: "VIDEO_NOT_CONFIGURED", message: "尚未配置 Agnes API Key", retryable: false },
    unauthorized: { code: "VIDEO_AUTH_FAILED", message: `Agnes 鉴权失败：${providerMessage}`, retryable: false },
    rate_limited: { code: "VIDEO_RATE_LIMITED", message: `Agnes 请求过多：${providerMessage}`, retryable: true },
    timeout: { code: "VIDEO_REQUEST_TIMEOUT", message: "视频生成等待超时，可稍后重试", retryable: true },
    connection: { code: "VIDEO_CONNECTION_FAILED", message: `无法连接 Agnes：${providerMessage}`, retryable: true },
    failed: { code: "VIDEO_GENERATION_FAILED", message: providerMessage, retryable: true },
    empty_response: { code: "VIDEO_EMPTY_RESULT", message: "Agnes 没有返回可用视频", retryable: true },
    unsupported_input: { code: "VIDEO_INPUT_UNSUPPORTED", message: providerMessage, retryable: false },
    provider_error: { code: "VIDEO_PROVIDER_ERROR", message: `视频生成服务返回错误：${providerMessage}`, retryable: true },
  }[kind];
  return mapped ? { ...mapped, detail } : {
    code: "VIDEO_GENERATION_FAILED",
    message: providerMessage,
    retryable: true,
    detail,
  };
}
export function createCanvasVideoGenerationAdapter(
  generate: CanvasAiVideoGeneration,
  onProgress?: (progress: CanvasVideoGenerationProgress) => void,
): CanvasGenerationAdapter {
  return {
    id: "luckyray.agnes-video",
    supports: (request) => request.kind === "video",
    execute: async (request) => {
      const prompt = request.prompt.trim() || (request.references.some((reference) => reference.kind === "image")
        ? "为参考画面添加自然、连贯的镜头运动。"
        : "");
      if (!prompt) {
        return {
          ok: false,
          error: { code: "VIDEO_PROMPT_REQUIRED", message: "请输入视频提示词，或先连接参考图片", retryable: false },
        };
      }
      const response = await generate({
        ...request,
        prompt,
        references: request.references.map((reference) => ({ ...reference })),
      }, onProgress);
      if (!response.success) return { ok: false, error: mapCanvasVideoGenerationError(response) };
      const videoUrl = response.videoUrl?.trim() || "";
      if (!videoUrl) {
        return { ok: false, error: { code: "VIDEO_EMPTY_RESULT", message: "Agnes 没有返回可用视频", retryable: true } };
      }
      return {
        ok: true,
        output: {
          kind: "video",
          mediaUrl: videoUrl,
          thumbnailUrl: response.thumbnailUrl?.trim() || undefined,
        },
      };
    },
  };
}
