import { SHOT_LIMIT, validShot, type ShotFraming, type StoryboardShot } from "./storyboard";

export const SCRIPT_TEXT_LIMIT = 100000;
export type ScriptShotInput = Pick<StoryboardShot, "title" | "description" | "lighting" | "sound" | "cameraMovement" | "action" | "dialogue" | "durationSeconds" | "framing">;
export type StoryboardScriptImport = { sourceText: string; shots: ScriptShotInput[] };
export type ScriptParseResult = {
  shots: ScriptShotInput[];
  defaultDurationIndexes: number[];
  defaultFramingIndexes: number[];
  /** Kept in sourceText, deliberately excluded from image descriptions. */
  sourcePreamble: string;
};

const framings: Record<string, ShotFraming> = {
  wide: "wide", "远景": "wide", full: "full", "全景": "full",
  medium: "medium", "中景": "medium", close: "close", "close-up": "close",
  "close up": "close", "近景": "close", detail: "detail", "特写": "detail",
};
const clean = (line: string) => line.trim().replace(/^#{1,6}\s*/, "").replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "").replace(/\*\*/g, "");
const header = (line: string) => clean(line).match(/^(?:镜头|分镜|shot)\s*(?:第\s*)?([0-9０-９一二三四五六七八九十百]+)(?:\s*[号镜])?(?=\s|[:：.、)\-–—]|$)\s*[:：.、)\-–—]?\s*(.*)$/i);
const field = (line: string) => clean(line).match(/^(画面描述|画面|描述|visual\s+description|visual|description|动作\s*[/／]\s*运镜|动作|运镜|camera\s+movement|光影氛围|光影|lighting|sound|action\s*[/／]\s*camera|action|台词\s*[/／]\s*旁白|台词|对白|旁白|环境声|音效|dialogue\s*[/／]\s*narration|dialogue|时长|duration|景别|framing|标题|title)\s*[:：]\s*(.*)$/i);

export function validateScriptShots(shots: readonly ScriptShotInput[], remainingCapacity = SHOT_LIMIT): void {
  if (!Number.isInteger(remainingCapacity) || remainingCapacity < 0 || remainingCapacity > SHOT_LIMIT) throw Error("invalid-capacity");
  if (!shots.length) throw Error("empty-script");
  if (shots.length > remainingCapacity) throw Error("shot-limit");
  shots.forEach((shot, order) => {
    if (!validShot({ ...shot, version: 1, order })) throw Error(`invalid-shot:${order + 1}`);
    if (!shot.description?.trim() && !shot.action.trim() && !shot.dialogue.trim() && !shot.lighting?.trim() && !shot.sound?.trim() && !shot.cameraMovement?.trim()) throw Error(`empty-shot:${order + 1}`);
  });
}

/** Deterministic, local parsing only. Source is never treated as an instruction. */
export function parseStoryboardScript(sourceText: string, remainingCapacity = SHOT_LIMIT): ScriptParseResult {
  if (typeof sourceText !== "string" || !sourceText.trim()) throw Error("empty-script");
  if (sourceText.length > SCRIPT_TEXT_LIMIT) throw Error("script-too-long");
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  const explicit = lines.some(line => header(line));
  const blocks: { title: string; lines: string[] }[] = [];
  const preamble: string[] = [];
  if (explicit) {
    for (const line of lines) {
      const match = header(line);
      if (match) blocks.push({ title: match[2], lines: [] });
      else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
      else preamble.push(line);
    }
  } else {
    // A document heading/title is source context, never a visual generation prompt.
    while (lines.length && (!lines[0].trim() || /^\s*#{1,6}\s+/.test(lines[0]) || /^\s*(?:剧本名称|剧本名|剧本标题|script title|title)\s*[:：]/i.test(lines[0]))) preamble.push(lines.shift()!);
    for (const paragraph of lines.join("\n").split(/\n\s*\n/)) {
      if (paragraph.trim()) blocks.push({ title: "", lines: paragraph.split("\n") });
    }
  }
  const defaultDurationIndexes: number[] = [], defaultFramingIndexes: number[] = [];
  const shots = blocks.map((block, index): ScriptShotInput => {
    const shot: ScriptShotInput = { title: block.title, description: "", action: "", dialogue: "", durationSeconds: 5, framing: "medium" };
    let active: "description" | "lighting" | "sound" | "cameraMovement" | "action" | "dialogue" = "description";
    let hasDuration = false, hasFraming = false;
    const append = (key: typeof active, value: string) => { shot[key] = [shot[key], value].filter(Boolean).join("\n"); };
    for (const raw of block.lines) {
      const match = field(raw);
      if (!match) {
        // Unrecognized labels belong in the description, rather than disappearing.
        if (/^[^:：]{1,40}[:：]/.test(raw.trim()) && active !== "dialogue") active = "description";
        append(active, raw.trim());
        continue;
      }
      const key = match[1].toLowerCase().replace(/\s*[/／]\s*/g, "/").replace(/\s+/g, " "), value = match[2].trim();
      if (["画面描述", "画面", "描述", "visual description", "visual", "description"].includes(key)) { active = "description"; append(active, value); }
      else if (["动作/运镜", "动作", "action/camera", "action"].includes(key)) { active = "action"; append(active, value); }
      else if (["台词/旁白", "台词", "对白", "旁白", "dialogue/narration", "dialogue"].includes(key)) { active = "dialogue"; append(active, value); }
      else if (["光影氛围", "光影", "lighting"].includes(key)) { active = "lighting"; append(active, value); }
      else if (["环境声", "音效", "sound"].includes(key)) { active = "sound"; append(active, value); }
      else if (["运镜", "camera movement"].includes(key)) { active = "cameraMovement"; append(active, value); }
      else if (["标题", "title"].includes(key)) { shot.title = value; active = "description"; }
      else if (["时长", "duration"].includes(key)) {
        const seconds = value.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?|秒)?$/i);
        if (!seconds || Number(seconds[1]) < 0.1 || Number(seconds[1]) > 3600) throw Error(`invalid-duration:${index + 1}`);
        shot.durationSeconds = Number(seconds[1]); hasDuration = true; active = "description";
      } else {
        const framing = framings[value.toLowerCase()];
        if (!framing) throw Error(`invalid-framing:${index + 1}`);
        shot.framing = framing; hasFraming = true; active = "description";
      }
    }
    if (!hasDuration) defaultDurationIndexes.push(index);
    if (!hasFraming) defaultFramingIndexes.push(index);
    return shot;
  });
  validateScriptShots(shots, remainingCapacity);
  return { shots, defaultDurationIndexes, defaultFramingIndexes, sourcePreamble: preamble.join("\n").trim() };
}

export function scriptImportError(error: unknown, english = false): string {
  const [code, shot] = (error instanceof Error ? error.message : "invalid-shot").split(":");
  const errors: Record<string, [string, string]> = {
    "empty-script": ["请粘贴包含画面、动作或台词的剧本。", "Paste a script with visual, action, or dialogue content."],
    "script-too-long": ["剧本超过 100,000 字符，请拆分后导入。", "Script exceeds 100,000 characters. Split it before importing."],
    "shot-limit": ["镜头数量超过当前剩余容量，请拆分剧本。", "Shot count exceeds remaining capacity. Split the script."],
    "invalid-capacity": ["当前镜头容量无效，请重新打开分镜。", "Invalid remaining capacity. Reopen the storyboard."],
    "invalid-duration": ["时长必须是 0.1–3600 秒的数字。", "Duration must be a number between 0.1 and 3600 seconds."],
    "invalid-framing": ["景别请使用远景、全景、中景、近景或特写。", "Use wide, full, medium, close, or detail framing."],
    "empty-shot": ["镜头需要画面、动作或台词内容。", "A shot needs visual, action, or dialogue content."],
    "invalid-shot": ["字段内容超出限制或格式无效（标题 100、画面 4000、动作及台词各 2000 字符）。", "Invalid field or length exceeded (title 100, visual 4000, action/dialogue 2000 characters each)."],
  };
  return `${shot ? (english ? `Shot ${shot}: ` : `镜头 ${shot}：`) : ""}${(errors[code] || errors["invalid-shot"])[english ? 1 : 0]}`;
}
