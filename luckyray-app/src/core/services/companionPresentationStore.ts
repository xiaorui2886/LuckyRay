import { companionGrantEnabled } from "./companionAccess";
import type { CompanionAuthorizationMode } from "./companionGateway";
import { type CompanionGrantChange } from "./companionAccess";
import {
  assertCanonicalPairingEnvelope, createCompanionPairingSession, pairingSecondsRemaining,
  type CompanionGatewayClient, type CompanionGatewayStatus, type CompanionServiceGrantState,
  type CompanionSecurityAuditEntry, type LanIpv4Interface, type PairedCompanionDevice, type PairingPresentation,
} from "./companionGateway";

type Grant = CompanionServiceGrantState["grants"][number];
export type CompanionPresentationState = {
  status: CompanionGatewayStatus | null; devices: PairedCompanionDevice[]; confirmedAt: number;
  loading: boolean; error: unknown; busy: string; interfaces: LanIpv4Interface[]; audit: CompanionSecurityAuditEntry[];
  selectedDeviceId: string | null; services: Record<string, CompanionServiceGrantState | undefined>;
  lsh: Record<string, { granted: boolean; runtimeAvailable: boolean } | undefined>;
  grantLoading: Record<string, boolean>; grantBusy: Record<string, boolean>; grantErrors: Record<string, unknown>;
  pairing: PairingPresentation | null; pairingOwner: symbol | null; pairingState: "idle" | "waiting" | "expired" | "paired"; pairingError: unknown;
  pairingExpiry: { owner: symbol; epoch: number; ready: boolean } | null;
};

export function companionOnlineCount(state: CompanionPresentationState, now = Date.now()): number | null {
  if (!state.status || state.error || now - state.confirmedAt > 25_000) return null;
  return state.status.state === "running" ? state.devices.filter(d => d.connected && !d.revokedAt).length : 0;
}
export function companionGrantKey(deviceId: string, grant: Grant) {
  return JSON.stringify([deviceId, grant.grantClass, grant.scopeKind, grant.scopeId]);
}

/** Public pairing identity, not a credential or an inferred phone model. Never renames stored devices. */
export function companionDeviceDisplayLabel(device: PairedCompanionDevice, devices: PairedCompanionDevice[]): string {
  if (device.label !== "LuckyRay Mobile" && !devices.some(other => other.deviceId !== device.deviceId && other.label === device.label)) return device.label;
  const code = (id: string) => id.replace(/^device-/, "").toUpperCase();
  const identity = code(device.deviceId);
  let length = Math.min(6, identity.length);
  while (length < identity.length && devices.some(other => other.deviceId !== device.deviceId && code(other.deviceId).slice(-length) === identity.slice(-length))) length++;
  return `${device.label} · ${identity.slice(-length)}`;
}

// Compare only bounded JSON-like projection data; Error/custom objects remain
// reference-sensitive so a fresh failure is not accidentally treated as empty.
function sameProjection(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 8 || !left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameProjection(value, right[index], depth + 1));
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameProjection(a[key], b[key], depth + 1));
}
const projectionFields = new Set<keyof CompanionPresentationState>([
  "status", "devices", "interfaces", "audit", "services", "lsh", "grantLoading", "grantBusy", "grantErrors",
]);

/** One presentation source. Owns no gateway lifecycle; every mutation is an explicit UI action. */
export function createCompanionPresentationStore(client: CompanionGatewayClient) {
  let state: CompanionPresentationState = {
    status: null, devices: [], confirmedAt: 0, loading: false, error: null, busy: "", interfaces: [], audit: [],
    selectedDeviceId: null, services: {}, lsh: {}, grantLoading: {}, grantBusy: {}, grantErrors: {},
    pairing: null, pairingOwner: null, pairingState: "idle", pairingError: null, pairingExpiry: null,
  };
  const listeners = new Set<() => void>();
  const details = new Map<symbol, boolean>();
  const reads = new Map<string, number>();
  const grantReads = new Map<string, { scope: number; promise: Promise<void> }>();
  const pairingTickets = new Map<symbol, string>();
  const cancellationRetries = new Map<symbol, string>();
  let refreshPromise: Promise<void> | null = null, disposed = false, pairingEpoch = 0, scopeEpoch = 0, interfacesEpoch = 0, auditEpoch = 0;
  let session = createCompanionPairingSession(client);
  let beforePairing = new Set<string>();
  const publish = (patch: Partial<CompanionPresentationState>) => {
    if (disposed) return;
    const next = { ...state, ...patch };
    for (const key of Object.keys(patch) as Array<keyof CompanionPresentationState>) {
      if (projectionFields.has(key) && sameProjection(state[key], next[key])) Object.assign(next, { [key]: state[key] });
    }
    if (Object.keys(patch).every(key => Object.is(state[key as keyof CompanionPresentationState], next[key as keyof CompanionPresentationState]))) return;
    state = next; listeners.forEach(fn => fn());
  };
  const validDevice = (id: string) => state.devices.some(d => d.deviceId === id && !d.revokedAt);
  const selectedTargets = () => [...details.values()].some(Boolean)
    ? state.devices.filter(d => !d.revokedAt).map(d => d.deviceId)
    : state.selectedDeviceId ? [state.selectedDeviceId] : [];

  function readGrant(id: string, clear = false, force = false): Promise<void> {
    if (!validDevice(id) || disposed) return Promise.resolve();
    const scope = scopeEpoch, pending = grantReads.get(id);
    if (!force && pending?.scope === scope) return pending.promise;
    const revision = (reads.get(id) || 0) + 1; reads.set(id, revision);
    if (clear) publish({ services: { ...state.services, [id]: undefined }, lsh: { ...state.lsh, [id]: undefined } });
    // An existing confirmed pane remains interactive during read-only polling.
    // Scope changes/unknown data still load visibly; writes own grantBusy and
    // revalidate the native revision before committing, independently of polls.
    if (!state.services[id] || !state.lsh[id]) publish({ grantLoading: { ...state.grantLoading, [id]: true } });
    const promise = (async () => {
      const [services, lsh] = await Promise.allSettled([client.serviceGrants(id), client.lshRemoteState(id)]);
      if (disposed || reads.get(id) !== revision || scopeEpoch !== scope || !validDevice(id)) return;
      publish({
        services: { ...state.services, [id]: services.status === "fulfilled" ? services.value : undefined },
        lsh: { ...state.lsh, [id]: lsh.status === "fulfilled" ? lsh.value : undefined },
        grantLoading: { ...state.grantLoading, [id]: false },
        grantErrors: { ...state.grantErrors, [id]: services.status === "rejected" ? services.reason : lsh.status === "rejected" ? lsh.reason : null },
      });
    })().finally(() => { if (grantReads.get(id)?.promise === promise) grantReads.delete(id); });
    grantReads.set(id, { scope, promise });
    return promise;
  }
  async function refresh() {
    if (disposed) return;
    if (refreshPromise) return refreshPromise;
    // Only the initial status read is a loading screen. Later refreshes are
    // background observations, not user actions or reasons to disable controls.
    if (!state.confirmedAt) publish({ loading: true });
    refreshPromise = (async () => {
      try {
        const [status, devices] = await Promise.all([client.status(), client.listDevices()]);
        if (disposed) return;
        const selectedDeviceId = devices.some(d => d.deviceId === state.selectedDeviceId && !d.revokedAt)
          ? state.selectedDeviceId : devices.find(d => !d.revokedAt)?.deviceId || null;
        publish({ status, devices, selectedDeviceId, confirmedAt: Date.now(), error: null });
        const paired = state.pairing && devices.find(d => !d.revokedAt && !beforePairing.has(d.deviceId));
        if (paired) {
          const owner = state.pairingOwner;
          const closing = owner ? releasePairing(owner) : Promise.resolve(), epoch = pairingEpoch;
          void closing.then(() => {
            if (pairingEpoch === epoch && !state.pairingOwner && validDevice(paired.deviceId)) {
              ++scopeEpoch;
              publish({ selectedDeviceId: paired.deviceId, pairingState: "paired" });
              if (details.size) void readGrant(paired.deviceId, true);
            }
          });
        }
        // A slow permissions pane must not block the light online/device poll.
        if (details.size) { selectedTargets().forEach(id => void readGrant(id)); void refreshDetails(); }
      } catch (error) { publish({ status: null, error }); }
      finally { publish({ loading: false }); refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function refreshDetails(advanced = false) {
    // Light polls own only interface freshness. They must not retire a slower
    // explicit Settings audit read, including the initial open/refresh race.
    const interfaceRevision = ++interfacesEpoch;
    const auditRevision = advanced ? ++auditEpoch : auditEpoch;
    const results = await Promise.allSettled([client.listInterfaces(), ...(advanced ? [client.listAudit()] : [])]);
    if (disposed || !details.size) return;
    if (interfaceRevision === interfacesEpoch) {
      if (results[0].status === "fulfilled") publish({ interfaces: results[0].value as LanIpv4Interface[] });
      else publish({ interfaces: [], error: results[0].reason });
    }
    if (advanced && auditRevision === auditEpoch && [...details.values()].some(Boolean) && results[1]?.status === "fulfilled") {
      publish({ audit: results[1].value as CompanionSecurityAuditEntry[] });
    }
  }
  async function releasePairing(owner: symbol, reason: "close" | "expired" = "close"): Promise<boolean> {
    // Closing while expiry cancellation waits also withdraws the renewal intent.
    if (state.pairingExpiry?.owner === owner) {
      ++pairingEpoch;
      publish({ pairingExpiry: null, pairingState: "idle" });
    }
    const retryId = cancellationRetries.get(owner);
    if (state.pairingOwner !== owner) {
      if (!retryId) return true;
      try { await client.cancelPairing(retryId); cancellationRetries.delete(owner); return true; }
      catch (error) { if (!state.pairingOwner) publish({ error }); return false; }
    }
    const releasedEpoch = ++pairingEpoch, ticketId = pairingTickets.get(owner);
    pairingTickets.delete(owner);
    const oldSession = session;
    // Detach before awaiting cancellation. A late close can never clear/cancel a new ticket.
    session = createCompanionPairingSession(client);
    publish({ pairing: null, pairingOwner: null, pairingState: reason === "expired" ? "expired" : "idle", pairingError: null,
      pairingExpiry: reason === "expired" ? { owner, epoch: releasedEpoch, ready: false } : null });
    try {
      await oldSession.dispose(); cancellationRetries.delete(owner);
      if (state.pairingExpiry?.epoch === releasedEpoch && pairingEpoch === releasedEpoch) {
        publish({ pairingExpiry: { owner, epoch: releasedEpoch, ready: true } });
      }
      return true;
    }
    catch (error) {
      if (ticketId) cancellationRetries.set(owner, ticketId);
      if (pairingEpoch === releasedEpoch && !state.pairingOwner) publish({ error, pairingExpiry: null,
        pairingOwner: reason === "expired" ? owner : null, pairingState: "idle", pairingError: reason === "expired" ? error : null });
      return false;
    }
  }
  async function issuePairing(owner: symbol, replace = false, authorizationMode: CompanionAuthorizationMode = "manual") {
    if (state.busy || disposed || !details.has(owner)) return;
    publish({ busy: "pair" });
    const previousOwner = state.pairingOwner;
    if (previousOwner && previousOwner !== owner) await releasePairing(previousOwner);
    if (disposed || !details.has(owner)) { publish({ busy: "" }); return; }
    const epoch = ++pairingEpoch, ownedSession = session;
    beforePairing = new Set(state.devices.map(d => d.deviceId));
    publish({ busy: "pair", error: null, pairingOwner: owner, pairing: null, pairingState: "waiting", pairingError: null, pairingExpiry: null });
    try {
      const pairing = await ownedSession.issue(replace, authorizationMode);
      if (epoch !== pairingEpoch || disposed || state.pairingOwner !== owner || !pairing) return;
      assertCanonicalPairingEnvelope(pairing);
      pairingTickets.set(owner, pairing.pairingId);
      cancellationRetries.delete(owner);
      publish({ pairing });
    } catch (error) { if (epoch === pairingEpoch) publish({ error, pairingState: "idle", pairingError: error }); }
    finally { if (!disposed && state.busy === "pair") publish({ busy: "" }); }
  }
  async function run(action: string, operation: (client: CompanionGatewayClient) => Promise<unknown>) {
    if (state.busy || disposed) return;
    publish({ busy: action, error: null });
    try {
      if ((action === "stop" || action === "restart") && state.pairingOwner) await releasePairing(state.pairingOwner);
      await operation(client); await refresh(); await refreshDetails([...details.values()].some(Boolean));
    } catch (error) { await refresh(); publish({ error }); }
    finally { publish({ busy: "" }); }
  }
  async function applyServiceChanges(id: string, changes: CompanionGrantChange[], expected: CompanionServiceGrantState): Promise<boolean> {
    const key = id + ":batch", scope = scopeEpoch;
    if (!changes.length || !validDevice(id) || state.grantLoading[id] || state.busy || Object.values(state.grantBusy).some(Boolean)) return false;
    // Snapshot the confirmed dialog, not mutable caller data during an await.
    const requested = changes.map(change => ({ ...change }));
    publish({ grantBusy: { ...state.grantBusy, [key]: true }, grantErrors: { ...state.grantErrors, [key]: null } });
    try {
      const latest = await client.serviceGrants(id);
      if (disposed || scope !== scopeEpoch || !validDevice(id)) return false;
      if (latest.permissionRevision !== expected.permissionRevision || latest.currentVault?.vaultId !== expected.currentVault?.vaultId) throw { code: "permission-state-changed" };
      await client.setServiceGrants(id, requested, expected.permissionRevision, expected.currentVault?.vaultId || null);
      await readGrant(id, false, true);
      const confirmed = state.services[id];
      if (scope !== scopeEpoch || !validDevice(id)) return false;
      if (!confirmed || requested.some(change => companionGrantEnabled(confirmed, change) !== change.enabled)) throw { code: "permission-readback-failed" };
      return true;
    } catch (error) {
      if (scope === scopeEpoch && validDevice(id)) { await readGrant(id, false, true); publish({ grantErrors: { ...state.grantErrors, [key]: error } }); }
      return false;
    } finally { publish({ grantBusy: { ...state.grantBusy, [key]: false } }); }
  }
  async function setAuthorizationMode(id: string, mode: CompanionAuthorizationMode, expected: CompanionServiceGrantState): Promise<boolean> {
    const key = id + ":batch", scope = scopeEpoch;
    if (!validDevice(id) || state.grantLoading[id] || state.busy || Object.values(state.grantBusy).some(Boolean)) return false;
    publish({ grantBusy: { ...state.grantBusy, [key]: true }, grantErrors: { ...state.grantErrors, [key]: null } });
    try {
      await client.setAuthorizationMode(id, mode, expected.permissionRevision);
      await readGrant(id, false, true);
      if (disposed || scope !== scopeEpoch || !validDevice(id)) return false;
      if (state.services[id]?.authorizationMode !== mode) throw { code: "permission-readback-failed" };
      return true;
    } catch (error) {
      if (scope === scopeEpoch && validDevice(id)) { await readGrant(id, false, true); publish({ grantErrors: { ...state.grantErrors, [key]: error } }); }
      return false;
    } finally { publish({ grantBusy: { ...state.grantBusy, [key]: false } }); }
  }
  async function toggleService(id: string, grant: Grant) {
    const current = state.services[id], key = companionGrantKey(id, grant), scope = scopeEpoch;
    if (!current || !validDevice(id) || state.grantLoading[id] || state.grantBusy[key] || state.grantBusy[id + ":batch"] || state.busy) return;
    const enabled = !companionGrantEnabled(current, grant);
    publish({ grantBusy: { ...state.grantBusy, [key]: true }, grantErrors: { ...state.grantErrors, [key]: null } });
    try {
      // Recheck the permission generation and vault immediately before an explicit write.
      const latest = await client.serviceGrants(id);
      if (disposed || scope !== scopeEpoch || !validDevice(id) || state.selectedDeviceId !== id && ![...details.values()].some(Boolean)) return;
      if (latest.permissionRevision !== current.permissionRevision || latest.currentVault?.vaultId !== current.currentVault?.vaultId) {
        await readGrant(id, true); throw { code: "permission-state-changed" };
      }
      if (enabled && latest.authorizationMode !== "trusted" && grant.scopeKind === "vault" && latest.currentVault?.vaultId !== grant.scopeId && !latest.savedLibraries?.some(scope => scope.scopeKind === "vault" && scope.scopeId === grant.scopeId && scope.available)) throw { code: "permission-state-changed" };
      await client.setServiceGrants(id, [{ ...grant, enabled }], current.permissionRevision, current.currentVault?.vaultId || null);
      await readGrant(id, false, true);
      const confirmed = state.services[id];
      if (scope === scopeEpoch && (!confirmed || companionGrantEnabled(confirmed, grant) !== enabled)) throw { code: "permission-readback-failed" };
    } catch (error) { if (scope === scopeEpoch && validDevice(id)) publish({ grantErrors: { ...state.grantErrors, [key]: error } }); }
    finally { publish({ grantBusy: { ...state.grantBusy, [key]: false } }); }
  }
  async function toggleLsh(id: string) {
    const current = state.lsh[id], key = id + ":lsh", scope = scopeEpoch;
    if (!current || !validDevice(id) || state.grantLoading[id] || state.grantBusy[key] || state.grantBusy[id + ":batch"] || state.busy) return;
    publish({ grantBusy: { ...state.grantBusy, [key]: true }, grantErrors: { ...state.grantErrors, [key]: null } });
    try {
      const latest = await client.lshRemoteState(id);
      if (disposed || scope !== scopeEpoch || !validDevice(id) || state.selectedDeviceId !== id && ![...details.values()].some(Boolean)) return;
      if (latest.granted !== current.granted) { await readGrant(id); throw { code: "permission-state-changed" }; }
      await client.setLshRemoteGrant(id, !current.granted);
      await readGrant(id, false, true);
      if (scope === scopeEpoch && state.lsh[id]?.granted !== !current.granted) throw { code: "permission-readback-failed" };
    } catch (error) { if (scope === scopeEpoch && validDevice(id)) publish({ grantErrors: { ...state.grantErrors, [key]: error } }); }
    finally { publish({ grantBusy: { ...state.grantBusy, [key]: false } }); }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, refreshDetails, readGrant, run, toggleService, applyServiceChanges, setAuthorizationMode, toggleLsh, issuePairing, releasePairing,
    selectDevice: (id: string) => { if (validDevice(id)) { ++scopeEpoch; publish({ selectedDeviceId: id }); void readGrant(id, true); } },
    invalidateScopes: () => { ++scopeEpoch; publish({ services: {}, lsh: {}, grantLoading: {} }); if (details.size) selectedTargets().forEach(id => void readGrant(id, true)); },
    open: (owner: symbol, advanced = false) => {
      details.set(owner, advanced); void refresh(); void refreshDetails(advanced);
      return () => { details.delete(owner); ++scopeEpoch; void releasePairing(owner); };
    },
    tick: () => {
      if (state.pairing && pairingSecondsRemaining(state.pairing) === 0 && state.pairingOwner) {
        void releasePairing(state.pairingOwner, "expired");
      }
      // Stale status cannot stay online while background polling is suspended.
      if (state.confirmedAt && Date.now() - state.confirmedAt > 25_000 && state.status) publish({ status: null });
    },
    dispose: () => { disposed = true; ++scopeEpoch; ++pairingEpoch; listeners.clear(); details.clear(); void session.dispose().catch(() => {}); },
  };
}
export type CompanionPresentationStore = ReturnType<typeof createCompanionPresentationStore>;
