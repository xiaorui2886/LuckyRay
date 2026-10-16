import { invoke } from "@tauri-apps/api/core";

type NativeState = { time: number; duration: number; width: number; height: number; paused: boolean; seeking: boolean; ended: boolean; configured: boolean };
type PlaybackRange = { start: number; end: number; loop: boolean };
export type NativeBounds = { x: number; y: number; width: number; height: number; exclude?: { x: number; y: number; width: number; height: number }[] };
export const transientNativeVideoError = (error: unknown) => /native-video-(command-queue-full|busy)$/.test(error instanceof Error ? error.message : String(error));
const command = <T>(request: object) => invoke<T>("material_native_video_command", { request });
export async function nativeFilmAvailable(cardFrames = false) {
  try {
    const capability = await command<{ available: boolean; composition?: string; cardFrames?: boolean }>({ op: "capability" });
    return capability?.available === true && capability.composition === 'webview-alpha-v1' && (!cardFrames || capability.cardFrames === true);
  }
  catch { return false; } // Old/non-Windows host: retain the existing HTML path.
}

/** One asset/revision lease. Commands serialize, including close after late open. */
export class NativeFilmTransport {
  private session = crypto.randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private continuous = new Map<string, { request: object; promise: Promise<unknown> }>();
  private positionVersion = 0;
  private playbackVersion = 0;
  private pending = 0;
  private state: NativeState = { time: 0, duration: 0, width: 0, height: 0, paused: true, seeking: false, ended: false, configured: false };
  private level = .7;
  private silent = false;
  constructor(private error: (error: unknown) => void) {}
  private send<T>(request: object, coalesce?: string): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("native-video-session-closed"));
    // Resize, observation and seeking may interleave during a drag. Keep only
    // the latest unsent value of each kind within an ordering segment. Explicit
    // pause/play/capture/close still preserve their final preceding seek.
    const queued = coalesce && this.continuous.get(coalesce);
    if (queued) {
      queued.request = request;
      return queued.promise as Promise<T>;
    }
    if (this.pending >= 64) return Promise.reject(new Error("native-video-command-queue-full"));
    this.pending++;
    const entry = { key: coalesce ?? "", request, promise: Promise.resolve() as Promise<unknown> };
    const next = this.queue.catch(() => {}).then(() => {
      if (coalesce && this.continuous.get(coalesce) === entry) this.continuous.delete(coalesce);
      if (this.disposed) throw new Error("native-video-session-closed");
      return command<T>({ ...entry.request, session: this.session });
    }).finally(() => { this.pending--; });
    entry.promise = next;
    if (coalesce) this.continuous.set(coalesce, entry);
    else this.continuous.clear();
    this.queue = next;
    return next;
  }
  private control(action: object, coalesce?: string) { return this.send({ op: "control", action }, coalesce); }
  private act(action: object, coalesce?: string) { void this.control(action, coalesce).catch(e => { if (!this.disposed) this.error(e); }); }
  open(libraryId: string, assetId: string, revision: string, bounds: NativeBounds, preview = false) {
    return this.send({ op: "open", libraryId, assetId, revision, bounds, preview });
  }
  previewFrame() { return this.send<{time: number; src: string}>({ op: "previewFrame" }, "previewFrame"); }
  bounds(bounds: NativeBounds) { return this.send({ op: "bounds", bounds }, "bounds"); }
  async snapshot() {
    const position = this.positionVersion, playback = this.playbackVersion;
    const state = await this.send<NativeState>({ op: "snapshot" }, "snapshot");
    if (!this.disposed) this.state = { ...state,
      ...(position !== this.positionVersion ? { time: this.state.time, seeking: this.state.seeking, ended: this.state.ended } : {}),
      ...(playback !== this.playbackVersion ? { paused: this.state.paused } : {}) };
    return this.state;
  }
  get currentTime() { return this.state.time; }
  set currentTime(seconds: number) { this.positionVersion++; this.state = { ...this.state, time: seconds, seeking: true, ended: false }; this.act({ op: "seek", seconds }, "seek"); }
  get paused() { return this.state.paused; }
  get ended() { return this.state.ended; }
  get seeking() { return this.state.seeking; }
  get videoWidth() { return this.state.width; }
  get videoHeight() { return this.state.height; }
  get volume() { return this.level; }
  set volume(value: number) { this.level = value; this.act({ op: "volume", value, muted: this.silent }, "volume"); }
  get muted() { return this.silent; }
  set muted(muted: boolean) { this.silent = muted; this.act({ op: "volume", value: this.level, muted }, "volume"); }
  pause() { this.playbackVersion++; this.state = { ...this.state, paused: true }; this.act({ op: "pause" }); }
  async play(range: PlaybackRange | null = null) {
    const version = ++this.playbackVersion, previous = this.state.paused;
    this.state = { ...this.state, paused: false };
    try { await this.control({ op: "play", range: range && { start: range.start, end: range.end, looping: range.loop } }); }
    catch (e) { if (version === this.playbackVersion) this.state = { ...this.state, paused: previous }; throw e; }
  }
  clearRange() { this.act({ op: "clearRange" }); }
  loop(enabled: boolean) { this.act({ op: "loop", enabled }); }
  async capture() {
    // Capture pauses the native decoder. Reflect that intent immediately too;
    // a drag/Space right after capture must not resume from stale playing state.
    this.playbackVersion++;
    this.state = { ...this.state, paused: true };
    const frame = await this.send<{ time: number; png: string }>({ op: "capture" });
    return { time: frame.time, bytes: Array.from(atob(frame.png), c => c.charCodeAt(0)) };
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    // Even if open has not replied, close follows it; never closes another token.
    this.queue = this.queue.catch(() => {}).then(() => command({ op: "close", session: this.session })).catch(() => {});
  }
}
