import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ORB_PLACEMENT, ORB_PLACEMENT_KEY, parseOrbPlacement, type OrbPlacement } from './canvasAgentOrbPlacement';
const CHANGE_EVENT = 'luckyray:canvas-agent-orb-placement';
type Change = { value: OrbPlacement; saved: boolean };
function read(): OrbPlacement {
  try { return parseOrbPlacement(JSON.parse(window.localStorage.getItem(ORB_PLACEMENT_KEY) || 'null')); }
  catch { return { ...DEFAULT_ORB_PLACEMENT }; }
}
/** Both settings and launcher observe the same global canvas preference. */
export function useCanvasAgentOrbPlacement() {
  const [value, setValue] = useState<OrbPlacement>(read);
  const latest = useRef(value);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    const accept = (next: OrbPlacement) => { latest.current = next; setValue(next); };
    const local = (event: Event) => { const detail = (event as CustomEvent<Change>).detail; if (detail) { accept(parseOrbPlacement(detail.value)); setSaveFailed(!detail.saved); } };
    const storage = (event: StorageEvent) => { if (event.key === ORB_PLACEMENT_KEY || event.key === null) { accept(read()); setSaveFailed(false); } };
    window.addEventListener(CHANGE_EVENT, local); window.addEventListener('storage', storage);
    return () => { window.removeEventListener(CHANGE_EVENT, local); window.removeEventListener('storage', storage); };
  }, []);
  const update = useCallback((patch: Partial<OrbPlacement>) => {
    const next = parseOrbPlacement({ ...latest.current, ...patch });
    let saved = true;
    try { window.localStorage.setItem(ORB_PLACEMENT_KEY, JSON.stringify(next)); } catch { saved = false; }
    latest.current = next; setValue(next); setSaveFailed(!saved);
    window.dispatchEvent(new CustomEvent<Change>(CHANGE_EVENT, { detail: { value: next, saved } }));
  }, []);
  return { placement: value, update, saveFailed };
}
