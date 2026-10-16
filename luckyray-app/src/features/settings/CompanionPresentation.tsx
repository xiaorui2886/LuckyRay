import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createDefaultCompanionGatewayClient, pairingSecondsRemaining } from "../../core/services/companionGateway";
import { createCompanionPresentationStore, type CompanionPresentationStore } from "../../core/services/companionPresentationStore";

const CompanionContext = createContext<CompanionPresentationStore | null>(null);

/** One bounded shell poll. Hidden routes do not mount another client or poll grants/audit. */
export function CompanionPresentationProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<CompanionPresentationStore | null>(null);
  useEffect(() => {
    let active = true, owned: CompanionPresentationStore | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null, lastRefresh = 0;
    const refresh = () => { if (document.visibilityState !== "hidden") { lastRefresh = Date.now(); void owned?.refresh(); } };
    const tick = () => {
      if (!active) return;
      owned?.tick();
      const delay = owned?.getSnapshot().pairing ? 2000 : 10_000;
      if (Date.now() - lastRefresh >= delay) refresh();
      timer = setTimeout(tick, 1000);
    };
    const scopesChanged = () => owned?.invalidateScopes();
    void createDefaultCompanionGatewayClient().then(client => {
      if (!active) return;
      owned = createCompanionPresentationStore(client); setStore(owned); refresh(); tick();
    });
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("luckyray:notes-vault-index-changed", scopesChanged);
    return () => {
      active = false; if (timer) clearTimeout(timer); owned?.dispose();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("luckyray:notes-vault-index-changed", scopesChanged);
    };
  }, []);
  return <CompanionContext.Provider value={store}>{children}</CompanionContext.Provider>;
}

export function CompanionPresentationTestProvider({ store, children }: { store: CompanionPresentationStore; children: ReactNode }) {
  return <CompanionContext.Provider value={store}>{children}</CompanionContext.Provider>;
}
export function useCompanionStore() { return useContext(CompanionContext); }
export function useCompanionSnapshot(store: CompanionPresentationStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
export function useCompanionView(store: CompanionPresentationStore, advanced = false) {
  const state = useCompanionSnapshot(store);
  const owner = useMemo(() => Symbol("companion-presentation-owner"), []);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => store.open(owner, advanced), [store, owner, advanced]);
  useEffect(() => {
    if (state.pairingOwner !== owner || !state.pairing) { setSeconds(0); return; }
    const update = () => { setSeconds(pairingSecondsRemaining(state.pairing!)); store.tick(); };
    update(); const interval = setInterval(update, 1000); return () => clearInterval(interval);
  }, [store, state.pairing, state.pairingOwner, owner]);
  return { state, owner, seconds };
}
