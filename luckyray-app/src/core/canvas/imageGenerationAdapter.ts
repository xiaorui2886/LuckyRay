/** Image generation Adapter for a LuckyRay host-provided generation bridge. */

import { canvasGenerationTaskError } from "./generationErrors";
import type { CanvasGenerationAdapter } from "./generationRunner";
import type { CanvasGenerationRequestSnapshot } from "./generationTasks";

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
      let response: CanvasImageGenerationResponse;
      try {
        response = await generate({
          ...request,
          prompt,
          references: request.references.map((reference) => ({ ...reference })),
        });
      } catch (error) {
        return { ok: false, error: canvasGenerationTaskError("image", error) };
      }
      if (!response.success) {
        return { ok: false, error: canvasGenerationTaskError("image", response) };
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
