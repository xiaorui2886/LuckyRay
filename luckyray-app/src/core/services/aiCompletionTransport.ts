import { Channel, invoke } from "@tauri-apps/api/core";

/** Shared by legacy and profile-bound non-stream completions. */
export async function invokeCancellableAiCompletion<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  call: typeof invoke = invoke,
  registered?: Channel<void>,
): Promise<T> {
  if (!signal) return call<T>(command, args);
  signal.throwIfAborted();
  const registration = registered ?? new Channel<void>();
  const cancellationId = `completion-${crypto.randomUUID()}`;
  let ready = false;
  let cancelSent = false;
  const cancel = () => {
    if (!ready || cancelSent) return;
    cancelSent = true;
    void call("ai_chat_cancel", { streamId: cancellationId }).catch((error) => {
      console.warn("AI completion cancellation transport failed", error);
    });
  };
  // An abort can arrive while invoke is still registering the native task.
  registration.onmessage = () => {
    ready = true;
    if (signal.aborted) cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await call<T>(command, { ...args, cancellationId, onRegistered: registration });
  } finally {
    signal.removeEventListener("abort", cancel);
    registration.onmessage = () => {};
  }
}
