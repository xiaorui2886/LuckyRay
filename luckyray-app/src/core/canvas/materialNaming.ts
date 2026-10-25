import type { CanvasGenerationLibraryCandidate } from './generationHistory';

export const CANVAS_MATERIAL_NAME_LIMIT = 120;
const GENERATED_NODE_LABELS = /^(?:图片生成|视频生成|生成图片|生成视频|图片|视频|Image|Video|Generated image|Generated video|Image generator|Video generator)$/i;

/** A deterministic local title, never an extra generation request. */
export function canvasNodeDisplayName(label: string | undefined, prompt: string | undefined, kind: 'image' | 'video', english = false): string {
  const explicit = label?.trim();
  if (explicit && !GENERATED_NODE_LABELS.test(explicit)) return explicit;
  const cleanPrompt = prompt?.replace(/\[\[lr-(?:ref|focus):[^\]\r\n]+\]\]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const firstLine = cleanPrompt?.split(/\r?\n/).find(line => line.trim())?.trim().replace(/\s+/g, ' ') || '';
  const subject = firstLine.replace(/^(?:(?:create|generate|draw|make)\b[^:：]{0,70}[:：]\s*|(?:请)?(?:生成|绘制|画出|创作)[：:\s]*)/i, '');
  const phrase = subject.split(/[。！？!?;；]|[，,]\s*/)[0]?.trim() || subject;
  const title = phrase.length > 36 ? phrase.slice(0, 36).trimEnd() : phrase;
  return title || (kind === 'video' ? (english ? 'Generated video' : '生成视频') : (english ? 'Generated image' : '生成图片'));
}

export function canvasMaterialDefaultNames(candidates: readonly CanvasGenerationLibraryCandidate[], english = false, nodeLabel?: string): string[] {
  return candidates.map((candidate, index) => {
    // Explicit saved names take precedence and are never regenerated or suffixed.
    if (candidate.name?.trim()) return candidate.name.trim();
    const title = canvasNodeDisplayName(nodeLabel, candidate.prompt, candidate.kind, english);
    const suffix = candidates.length > 1 ? ` ${String(index + 1).padStart(2, '0')}` : '';
    return `${title.slice(0, CANVAS_MATERIAL_NAME_LIMIT - suffix.length)}${suffix}`;
  });
}
export function validateCanvasMaterialNames(names: readonly string[], count: number): 'count' | 'empty' | 'long' | 'control' | null {
  if (names.length !== count || count < 1) return 'count';
  if (names.some(name => !name.trim())) return 'empty';
  if (names.some(name => name.trim().length > CANVAS_MATERIAL_NAME_LIMIT)) return 'long';
  if (names.some(name => /[\x00-\x1f\x7f]/.test(name))) return 'control';
  return null;
}
