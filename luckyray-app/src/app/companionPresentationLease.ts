// The native claim returns remaining monotonic lease time. The renderer's
// elapsed monotonic time starts before IPC, so delayed callbacks and wall
// clock changes cannot revive an expired offer.
export function canApplyCompanionPresentation(
  remainingMs: unknown,
  elapsedMs: number,
  disposed: boolean,
): boolean {
  return !disposed && typeof remainingMs === "number"
    && Number.isSafeInteger(remainingMs)
    && Number.isFinite(elapsedMs) && elapsedMs >= 0
    && elapsedMs + 50 < remainingMs;
}
