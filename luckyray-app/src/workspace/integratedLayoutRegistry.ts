/** Production pages own their document/view state. The shell saves presentation
 * snapshots only; it never mounts trial adapters or serializes editor drafts. */
export type IntegratedLayoutKey = 'notes' | 'graph';
export type IntegratedLayoutAdapter = {
  capture: () => unknown;
  validate: (value: unknown) => boolean;
  restore: (value: unknown) => Promise<boolean>;
  /** Exact transient rollback, separate from presets that preserve extra tabs. */
  checkpoint: () => () => Promise<void>;
};
export type IntegratedLayouts = Partial<Record<IntegratedLayoutKey, unknown>>;
const adapters = new Map<IntegratedLayoutKey, IntegratedLayoutAdapter>();
const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

export function registerIntegratedLayout(key: IntegratedLayoutKey, adapter: IntegratedLayoutAdapter) {
  adapters.set(key, adapter);
  return () => { if (adapters.get(key) === adapter) adapters.delete(key); };
}

export function captureIntegratedLayouts(): IntegratedLayouts {
  const result: IntegratedLayouts = {};
  for (const [key, adapter] of adapters) {
    const value = copy(adapter.capture());
    if (!adapter.validate(value)) throw Error('当前布局暂时无法安全保存。');
    result[key] = value;
  }
  return result;
}

export async function restoreIntegratedLayouts(value: IntegratedLayouts, commit?: () => void): Promise<void> {
  // Pair each snapshot, checkpoint and restore with the exact same owner.
  // React effects may register a newer adapter while a checkpoint flushes or
  // another provider awaits; looking it up again would orphan its rollback.
  const entries = (Object.entries(value) as [IntegratedLayoutKey, unknown][]).map(([key,snapshot])=>{
    const adapter=adapters.get(key);
    if(!adapter)throw Error(`请先打开${key === 'notes' ? '知识库' : '图谱'}，再应用这个布局。`);
    return {key,snapshot:copy(snapshot),adapter};
  });
  for(const {adapter,snapshot} of entries){
    if(!adapter.validate(snapshot))throw Error('布局中的内容已变化，当前标签和草稿保持不变。');
  }
  const rollback = entries.map(({key,adapter}) => [key, adapter.checkpoint()] as const);
  const applied: IntegratedLayoutKey[] = [];
  try {
    for (const {key, snapshot, adapter} of entries) {
      applied.push(key);
      if (!await adapter.restore(copy(snapshot))) throw Error('布局未能安全应用。');
    }
    commit?.();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const [key, restore] of rollback.reverse()) {
      if (applied.includes(key)) try { await restore(); } catch (failure) { rollbackErrors.push(failure); }
    }
    if (rollbackErrors.length) throw Error('布局应用失败，部分视图未能恢复原位置。内容保留，请检查当前标签。');
    throw error;
  }
}
