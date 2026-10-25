/** Display transport text without mistaking JSON payloads for prose or inventing successful work. */
export function canvasAgentToolDetail(value?: string): { prose?: string; technical?: string } {
  const text = value?.trim();
  if (!text) return {};
  if (!/^[\[{]/.test(text)) return { prose: text };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      const prose = ['summary', 'message', 'description', 'error'].map(key => object[key]).filter((part): part is string => typeof part === 'string' && !!part.trim()).join('\n');
      return { prose: prose || undefined, technical: text };
    }
    return { technical: text };
  } catch { return { prose: text }; }
}
