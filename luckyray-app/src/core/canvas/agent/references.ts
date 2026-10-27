/** References are attached by explicit canvas selection, separate from the Agent’s explicitly scoped on-demand canvas reads. */
export function appendAgentReferences(current: readonly string[], selected: readonly string[], liveIds: ReadonlySet<string>, limit = 256): { ids: string[]; overflow: boolean } {
  const next = [...new Set([...current.filter(id => liveIds.has(id)), ...selected.filter(id => liveIds.has(id))])];
  const bounded = next.slice(0, limit);
  return { ids: bounded, overflow: next.length > limit };
}
