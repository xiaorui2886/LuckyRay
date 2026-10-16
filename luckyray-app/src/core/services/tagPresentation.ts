const TAG_PRESENTATION_COLORS = [
  "#fbbf24",
  "#7c8aff",
  "#4ade80",
  "#a78bfa",
  "#fb7185",
  "#38bdf8",
  "#f97316",
  "#94a3b8",
] as const;

export function tagColorForName(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return TAG_PRESENTATION_COLORS[hash % TAG_PRESENTATION_COLORS.length];
}
