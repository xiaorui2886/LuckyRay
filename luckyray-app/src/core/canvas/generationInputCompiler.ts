/**
 * Provider-independent compiler for connected canvas generation inputs.
 *
 * Desktop, CLI and MCP callers should persist the compiled immutable request:
 * textual nodes become prompt context, while media references remain ordered
 * by their explicit semantic role.
 */

import type {
  CanvasGenerationKind,
  CanvasGenerationReferenceSnapshot,
} from "./generationTasks";

const ROLE_PRIORITY: Record<CanvasGenerationReferenceSnapshot["role"], number> = {
  firstFrame: 0,
  lastFrame: 1,
  reference: 2,
  videoReference: 3,
  promptContext: 4,
  generic: 5,
};

function contextText(reference: CanvasGenerationReferenceSnapshot): string {
  const text = reference.text?.trim() || "";
  return text; // A display label is not prompt content; explicit empty text stays empty.
}

export function orderCanvasGenerationReferences(
  references: readonly CanvasGenerationReferenceSnapshot[],
): CanvasGenerationReferenceSnapshot[] {
  return references
    .map((reference, index) => ({
      reference: {
        ...reference,
        text: typeof reference.text === "string" ? reference.text.trim().slice(0, 8000) : reference.text,
      },
      index,
    }))
    .sort((left, right) => {
      const roleDifference = ROLE_PRIORITY[left.reference.role] - ROLE_PRIORITY[right.reference.role];
      return roleDifference || left.index - right.index;
    })
    .map(({ reference }) => reference);
}

export function compileCanvasGenerationInputs(input: {
  kind: CanvasGenerationKind;
  prompt: string;
  includeNoteTitles?: boolean;
  references: readonly CanvasGenerationReferenceSnapshot[];
}): { prompt: string; references: CanvasGenerationReferenceSnapshot[] } {
  const references = orderCanvasGenerationReferences(input.references).map(reference => reference.kind === "note" ? {
    id: reference.id, sourceNodeId: reference.sourceNodeId, kind: "note", role: reference.role,
    label: input.includeNoteTitles ? reference.label : "笔记正文",
    text: reference.text || "",
  } : reference);
  const contexts = references
    .map((reference) => ({ reference, text: contextText(reference) }))
    .filter(({ reference, text }) => !!text && (
      reference.role === "promptContext"
      || reference.kind === "text"
      || reference.kind === "note"
    ));

  const prompt = input.prompt.trim();
  if (!contexts.length) return { prompt, references };

  const contextBlock = contexts
    .map(({ reference, text }) => `【${reference.label || "未命名上下文"}】\n${text}`)
    .join("\n\n");
  const instruction = prompt || (input.kind === "text"
    ? "请根据画布上下文生成可直接使用的文本。"
    : input.kind === "video"
      ? "请根据画布上下文生成连贯的视频。"
      : "请根据画布上下文生成图片。");

  return {
    prompt: `${instruction}\n\n画布上下文：\n${contextBlock}`,
    references,
  };
}

