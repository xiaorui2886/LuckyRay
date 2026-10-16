/** Image generation Adapter for a LuckyRay host-provided generation bridge. */

import type { CanvasGenerationAdapter } from "./generationRunner";
import {
  sanitizeCanvasGenerationErrorDetail,
  type CanvasGenerationRequestSnapshot,
} from "./generationTasks";

export type CanvasGeneratedImage = {
  url: string;
  thumbnailUrl?: string | null;
};

export type CanvasImageGenerationResponse = {
  success: boolean;
  images?: CanvasGeneratedImage[];
  error_kind?: string | null;
  error_message?: string | null;
  error_detail?: string | null;
};

/**
 * The host receives the same immutable request snapshot used by desktop, CLI
 * and MCP callers. Provider credentials and transport remain outside canvas.
 */
export type CanvasAiImageGeneration = (
  request: CanvasGenerationRequestSnapshot,
) => Promise<CanvasImageGenerationResponse>;

function mapCanvasImageGenerationError(
  requestModel: string,
  response: CanvasImageGenerationResponse,
) {
  const kind = response.error_kind || "api_error";
  const providerMessage = response.error_message || response.error_detail || "图片生成请求失败";
  const detail = sanitizeCanvasGenerationErrorDetail(response.error_detail);
  const modelUnavailable = /(?:model|模型)/i.test(providerMessage)
    && /(?:not found|does not exist|invalid|unsupported|unavailable|不存在|无效|不支持|不可用)/i.test(providerMessage);

  if (modelUnavailable) {
    return {
      code: "IMAGE_MODEL_UNAVAILABLE",
      message: `图片模型“${requestModel}”不可用：${providerMessage}`,
      retryable: false,
      detail,
    };
  }

  const mapped = {
    profile_changed: { code: "IMAGE_PROFILE_CHANGED", message: "原生成配置已更改或删除，请检查配置后重新发起", retryable: false },
    no_api_key: { code: "IMAGE_NOT_CONFIGURED", message: "尚未配置图片生成服务", retryable: false },
    unauthorized: { code: "IMAGE_AUTH_FAILED", message: `图片服务鉴权失败：${providerMessage}`, retryable: false },
    rate_limited: { code: "IMAGE_RATE_LIMITED", message: `图片服务请求过多：${providerMessage}`, retryable: true },
    timeout: { code: "IMAGE_REQUEST_TIMEOUT", message: "图片生成响应超时，请稍后重试", retryable: true },
    connection: { code: "IMAGE_CONNECTION_FAILED", message: `无法连接图片生成服务：${providerMessage}`, retryable: true },
    empty_response: { code: "IMAGE_EMPTY_RESULT", message: "图片生成服务没有返回可用图片", retryable: true },
    unsupported_input: { code: "IMAGE_INPUT_UNSUPPORTED", message: providerMessage, retryable: false },
    provider_error: { code: "IMAGE_PROVIDER_ERROR", message: `图片生成服务返回错误：${providerMessage}`, retryable: true },
  }[kind];

  return mapped ? { ...mapped, detail } : {
    code: "IMAGE_GENERATION_FAILED",
    message: providerMessage,
    retryable: true,
    detail,
  };
}
export function createCanvasImageGenerationAdapter(
  generate: CanvasAiImageGeneration,
): CanvasGenerationAdapter {
  return {
    id: "luckyray.ai-image",
    supports: (request) => request.kind === "image",
    execute: async (request) => {
      const prompt = request.prompt.trim() || (request.references.length
        ? "请参考已连接的素材生成一张新图片。"
        : "");
      if (!prompt) {
        return {
          ok: false,
          error: {
            code: "IMAGE_PROMPT_REQUIRED",
            message: "请输入图片生成提示词，或先连接参考素材",
            retryable: false,
          },
        };
      }
      const response = await generate({
        ...request,
        prompt,
        references: request.references.map((reference) => ({ ...reference })),
      });
      if (!response.success) {
        return { ok: false, error: mapCanvasImageGenerationError(request.model, response) };
      }

      const images = (response.images || [])
        .map((image) => ({
          url: image.url?.trim() || "",
          thumbnailUrl: image.thumbnailUrl?.trim() || null,
        }))
        .filter((image) => image.url);
      if (!images.length) {
        return {
          ok: false,
          error: {
            code: "IMAGE_EMPTY_RESULT",
            message: "图片生成服务没有返回可用图片",
            retryable: true,
          },
        };
      }

      return {
        ok: true,
        output: {
          kind: "image",
          mediaUrl: images[0].url,
          thumbnailUrl: images[0].thumbnailUrl || images[0].url,
          mediaItems: images,
        },
      };
    },
  };
}
