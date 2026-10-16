// Test-only read-only Cordis lifecycle observation. No hooks, timers or
// diagnostics from this module are packaged into the product.
export function installReadOnlyLifecycleObservation(ctx, appendFileSync, output) {
  const original = value => value?.[Symbol.for('cordis.original')] ?? value;
  const fibers = new Set([original(ctx.root.fiber)]);
  const remember = fiber => fibers.add(original(fiber));
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) remember(fiber);
  ctx.on('internal/plugin', remember);
  let previous;
  const sample = () => {
    const rows = [...fibers].map(fiber => ({
      name: String(fiber.name).slice(0, 160), uid: fiber.uid, state: fiber.state,
      transitionPending: Boolean(fiber.inertia),
      effects: fiber.getEffects().map(effect => effect.label.slice(0, 160)),
    }));
    const handles = Object.fromEntries(Object.entries(process._getActiveHandles().reduce((counts, handle) => {
      const name = handle?.constructor?.name ?? 'unknown'; counts[name] = (counts[name] ?? 0) + 1; return counts;
    }, {})).sort());
    const body = JSON.stringify({ rows, handles });
    if (body === previous) return;
    previous = body;
    appendFileSync(output, JSON.stringify({ atUtc: new Date().toISOString(), rows, handles }) + '\n');
  };
  sample();
  // Unmanaged and unref'ed deliberately: the observer must neither add an
  // official disposal dependency nor keep this synthetic process alive.
  setInterval(sample, 250).unref();
}
