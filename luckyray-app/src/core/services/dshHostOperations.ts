type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// These commands share the backend's non-reentrant operation lock. Keep one
// renderer-owned lane across route mounts so Settings inspection cannot race
// startup/retry or opening the native surface. Backend admission stays final.
let pendingOperation: Promise<void> | null = null;

export function runDshHostOperation<T>(operation: () => Promise<T>): Promise<T> {
  let request: Promise<T>;
  try {
    request = pendingOperation ? pendingOperation.then(operation) : operation();
  } catch (error) {
    request = Promise.reject(error);
  }
  const settled = request.then(() => undefined, () => undefined);
  pendingOperation = settled;
  void settled.then(() => {
    if (pendingOperation === settled) pendingOperation = null;
  });
  return request;
}

const EXCLUSIVE_COMMANDS = new Set([
  "dsh_plugin_compat_status", "dsh_plugin_compat_check", "dsh_plugin_compat_apply",
  "dsh_plugin_compat_reclaim_surface", "dsh_native_surface_open", "dsh_native_surface_preload",
  "dsh_native_surface_restart", "dsh_native_surface_close",
  "dsh_native_surface_open_intent", "dsh_native_surface_open_intent_status",
]);

export function serializeDshHostInvoke(invoke: Invoke): Invoke {
  return <T>(command: string, args?: Record<string, unknown>) => (
    EXCLUSIVE_COMMANDS.has(command)
      ? runDshHostOperation(() => invoke<T>(command, args))
      : invoke<T>(command, args)
  );
}
