// A presentation-only fence. Never changes the editor write source or drafts.
let state = { generation: 0, pending: 0, confirmedVaultId: null as string | null, uncertain: false };
export function readKnowledgeScopeTransition() { return state; }
export function confirmKnowledgeScopeRead(vaultId: string | null, generation: number) {
  if (state.pending === 0 && state.generation === generation) state = { ...state, confirmedVaultId: vaultId, uncertain: false };
}
export async function withKnowledgeScopeTransition<T>(
  action: () => Promise<T>,
  vaultId: (result: T) => string | null,
): Promise<T> {
  const overlapping = state.pending > 0;
  state = { ...state, generation: state.generation + 1, pending: state.pending + 1, uncertain: state.uncertain || overlapping };
  const generation = state.generation;
  try {
    const result = await action();
    const committed = vaultId(result);
    if (committed) state = {
      ...state,
      confirmedVaultId: committed,
      uncertain: overlapping || state.generation !== generation || state.pending !== 1,
    };
    return result;
  } catch (error) {
    // A failed IPC response need not mean the native selection did not commit.
    state = { ...state, uncertain: true };
    throw error;
  } finally {
    state = { ...state, pending: state.pending - 1 };
  }
}
