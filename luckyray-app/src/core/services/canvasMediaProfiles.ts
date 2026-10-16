import { invoke } from "@tauri-apps/api/core";

export type CanvasImageProtocol = "agnes" | "openai-image" | "gemini-image" | "12ai-task" | "disabled";
export type CanvasVideoProtocol = "agnes" | "openai-video" | "12ai-task" | "disabled";
export type CanvasTextProtocol = "legacy" | "openai-chat" | "disabled";
export type CanvasMediaProfile = {
  id: string; name: string; baseUrl: string; imageModel: string; videoModel: string;
  imageProtocol: CanvasImageProtocol; videoProtocol: CanvasVideoProtocol;
  revision: number; apiKeyConfigured: boolean;
  imageModels?: string[]; videoModels?: string[];
  textModel?: string; textProtocol?: CanvasTextProtocol; textModels?: string[];
};
export type CanvasMediaProfilesSnapshot = { version: 1; activeProfileId: string; profiles: CanvasMediaProfile[] };
export type CanvasMediaProfileInput = Omit<CanvasMediaProfile, "revision" | "apiKeyConfigured"> & {
  expectedRevision: number | null; apiKey?: string; clearApiKey?: boolean;
};
export const CANVAS_MEDIA_PRESETS = {
  agnes: { name: "Agnes", baseUrl: "https://apihub.agnes-ai.com/v1", imageModel: "agnes-image-2.1-flash", videoModel: "agnes-video-v2.0", imageProtocol: "agnes", videoProtocol: "agnes" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", imageModel: "gpt-image-1", videoModel: "", imageProtocol: "openai-image", videoProtocol: "disabled" },
  twelve: { name: "12API", baseUrl: "https://new.12ai.org/v1", imageModel: "", videoModel: "", imageProtocol: "openai-image", videoProtocol: "12ai-task" },
  easycli: { name: "EasyCLIProxyAPI · Gemini", baseUrl: "http://127.0.0.1:8317/v1", imageModel: "gemini-3.1-flash-image", videoModel: "", imageProtocol: "gemini-image", videoProtocol: "disabled" },
  custom: { name: "", baseUrl: "", imageModel: "", videoModel: "", imageProtocol: "openai-image", videoProtocol: "disabled" },
} satisfies Record<string, Omit<CanvasMediaProfileInput,"id"|"expectedRevision">>;

export function projectCanvasMediaProfiles(value: unknown): CanvasMediaProfilesSnapshot {
  if (!value || typeof value !== "object") throw new Error("canvas-media-profiles-invalid");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.profiles) || !raw.profiles.length || raw.profiles.length > 32) throw new Error("canvas-media-profiles-invalid");
  const ids = new Set<string>();
  const profiles = raw.profiles.map((item: unknown): CanvasMediaProfile => {
    if (!item || typeof item !== "object") throw new Error("canvas-media-profiles-invalid");
    const row = item as Record<string, unknown>;
    const field = (key: string, limit: number, empty = false) => {
      const result = row[key];
      if (typeof result !== "string" || result.length > limit || (!empty && !result.trim()) || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("canvas-media-profiles-invalid");
      return result;
    };
    const id = field("id",64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("canvas-media-profiles-invalid");
    ids.add(id);
    const imageProtocol = field("imageProtocol",32) as CanvasImageProtocol;
    const videoProtocol = field("videoProtocol",32) as CanvasVideoProtocol;
    if (!["agnes","openai-image","gemini-image","12ai-task","disabled"].includes(imageProtocol)
      || !["agnes","openai-video","12ai-task","disabled"].includes(videoProtocol)
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw new Error("canvas-media-profiles-invalid");
    const textProtocol = row.textProtocol ?? "legacy";
    if (!["legacy","openai-chat","disabled"].includes(String(textProtocol))) throw new Error("canvas-media-profiles-invalid");
    // Explicit projection, never spread an IPC object that could contain a key.
    const stringList = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value) || value.length > 500) return undefined;
      const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128);
      if (ids.length !== value.length) throw new Error("canvas-media-profiles-invalid");
      return ids.length ? ids : undefined;
    };
    return { id, name:field("name",160), baseUrl:field("baseUrl",2048), imageModel:field("imageModel",128,true), videoModel:field("videoModel",128,true),
      imageProtocol, videoProtocol, revision:Number(row.revision), apiKeyConfigured:row.apiKeyConfigured === true,
      textProtocol:textProtocol as CanvasTextProtocol, textModel:row.textModel === undefined ? "" : field("textModel",128,true), textModels:stringList(row.textModels),
      imageModels:stringList(row.imageModels), videoModels:stringList(row.videoModels) };
  });
  if (typeof raw.activeProfileId !== "string" || !ids.has(raw.activeProfileId)) throw new Error("canvas-media-profiles-invalid");
  return { version:1, activeProfileId:raw.activeProfileId, profiles };
}
export function createCanvasMediaProfilesClient(call: typeof invoke = invoke) {
  const read = async (command: string, args?: Record<string,unknown>) => projectCanvasMediaProfiles(await call(command,args));
  // Shared across settings-card mounts: an older save/switch cannot arrive after
  // a newer mutation and paint an obsolete active connection into the canvas.
  let pending: Promise<void> = Promise.resolve();
  const mutate = (command: string, args: Record<string,unknown>) => {
    const next = pending.then(() => read(command,args));
    pending = next.then(() => {}, () => {});
    return next;
  };
  return {
    list: () => read("canvas_media_profiles_list"),
    save: (profile: CanvasMediaProfileInput) => mutate("canvas_media_profile_upsert",{profile:{...profile}}),
    activate: (profileId: string) => mutate("canvas_media_profile_activate",{profileId}),
    remove: (profileId: string, revision: number) => mutate("canvas_media_profile_delete",{profileId,revision}),
    listModels: (baseUrl: string, apiKey: string, imageProtocol: string, binding?: {profileId?:string;profileRevision?:number;clearApiKey?:boolean}): Promise<string[]> =>
      call("canvas_media_profile_list_models", { query: { baseUrl, apiKey: apiKey || undefined, imageProtocol, ...binding } })
        .then((value: unknown) => {
          if (!Array.isArray(value) || value.length > 500
            || value.some((id) => typeof id !== "string" || !id || id.length > 128)) {
            throw new Error("canvas-media-models-invalid");
          }
          return value as string[];
        }),
  };
}
export const canvasMediaProfilesClient = createCanvasMediaProfilesClient();


/** Credentials are resolved in native code from this immutable binding. */
export async function completeCanvasProfileText(
  profileId: string, profileRevision: number,
  messages: Array<{role:string;content:string}>,
  options?: {systemPrompt?:string;temperature?:number;maxTokens?:number;model?:string},
): Promise<{success:boolean;content?:string;error_kind?:string;error_message?:string;error_detail?:string}> {
  return invoke("canvas_text_generate", {profileId,profileRevision,request:{messages,system_prompt:options?.systemPrompt,temperature:options?.temperature,max_tokens:options?.maxTokens,model:options?.model}});
}
export function resolveCanvasTextSelection(profile: CanvasMediaProfile | null, legacy: {model:string;models:string[];providerLabel:string}) {
  if (!profile || (profile.textProtocol ?? "legacy") === "legacy") return legacy;
  if (profile.textProtocol === "disabled") return {model:"",models:[],providerLabel:profile.name};
  const model = profile.textModel?.trim() || "";
  return {model,models:Array.from(new Set([model,...(profile.textModels ?? [])].filter(Boolean))),providerLabel:profile.name};
}
