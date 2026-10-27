import {
  DELIVERY_LIMITS,
  buildMediaZip,
  mediaExtension,
  readMediaBytes,
  safeDeliveryName,
} from "./mediaDelivery";
import { SHOT_LIMIT, canBeShot, validShot, isStoryboard, storyboardShots, shotTime, validStoryboardChoice, type StoryboardNode, type StoryboardShot } from "./storyboard";

export type StoryboardDeliveryShot = Readonly<{
  id: string;
  number: number;
  start: number;
  end: number;
  script: Readonly<Omit<StoryboardShot, "chosenResult">>;
  confirmed: boolean;
  media?: Readonly<{ source: string; kind: "image" | "video" }>;
}>;
export type StoryboardDeliveryPlan = Readonly<{
  boardId: string;
  title: string;
  shots: readonly StoryboardDeliveryShot[];
  totalDurationSeconds: number;
  unconfirmedShotIds: readonly string[];
  unreadyShotIds: readonly string[];
  overflow: boolean;
  canExport: boolean;
}>;

/** The selector must resolve an explicit selection, never the latest result. */
export type StoryboardChosenMedia = { source: string; kind: "image" | "video" };

export function buildStoryboardDeliveryPlan(
  nodes: readonly StoryboardNode[],
  boardId: string,
  chosenMedia: (node: StoryboardNode) => StoryboardChosenMedia | undefined = (node) => {
    const choice = node.data.storyboardShot?.chosenResult;
    return validStoryboardChoice(choice) ? { source: choice.url, kind: choice.kind } : undefined;
  },
): StoryboardDeliveryPlan {
  const board = nodes.find((node) => node.id === boardId && isStoryboard(node));
  if (!board) throw Error("invalid-storyboard");
  // Do not let the canonical projection silently omit damaged shot records.
  if (nodes.some((node) => node.parentId === boardId &&
      node.data.storyboardShot !== undefined &&
      (!canBeShot(node) || !validShot(node.data.storyboardShot))))
    throw Error("invalid-storyboard-shot");
  const ordered = storyboardShots(nodes, boardId);
  if (ordered.length > SHOT_LIMIT) throw Error("too-many-shots");
  if (new Set(ordered.map((node) => node.id)).size !== ordered.length)
    throw Error("duplicate-shot-id");
  let total = 0;
  const shots = ordered.map((node, index): StoryboardDeliveryShot => {
    const raw = node.data.storyboardShot!;
    // Whitelist script fields: chosenResult contains private/signed source URLs.
    const script = Object.freeze({ version: 1 as const, order: raw.order, title: raw.title,
      framing: raw.framing, description: raw.description || "", lighting: raw.lighting || "", sound: raw.sound || "", cameraMovement: raw.cameraMovement || "", action: raw.action,
      dialogue: raw.dialogue, durationSeconds: raw.durationSeconds });
    const selected = chosenMedia(node);
    const start = total;
    total = Math.round((total + script.durationSeconds) * 10) / 10;
    const media = selected && selected.source.trim() && ["image", "video"].includes(selected.kind)
      ? Object.freeze({ source: selected.source, kind: selected.kind }) : undefined;
    return Object.freeze({ id: node.id, number: index + 1, start, end: total, script,
      confirmed: Boolean(selected), media });
  });
  const unconfirmedShotIds = Object.freeze(shots.filter((s) => !s.confirmed).map((s) => s.id));
  const unreadyShotIds = Object.freeze(shots.filter((s) => !s.media).map((s) => s.id));
  const overflow = shots.length > DELIVERY_LIMITS.files;
  return Object.freeze({ boardId, title: board.data.label || "Storyboard", shots: Object.freeze(shots),
    totalDurationSeconds: total, unconfirmedShotIds, unreadyShotIds, overflow,
    canExport: shots.length > 0 && !overflow && !unconfirmedShotIds.length && !unreadyShotIds.length });
}

/** Plain text, independent of media availability. No URLs or generation credentials. */
export function serializeStoryboardScript(plan: StoryboardDeliveryPlan): string {
  return [plan.title, `Shots: ${plan.shots.length} | Duration: ${shotTime(plan.totalDurationSeconds)}`, "",
    ...plan.shots.flatMap((shot) => [
      `${String(shot.number).padStart(3, "0")} — ${shot.script.title || `Shot ${shot.number}`}`,
      `ID: ${shot.id} | ${shotTime(shot.start)}–${shotTime(shot.end)} | ${shot.script.durationSeconds}s | ${shot.script.framing}`,
      `Description: ${shot.script.description || ""}`,
      `Action / camera: ${shot.script.action}`,
      `Dialogue: ${shot.script.dialogue}`,
      `Lighting: ${shot.script.lighting || ""}`,
      `Sound: ${shot.script.sound || ""}`,
      `Camera movement: ${shot.script.cameraMovement || ""}`,
      "",
    ]),
  ].join("\n");
}

/** All-or-nothing: preserve one file per shot even when shots share the same asset. */
export async function prepareStoryboardDelivery(
  plan: StoryboardDeliveryPlan,
  signal: AbortSignal,
  progress: (finished: number, total: number) => void = () => {},
  resolveUrl: (source: string) => string = (source) => source,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!plan.canExport || !plan.shots.length || plan.shots.length > DELIVERY_LIMITS.files ||
      plan.shots.some((shot) => !shot.confirmed || !shot.media))
    throw Error("storyboard-not-ready");
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  const manifestShots = [];
  let total = 0;
  for (const [index, shot] of plan.shots.entries()) {
    signal.throwIfAborted();
    const media = shot.media!;
    const bytes = await readMediaBytes(resolveUrl(media.source), signal,
      Math.min(DELIVERY_LIMITS.eachBytes, DELIVERY_LIMITS.totalBytes - total));
    signal.throwIfAborted();
    total += bytes.length;
    const name = safeDeliveryName(shot.script.title || `Shot ${shot.number}`, index, mediaExtension(bytes, media.kind));
    files.push({ name, bytes });
    manifestShots.push({ id: shot.id, number: shot.number, start: shot.start, end: shot.end,
      script: shot.script, media: { file: name, kind: media.kind } });
    progress(index + 1, plan.shots.length);
  }
  signal.throwIfAborted();
  files.push({ name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify({
    version: 1, type: "storyboard", boardId: plan.boardId, title: plan.title,
    totalDurationSeconds: plan.totalDurationSeconds,
    screenplay: serializeStoryboardScript(plan), shots: manifestShots,
  }, null, 2)) });
  const zip = buildMediaZip(files);
  signal.throwIfAborted();
  return zip;
}
