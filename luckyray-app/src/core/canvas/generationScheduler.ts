import type { CanvasGenerationKind, CanvasGenerationTask } from './generationTasks';

/** Client-side budgets, not a promise of provider-side capacity. */
export type GenerationConcurrencyPolicy = {
  global: number; text: number; image: number; video: number; perConnection: number; doubao: number;
};
export const DEFAULT_GENERATION_CONCURRENCY_POLICY: Readonly<GenerationConcurrencyPolicy> = Object.freeze({
  global: 4, text: 2, image: 3, video: 2, perConnection: 2, doubao: 1,
});
export function normalizeGenerationConcurrencyPolicy(value: unknown): GenerationConcurrencyPolicy {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_GENERATION_CONCURRENCY_POLICY };
  for (const key of Object.keys(result) as (keyof GenerationConcurrencyPolicy)[]) {
    const number = input[key];
    result[key] = typeof number === 'number' && Number.isInteger(number) && number >= 1
      ? Math.min(key === 'doubao' ? 2 : 8, number) : DEFAULT_GENERATION_CONCURRENCY_POLICY[key];
  }
  return result;
}
export type GenerationConnection = { id: string; imageProtocol?: string; videoProtocol?: string };
export type GenerationSlot = {
  taskId: string; canvasId: string; nodeId: string; kind: CanvasGenerationKind;
  /** Configuration ID only: never credentials, URL, prompt, or provider task ID. */
  connectionId: string; conservative: boolean; doubao: boolean;
};
export function generationSlot(task: CanvasGenerationTask, canvasId: string, profiles: readonly GenerationConnection[]): GenerationSlot {
  const id = task.request.kind === 'text' ? task.request.textProfileId : task.request.mediaProfileId;
  const profile = profiles.find(candidate => candidate.id === id);
  const protocols = [profile?.imageProtocol, profile?.videoProtocol];
  return {
    taskId: task.id, canvasId, nodeId: task.sourceNodeId, kind: task.request.kind,
    // Legacy requests have no reliable shared credential identity. Preserve the
    // previous image1 + video1 + text2 budgets, rather than inventing an account.
    connectionId: id ? `profile:${id}` : `legacy:${task.request.kind}`,
    conservative: task.request.kind !== 'text' && !profile,
    doubao: task.request.kind !== 'text' && protocols.some(protocol => protocol === 'doubao-image' || protocol === 'doubao-video'),
  };
}

/** Reservations survive canvas navigation. Release only when the actual worker settles. */
export class GenerationScheduler {
  private readonly slots = new Map<string, GenerationSlot>();
  private readonly cooldowns = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  get version() { return this.epoch; }
  has(taskId: string): boolean { return this.slots.has(taskId); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get size() { return this.slots.size; }
  reserve(slot: GenerationSlot, policy: GenerationConcurrencyPolicy, now = Date.now()): boolean {
    if (this.slots.has(slot.taskId) || (this.cooldowns.get(slot.connectionId) || 0) > now) return false;
    const running = [...this.slots.values()];
    if (running.some(active => active.canvasId === slot.canvasId && active.nodeId === slot.nodeId)) return false;
    if (running.length >= policy.global || running.filter(active => active.kind === slot.kind).length >= policy[slot.kind]) return false;
    const lane = running.filter(active => active.connectionId === slot.connectionId);
    const browserLane = slot.doubao || lane.some(active => active.doubao);
    // Opt-in two is a local test budget, not verified provider account capacity.
    const limit = slot.conservative || lane.some(active => active.conservative) ? 1
      : Math.min(policy.perConnection, browserLane ? policy.doubao : policy.perConnection);
    if (lane.length >= limit) return false;
    this.slots.set(slot.taskId, { ...slot });
    return true;
  }
  release(taskId: string): void {
    if (!this.slots.delete(taskId)) return;
    this.epoch += 1;
    for (const listener of [...this.listeners]) listener();
  }
  backpressure(taskId: string, errorCode: string, now = Date.now()): void {
    const slot = this.slots.get(taskId);
    if (slot && /^(?:(?:IMAGE|VIDEO)_)?(?:RATE_LIMITED|ACCOUNT_RATE_LIMITED|PROVIDER_OVERLOADED)$/.test(errorCode)) {
      this.cooldowns.set(slot.connectionId, Math.max(this.cooldowns.get(slot.connectionId) || 0, now + 30_000));
    }
  }
  nextWakeDelay(now = Date.now()): number | undefined {
    for (const [lane, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(lane);
    const deadlines = [...this.cooldowns.values()];
    return deadlines.length ? Math.max(1, Math.min(...deadlines) - now) : undefined;
  }
}

/** FIFO among eligible jobs; a saturated connection cannot block other connections. */
export function queuedGenerationTasks(tasks: readonly (CanvasGenerationTask | undefined)[]): CanvasGenerationTask[] {
  const unique = new Map<string, CanvasGenerationTask>();
  for (const task of tasks) if (task?.status === 'queued' && !unique.has(task.id)) unique.set(task.id, task);
  return [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// One budget for this renderer runtime, including old workers after React remounts.
// No credentials or task payloads are retained; this is not a server/account-wide cap.
const runtimeGenerationScheduler = new GenerationScheduler();
export function getRuntimeGenerationScheduler(): GenerationScheduler {
  return runtimeGenerationScheduler;
}
