/** A list summary is not a document body. Read only referenced documents. */
export type CanvasNoteDetail = {
  id?: string;
  title?: string;
  contentText?: string;
  contentJson?: string;
  updatedAt?: string;
};
function extractNoteText(note: CanvasNoteDetail): string {
  let text = note.contentText || "";
  if (!text && note.contentJson) {
    try {
      const value = JSON.parse(note.contentJson);
      let remaining = 5000;
      const parts: string[] = [];
      const walk = (v: unknown, depth = 0) => {
        if (remaining <= 0 || depth > 24) return;
        remaining--;
        if (typeof v === "string") {
          parts.push(v);
          return;
        }
        if (Array.isArray(v)) {
          v.forEach((x) => walk(x, depth + 1));
          return;
        }
        if (v && typeof v === "object") {
          const n = v as Record<string, unknown>;
          if (typeof n.text === "string") parts.push(n.text);
          else if (n.content) walk(n.content, depth + 1);
          else if (n.children) walk(n.children, depth + 1);
        }
      };
      walk(value);
      text = parts.join(" ");
    } catch {
      text = note.contentJson.replace(/<[^>]*>/g, " ");
    }
  }
  return text;
}
/** Body context preserves prose, code and line breaks; display metadata is separate. */
export function noteBodyText(note: CanvasNoteDetail, limit = 8000): string {
  return extractNoteText(note)
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trim()
    .slice(0, limit);
}
export function notePreviewText(note: CanvasNoteDetail, limit = 600): string {
  return noteBodyText(note, Number.MAX_SAFE_INTEGER)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*\s-]+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
/** Two concurrent document reads; late results never apply after cancellation. */
export function hydrateNotePreviews(
  ids: readonly string[],
  read: (id: string) => Promise<CanvasNoteDetail | null>,
  accept: (id: string, note: CanvasNoteDetail) => void,
) {
  let cancelled = false,
    index = 0;
  const work = async () => {
    while (!cancelled && index < ids.length) {
      const id = ids[index++];
      try {
        const note = await read(id);
        if (!cancelled && note) accept(id, note);
      } catch {
        /* keep cached content, never turn a transient read failure into deletion */
      }
    }
  };
  void work();
  void work();
  return () => {
    cancelled = true;
  };
}
