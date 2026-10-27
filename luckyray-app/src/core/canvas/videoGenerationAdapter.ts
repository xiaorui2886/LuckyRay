/** Video generation Adapter for a LuckyRay host-provided async video bridge. */

import { canvasGenerationTaskError } from "./generationErrors";
import type { CanvasGenerationAdapter } from "./generationRunner";
import type { CanvasGenerationRequestSnapshot } from "./generationTasks";

export type CanvasVideoGenerationProgress = {
  stage: "submitting" | "queued" | "generating" | "downloading";
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
  clientTaskId?: string,
) => Promise<CanvasVideoGenerationResponse>;

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
      let response: CanvasVideoGenerationResponse;
      try {
        response = await generate({
          ...request,
          prompt,
          references: request.references.map((reference) => ({ ...reference })),
        }, onProgress);
      } catch (error) {
        return { ok: false, error: canvasGenerationTaskError("video", error) };
      }
      if (!response.success) return { ok: false, error: canvasGenerationTaskError("video", response) };
      const videoUrl = response.videoUrl?.trim() || "";
      if (!videoUrl) {
        return { ok: false, error: { code: "VIDEO_EMPTY_RESULT", message: "视频生成服务没有返回可用视频", retryable: true } };
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

/** The transport payload is materialized only for creation, never accepted-job polling. */
export async function prepareCanvasVideoBridgeReferences(
  request: CanvasGenerationRequestSnapshot,
  providerTaskId: string | undefined,
  prepare: (value: string) => Promise<string>,
) {
  return Promise.all(request.references
    .filter(reference => reference.kind !== "text" && reference.kind !== "note")
    .map(async reference => ({
      id: reference.id, label: reference.label, kind: reference.kind, role: reference.role,
      media_url: reference.mediaUrl
        ? (providerTaskId ? reference.mediaUrl : await prepare(reference.mediaUrl)) : null,
    })));
}
