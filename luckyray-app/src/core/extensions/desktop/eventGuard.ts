// Event origins are host-only metadata. A scoped event writer carries a frozen
// chain, even across detached work. Legacy calls capture only the current
// synchronous callback; unrelated work must not inherit a pending Promise.
const originField = '__luckyrayEventOrigins';
const limit = 64;
const overflow = '*';

export function createDesktopEventGuard(id: string, isLive: () => boolean) {
  const active: string[][] = [];
  return {
    writeOrigins(): string[] {
      const origins = new Set<string>();
      for (const chain of active) for (const origin of chain) origins.add(origin);
      return origins.size > limit ? [overflow] : [...origins];
    },
    deliver<T>(raw: T, handler: (event: T, origins: readonly string[]) => void | Promise<void>) {
      if (!isLive()) return;
      const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      const candidate = source?.[originField];
      const origins = Array.isArray(candidate) && candidate.every(value => typeof value === 'string')
        ? candidate as string[] : [];
      if (origins.length > limit || origins.includes(overflow) || origins.includes(id)) return;
      let payload = raw;
      if (source && originField in source) {
        const copy = { ...source };
        delete copy[originField];
        payload = copy as T;
      }
      const chain = [...new Set([...origins, id])].sort();
      const scoped = chain.length > limit ? [overflow] : chain.slice();
      active.push(chain);
      try {
        const result = handler(payload, scoped);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(error => console.error('Desktop extension event handler failed', error));
        }
      } catch (error) {
        console.error('Desktop extension event handler failed', error);
      } finally {
        const index = active.lastIndexOf(chain);
        if (index !== -1) active.splice(index, 1);
      }
    },
    clear() { active.length = 0; },
  };
}
