import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MaterialAsset } from "../../core/services/materialCatalog";
import { useI18n } from "../../core/i18n/index";
import {
  clampCompareMultiplierToBounds,
  clampComparePanOffset,
  reclampCompareStateAfterResize,
  resolveCompareFitScale,
  resolveCompareGridColumns,
  resolveCompareMultiplierBounds,
  resolveCompareProjection,
  resolveOneToOneMultiplier,
  zoomCompareSlot,
  type CompareDimensions,
  type CompareZoomState,
} from "./materialCompareGeometry";
import { resolveMaterialViewerBounds, type MaterialViewerBounds } from "./materialViewerGeometry";

export type MaterialCompareSlotAsset = Pick<
  MaterialAsset,
  "id" | "name" | "previewUrl" | "thumbnailUrl" | "updatedAt" | "mimeType"
>;

type SlotView =
  | { status: "loading" }
  | { status: "ready"; image: CompareDimensions }
  | { status: "error" }
  | { status: "missing" };

const SLOT_SOURCE = (asset: MaterialCompareSlotAsset): string => asset.previewUrl || asset.thumbnailUrl || "";
const SLOT_IDENTITY = (asset: MaterialCompareSlotAsset): string => `${asset.id}:${asset.updatedAt || ""}:${SLOT_SOURCE(asset)}`;
const FIT_ZOOM = (): CompareZoomState => ({ multiplier: 1, offset: { x: 0, y: 0 } });

/** Equality of the EFFECTIVE state (after per-slot bounds clamping). A linked
 * target a slot's bounds cannot reach (e.g. a large image whose lower bound
 * is fit=multiplier 1 vs a tiny image's 1:1 multiplier 1/fit<1) clamps to the
 * slot's own bound: the record then already IS the effective state, and no
 * amount of re-sync may chase the unreachable value. */
const sameEffectiveZoom = (a: CompareZoomState, b: CompareZoomState): boolean =>
  Math.abs(a.multiplier - b.multiplier) < 1e-9
  && Math.abs(a.offset.x - b.offset.x) < 1e-6
  && Math.abs(a.offset.y - b.offset.y) < 1e-6;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * 2–4 image compare surface (MATERIAL-VIEW-COMPARE-R1).
 *
 * One consistent state model (see materialCompareGeometry for the rules):
 * - Session slot state lives in Records keyed by ASSET ID, never by array
 *   index: replacing or removing one slot never disturbs the others.
 * - INDEPENDENT mode edits the ACTIVE slot's fit-relative multiplier.
 * - LINKED mode drives every slot from ONE shared fit-relative multiplier,
 *   and linked PAN applies the same pixel delta to every slot. Turning
 *   linked on adopts the active slot's multiplier — no jump for the slot
 *   being viewed.
 * - "100%" is ABSOLUTE (1 image px = 1 CSS px, per-slot multiplier 1/fit);
 *   the readout labels it "1:1" and never conflates it with fit.
 * - The keyboard is fully trapped, including Tab cycling; focus cannot
 *   leave the dialog while it is open.
 */
export default function MaterialCompareModal({
  slotAssetIds,
  assetsById,
  availableImages,
  onClose,
  onSlotIdsChanged,
}: {
  /** Stable slot order as asset ids; the page keeps this authoritative. */
  slotAssetIds: string[];
  /** Live asset lookup (refreshed against the material snapshot by the page). */
  assetsById: Map<string, MaterialCompareSlotAsset>;
  /** Lightweight replace source: currently visible supported images. */
  availableImages: MaterialCompareSlotAsset[];
  onClose: () => void;
  onSlotIdsChanged?: (slotAssetIds: string[]) => void;
}) {
  const { t } = useI18n();
  const [slotIds, setSlotIds] = useState<string[]>(() => slotAssetIds.slice(0, 4));
  const [views, setViews] = useState<Record<string, SlotView>>({});
  // zooms is the ONE effective compare state: render, wheel, pan, readout
  // and bounds all read the same per-slot records. In linked mode every
  // ready slot's record carries the SAME fit-relative multiplier (maintained
  // by each gesture and transition below — never a hidden parallel value).
  const [zooms, setZooms] = useState<Record<string, CompareZoomState>>({});
  const [linked, setLinked] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ kind: "closed" } | { kind: "supplement" } | { kind: "replace"; index: number }>(
    () => slotAssetIds.length < 2 ? { kind: "supplement" } : { kind: "closed" },
  );
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<MaterialViewerBounds>({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
  // Armed until a close is requested: once the host starts closing (and
  // typically moves focus to the entry point), the safety net must not pull
  // focus back into a dialog that is about to unmount.
  const closingRef = useRef(false);
  const stageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // The comparison surface shares the immersive viewer's content rectangle.
  // Observe .main so collapsing the sidebar also updates its bounds.
  useLayoutEffect(() => {
    const main = document.querySelector(".react-nav-shell .main") as HTMLElement | null;
    const updateBounds = () => {
      const rect = main?.getBoundingClientRect();
      setBounds(rect
        ? resolveMaterialViewerBounds(rect, main?.querySelector(".titlebar")?.getBoundingClientRect().height ?? 0)
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
    };
    updateBounds();
    const observer = main && typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBounds) : null;
    if (main && observer) observer.observe(main);
    window.addEventListener("resize", updateBounds);
    return () => { observer?.disconnect(); window.removeEventListener("resize", updateBounds); };
  }, []);

  // Last-known asset snapshot: slots render from SLOT IDS, so an externally
  // deleted asset keeps its cell and flips to a visible missing state
  // instead of silently vanishing from the grid.
  const knownAssetsRef = useRef<Record<string, MaterialCompareSlotAsset>>({});
  for (const asset of assetsById.values()) knownAssetsRef.current[asset.id] = asset;
  const slotKey = slotIds.join("|");
  const slots = useMemo(
    () => slotIds.map((id) => assetsById.get(id) ?? knownAssetsRef.current[id]).filter((asset): asset is MaterialCompareSlotAsset => Boolean(asset)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assetsById, slotKey],
  );
  const activeAsset = slots.find((asset) => asset.id === activeId) ?? slots[0] ?? null;
  const activeSlotId = activeAsset?.id ?? null;
  const columns = resolveCompareGridColumns(slots.length);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const notifySlots = useCallback((next: string[]) => {
    onSlotIdsChanged?.(next);
  }, [onSlotIdsChanged]);

  // Slot mutations are CLICK-driven (picker/mini buttons): compute from the
  // render-scope ids, set purely, and notify the host SEQUENTIALLY — a
  // parent setState must never run inside a state updater (React runs
  // updaters during render and flags cross-component updates).
  const replaceSlot = useCallback((index: number, asset: MaterialCompareSlotAsset) => {
    if (index < 0 || index >= slotIds.length) return;
    const existing = slotIds.indexOf(asset.id);
    if (existing !== -1 && existing !== index) return;
    const next = slotIds.map((id, at) => (at === index ? asset.id : id));
    setSlotIds(next);
    notifySlots(next);
  }, [notifySlots, slotIds]);

  const removeSlot = useCallback((assetId: string) => {
    const next = slotIds.filter((id) => id !== assetId);
    if (next.length === slotIds.length) return;
    setSlotIds(next);
    if (next.length < 2) {
      setPicker({ kind: "supplement" });
    }
    notifySlots(next);
  }, [notifySlots, slotIds]);

  const addSlot = useCallback((asset: MaterialCompareSlotAsset) => {
    if (slotIds.length >= 4 || slotIds.includes(asset.id)) return;
    const next = [...slotIds, asset.id];
    setSlotIds(next);
    notifySlots(next);
  }, [notifySlots, slotIds]);

  // Keyed-by-assetId bookkeeping: a NEW id starts in loading/fit; a known
  // id keeps its zoom and loaded state untouched (single-slot reset only).
  useEffect(() => {
    setViews((current) => {
      const next: Record<string, SlotView> = {};
      for (const id of slotIds) next[id] = current[id] ?? { status: "loading" };
      return next;
    });
    setZooms((current) => {
      const next: Record<string, CompareZoomState> = {};
      for (const id of slotIds) next[id] = current[id] ?? FIT_ZOOM();
      return next;
    });
    setActiveId((current) => (current && slotIds.includes(current) ? current : slotIds[0] ?? null));
    // Removal unmounts the button that held focus; keep the trap armed.
    rootRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey]);

  // External deletion: an id the page no longer knows flips to "missing"
  // (replace/remove offered); it can never resurrect silently.
  useEffect(() => {
    setViews((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of slotIds) {
        if (!assetsById.has(id) && next[id]?.status !== "missing") {
          next[id] = { status: "missing" };
          changed = true;
        } else if (assetsById.has(id) && next[id]?.status === "missing") {
          // The id came back (e.g. an undo): let it load fresh.
          next[id] = { status: "loading" };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [assetsById, slotKey]);

  const stageSize = useCallback((assetId: string): CompareDimensions => {
    const element = stageRefs.current[assetId];
    if (!element) return { width: 0, height: 0 };
    return { width: element.clientWidth, height: element.clientHeight };
  }, []);

  /** Zoom ONE slot by factor around a stage-local anchor. */
  const zoomSlot = useCallback((assetId: string, factor: number, anchor: { x: number; y: number }) => {
    const view = views[assetId];
    if (!view || view.status !== "ready") return;
    const stage = stageSize(assetId);
    if (stage.width <= 0 || stage.height <= 0) return;
    setZooms((current) => ({
      ...current,
      [assetId]: zoomCompareSlot(current[assetId] ?? FIT_ZOOM(), factor, anchor, stage, view.image),
    }));
  }, [stageSize, views]);

  /** LINKED zoom: the originating slot zooms at its anchor; every other
   * ready slot applies the same multiplier RATIO anchored at its own center,
   * so the shared multiplier semantics hold across mixed aspect ratios. */
  const zoomLinked = useCallback((originId: string, factor: number, anchor: { x: number; y: number }) => {
    const originView = views[originId];
    if (!originView || originView.status !== "ready") return;
    const stage = stageSize(originId);
    if (stage.width <= 0 || stage.height <= 0) return;
    const originZoom = zooms[originId] ?? FIT_ZOOM();
    const nextOrigin = zoomCompareSlot(originZoom, factor, anchor, stage, originView.image);
    const ratio = nextOrigin.multiplier / Math.max(1e-9, originZoom.multiplier);
    setZooms((current) => {
      const next = { ...current };
      for (const id of slotIds) {
        if (id === originId) {
          next[id] = nextOrigin;
          continue;
        }
        const view = views[id];
        if (!view || view.status !== "ready") continue;
        const slotStage = stageSize(id);
        if (slotStage.width <= 0 || slotStage.height <= 0) continue;
        next[id] = zoomCompareSlot(
          current[id] ?? FIT_ZOOM(),
          ratio,
          { x: slotStage.width / 2, y: slotStage.height / 2 },
          slotStage,
          view.image,
        );
      }
      return next;
    });
  }, [slotIds, stageSize, views, zooms]);

  /** LINKED pan: same pixel delta on every ready slot, each clamped. */
  const panLinkedBy = useCallback((originId: string, delta: { x: number; y: number }) => {
    void originId;
    setZooms((current) => {
      const next = { ...current };
      for (const id of slotIds) {
        const view = views[id];
        if (!view || view.status !== "ready") continue;
        const stage = stageSize(id);
        const zoom = current[id] ?? FIT_ZOOM();
        const fit = resolveCompareFitScale(stage, view.image);
        const projected = resolveCompareProjection(view.image, zoom.multiplier, fit);
        next[id] = {
          multiplier: zoom.multiplier,
          offset: {
            x: clampComparePanOffset(zoom.offset.x + delta.x, projected.width, stage.width),
            y: clampComparePanOffset(zoom.offset.y + delta.y, projected.height, stage.height),
          },
        };
      }
      return next;
    });
  }, [slotIds, stageSize, views]);

  const toggleLinked = useCallback(() => {
    // Disabling linked keeps the records exactly as rendered — the visible
    // state carries over with no jump. (Sequential setters, no nested
    // setState inside an updater: the app mounts under StrictMode.)
    if (linked) {
      setLinked(false);
      return;
    }
    // Enabling linked ADOPTS the active slot's multiplier as the shared
    // value and COMMITS it into every other ready slot's record (re-anchored
    // at each center) — the visible unification is explicit, and the
    // records become the shared state itself.
    const source = activeSlotId ? zooms[activeSlotId] : null;
    const shared = source ? source.multiplier : 1;
    setZooms((zoomsNow) => {
      let changed = false;
      const next = { ...zoomsNow };
      for (const id of slotIds) {
        if (id === activeSlotId) continue;
        const view = views[id];
        if (!view || view.status !== "ready") continue;
        const stage = stageSize(id);
        if (stage.width <= 0 || stage.height <= 0) continue;
        const zoom = next[id] ?? FIT_ZOOM();
        if (Math.abs(zoom.multiplier - shared) < 1e-9) continue;
        const applied = zoomCompareSlot(
          zoom,
          shared / Math.max(1e-9, zoom.multiplier),
          { x: stage.width / 2, y: stage.height / 2 },
          stage,
          view.image,
        );
        // The clamp may make the shared target unreachable for this slot —
        // its own bound IS the effective state; never re-chase it.
        if (sameEffectiveZoom(applied, zoom)) continue;
        next[id] = applied;
        changed = true;
      }
      return changed ? next : zoomsNow;
    });
    setLinked(true);
  }, [activeSlotId, linked, slotIds, stageSize, views, zooms]);

  /** A slot that just became ready while linked adopts the shared multiplier
   * (add/replace follow the SAME rule as every other linked transition).
   * Equality is judged on the EFFECTIVE post-clamp state: a slot whose bounds
   * cannot reach the shared target keeps its own bound and this returns the
   * ORIGINAL record object — repeated calls converge instead of looping. */
  const adoptLinkedScale = useCallback((assetId: string, image: CompareDimensions) => {
    if (!linked) return;
    setZooms((current) => {
      const source = activeSlotId ? current[activeSlotId] : null;
      const shared = source ? source.multiplier : 1;
      const zoom = current[assetId] ?? FIT_ZOOM();
      if (Math.abs(zoom.multiplier - shared) < 1e-9) return current;
      const stage = stageSize(assetId);
      if (stage.width <= 0 || stage.height <= 0) return current;
      const applied = zoomCompareSlot(
        zoom,
        shared / Math.max(1e-9, zoom.multiplier),
        { x: stage.width / 2, y: stage.height / 2 },
        stage,
        image,
      );
      if (sameEffectiveZoom(applied, zoom)) return current;
      return { ...current, [assetId]: applied };
    });
  }, [activeSlotId, linked, stageSize]);

  const resetSlot = useCallback((assetId: string) => {
    setZooms((current) => ({ ...current, [assetId]: FIT_ZOOM() }));
  }, []);

  const resetAll = useCallback(() => {
    setZooms(() => {
      const next: Record<string, CompareZoomState> = {};
      for (const id of slotIds) next[id] = FIT_ZOOM();
      return next;
    });
  }, [slotIds]);

  const fitActive = useCallback(() => {
    // In linked mode fit resets the SHARED multiplier to 1 (every slot goes
    // back to its own fit); in independent mode only the active slot resets.
    if (linked) {
      // Shared fit = every ready record's multiplier returns to 1 (each slot
      // back to its own fit), offsets reset — one atomic record update.
      setZooms((current) => {
        const next = { ...current };
        for (const id of slotIds) next[id] = FIT_ZOOM();
        return next;
      });
      return;
    }
    if (!activeSlotId) return;
    resetSlot(activeSlotId);
  }, [activeSlotId, linked, resetSlot, slotIds]);

  /** ABSOLUTE 1:1 (per-slot 1/fit) for the ACTIVE slot. In linked mode the
   * active slot's absolute target becomes the shared multiplier — every
   * ready slot follows by the same ratio (each clamped to its own bounds),
   * so the records stay the one effective state. */
  const oneToOne = useCallback(() => {
    if (!activeSlotId) return;
    const applyTo = (id: string, current: Record<string, CompareZoomState>): CompareZoomState | null => {
      const view = views[id];
      if (!view || view.status !== "ready") return null;
      const stage = stageSize(id);
      if (stage.width <= 0 || stage.height <= 0) return null;
      const target = resolveOneToOneMultiplier(stage, view.image);
      const zoom = current[id] ?? FIT_ZOOM();
      return zoomCompareSlot(
        zoom,
        target / Math.max(1e-9, zoom.multiplier),
        { x: stage.width / 2, y: stage.height / 2 },
        stage,
        view.image,
      );
    };
    if (!linked) {
      setZooms((current) => {
        const applied = applyTo(activeSlotId, current);
        return applied ? { ...current, [activeSlotId]: applied } : current;
      });
      return;
    }
    const originView = views[activeSlotId];
    const originStage = stageSize(activeSlotId);
    if (!originView || originView.status !== "ready" || originStage.width <= 0 || originStage.height <= 0) return;
    const originZoom = zooms[activeSlotId] ?? FIT_ZOOM();
    const target = resolveOneToOneMultiplier(originStage, originView.image);
    const ratio = target / Math.max(1e-9, originZoom.multiplier);
    setZooms((current) => {
      const next = { ...current };
      for (const id of slotIds) {
        const view = views[id];
        if (!view || view.status !== "ready") continue;
        const stage = stageSize(id);
        if (stage.width <= 0 || stage.height <= 0) continue;
        next[id] = zoomCompareSlot(
          current[id] ?? FIT_ZOOM(),
          ratio,
          { x: stage.width / 2, y: stage.height / 2 },
          stage,
          view.image,
        );
      }
      return next;
    });
  }, [activeSlotId, linked, slotIds, stageSize, views, zooms]);

  const isAbsoluteOneToOne = useCallback((assetId: string) => {
    const view = views[assetId];
    if (!view || view.status !== "ready") return false;
    const stage = stageSize(assetId);
    if (stage.width <= 0 || stage.height <= 0) return false;
    const target = resolveOneToOneMultiplier(stage, view.image);
    const current = zooms[assetId]?.multiplier ?? 1;
    return Math.abs(current - target) / Math.max(1e-9, target) < 1e-3;
  }, [stageSize, views, zooms]);

  const activeReadout = useMemo(() => {
    if (!activeSlotId) return "—";
    const view = views[activeSlotId];
    if (!view || view.status !== "ready") return "—";
    const stage = stageSize(activeSlotId);
    const fit = resolveCompareFitScale(stage, view.image);
    const zoom = zooms[activeSlotId] ?? FIT_ZOOM();
    const absolute = zoom.multiplier * fit;
    if (Math.abs(absolute - 1) < 1e-3) return "1:1";
    return `${Math.round(absolute * 100)}%${Math.abs(zoom.multiplier - 1) < 1e-6 ? " fit" : ""}`;
  }, [activeSlotId, stageSize, views, zooms]);

  // Native NON-PASSIVE wheel listeners per stage (React onWheel is passive —
  // preventDefault would be ignored there and the page could scroll).
  useEffect(() => {
    const entries: Array<{ element: HTMLDivElement; handler: (event: WheelEvent) => void }> = [];
    for (const asset of slots) {
      const element = stageRefs.current[asset.id];
      if (!element) continue;
      const handler = (wheelEvent: WheelEvent) => {
        wheelEvent.preventDefault();
        const id = asset.id;
        setActiveId(id);
        const rect = element.getBoundingClientRect();
        const anchor = { x: wheelEvent.clientX - rect.left, y: wheelEvent.clientY - rect.top };
        const factor = wheelEvent.deltaY < 0 ? 1.1 : 1 / 1.1;
        if (linked) zoomLinked(id, factor, anchor);
        else zoomSlot(id, factor, anchor);
      };
      element.addEventListener("wheel", handler, { passive: false });
      entries.push({ element, handler });
    }
    return () => {
      for (const { element, handler } of entries) element.removeEventListener("wheel", handler);
    };
  }, [linked, slots, zoomLinked, zoomSlot]);

  // Resize re-clamps every ready slot (multiplier semantics survive).
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      setZooms((current) => {
        const next = { ...current };
        for (const asset of slots) {
          const view = views[asset.id];
          if (!view || view.status !== "ready") continue;
          const stage = stageSize(asset.id);
          if (stage.width <= 0 || stage.height <= 0) continue;
          next[asset.id] = reclampCompareStateAfterResize(current[asset.id] ?? FIT_ZOOM(), stage, view.image);
        }
        return next;
      });
    });
    for (const asset of slots) {
      const element = stageRefs.current[asset.id];
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [slots, stageSize, views]);

  const insufficient = slots.length < 2;
  const expandedPicker = picker.kind === "supplement";

  useLayoutEffect(() => {
    if (picker.kind !== "closed" || closingRef.current) return;
    const dialog = rootRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
  }, [picker.kind]);

  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const key = event.key;
    if (key === "Tab") {
      event.preventDefault();
      const dialog = rootRef.current;
      if (!dialog) return;
      const scope = picker.kind !== "closed"
        ? dialog.querySelector<HTMLElement>(".material-compare-picker") ?? dialog
        : dialog;
      const focusables = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null);
      if (focusables.length === 0) {
        dialog.focus({ preventScroll: true });
        return;
      }
      const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
        : (currentIndex === focusables.length - 1 ? 0 : currentIndex + 1);
      focusables[nextIndex].focus({ preventScroll: true });
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      if (picker.kind !== "closed") setPicker({ kind: "closed" });
      else { closingRef.current = true; onClose(); }
      return;
    }
    if (picker.kind !== "closed") return;
    if (key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      if (!activeSlotId) return;
      const currentIndex = slotIds.indexOf(activeSlotId);
      const nextIndex = Math.min(slotIds.length - 1, Math.max(0, currentIndex + (key === "ArrowRight" ? 1 : -1)));
      setActiveId(slotIds[nextIndex]);
      return;
    }
    if (key === "+" || key === "=") {
      event.preventDefault();
      if (!activeSlotId) return;
      const stage = stageSize(activeSlotId);
      const anchor = { x: stage.width / 2, y: stage.height / 2 };
      if (linked) zoomLinked(activeSlotId, 1.25, anchor);
      else zoomSlot(activeSlotId, 1.25, anchor);
      return;
    }
    if (key === "-" || key === "_") {
      event.preventDefault();
      if (!activeSlotId) return;
      const stage = stageSize(activeSlotId);
      const anchor = { x: stage.width / 2, y: stage.height / 2 };
      if (linked) zoomLinked(activeSlotId, 0.8, anchor);
      else zoomSlot(activeSlotId, 0.8, anchor);
      return;
    }
    if (key === "0") { event.preventDefault(); fitActive(); return; }
    if (key === "1") { event.preventDefault(); oneToOne(); return; }
    if (key === "l" || key === "L") { event.preventDefault(); toggleLinked(); return; }
    if (key === "r" || key === "R") { event.preventDefault(); resetAll(); return; }
  }, [activeSlotId, fitActive, linked, onClose, oneToOne, picker, resetAll, slotIds, stageSize, toggleLinked, zoomLinked, zoomSlot]);

  // Focus safety net: if focus lands outside the dialog (an element the trap
  // relied on unmounted), pull it back — focus never escapes while open.
  // closingRef disarms it from the moment a close is requested.
  useEffect(() => {
    const handleFocus = () => {
      if (closingRef.current) return;
      const dialog = rootRef.current;
      if (!dialog) return;
      if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  const pickerCandidates = useMemo(() => {
    const inSlots = new Set(slotIds);
    return availableImages.filter((asset) => !inSlots.has(asset.id)).slice(0, 60);
  }, [availableImages, slotIds]);

  const startPan = useCallback((asset: MaterialCompareSlotAsset, event: React.PointerEvent<HTMLDivElement>) => {
    const view = views[asset.id];
    if (!view || view.status !== "ready") return;
    event.preventDefault();
    event.stopPropagation();
    setActiveId(asset.id);
    const target = event.currentTarget as HTMLDivElement;
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    const originZoom = zooms[asset.id] ?? FIT_ZOOM();
    const startX = event.clientX - originZoom.offset.x;
    const startY = event.clientY - originZoom.offset.y;
    const stage = stageSize(asset.id);
    const image = view.image;
    const originFit = resolveCompareFitScale(stage, image);
    const originBounds = resolveCompareMultiplierBounds(originFit);
    const projectedSize = () => resolveCompareProjection(
      image,
      clampCompareMultiplierToBounds(originZoom.multiplier, originBounds),
      originFit,
    );
    const lastDelta = { x: 0, y: 0 };
    const move = (moveEvent: PointerEvent) => {
      const projected = projectedSize();
      lastDelta.x = clampComparePanOffset(moveEvent.clientX - startX, projected.width, stage.width) - originZoom.offset.x;
      lastDelta.y = clampComparePanOffset(moveEvent.clientY - startY, projected.height, stage.height) - originZoom.offset.y;
      if (linked) {
        panLinkedBy(asset.id, lastDelta);
      } else {
        setZooms((current) => ({
          ...current,
          [asset.id]: { multiplier: originZoom.multiplier, offset: { x: originZoom.offset.x + lastDelta.x, y: originZoom.offset.y + lastDelta.y } },
        }));
      }
    };
    const cleanup = () => {
      target.removeEventListener("pointermove", move as EventListener);
      target.removeEventListener("pointerup", cleanup as EventListener);
      target.removeEventListener("pointercancel", cleanup as EventListener);
      target.removeEventListener("lostpointercapture", cleanup as EventListener);
      try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("pointerup", cleanup as EventListener);
    target.addEventListener("pointercancel", cleanup as EventListener);
    target.addEventListener("lostpointercapture", cleanup as EventListener);
  }, [linked, panLinkedBy, stageSize, views, zooms]);

  return (
    <div
      className="material-compare-backdrop"
      style={{ "--viewer-left": `${bounds.left}px`, "--viewer-top": `${bounds.top}px`, "--viewer-width": `${bounds.width}px`, "--viewer-height": `${bounds.height}px` } as CSSProperties}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) { closingRef.current = true; onClose(); }
      }}
    >
      <div
        ref={rootRef}
        className="material-compare-dialog"
        data-tools-expanded={toolsExpanded}
        role="dialog"
        aria-modal="true"
        aria-label={t("materials.compare.title")}
        tabIndex={-1}
        onKeyDown={handleRootKeyDown}
      >
        <div className="material-compare-toolbar">
          <div className="material-compare-actions">
            {toolsExpanded ? (
              <div className="material-compare-extra-actions">
            <button type="button" className={`material-compare-btn icon${activeSlotId && (zooms[activeSlotId]?.multiplier ?? 1) === 1 ? " active" : ""}`} title={t("materials.compare.fit")} aria-label={t("materials.compare.fit")} onClick={fitActive}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" /></svg></button>
            <button type="button" className={`material-compare-btn icon${activeSlotId && isAbsoluteOneToOne(activeSlotId) ? " active" : ""}`} title={t("materials.compare.oneToOne")} aria-label={t("materials.compare.oneToOne")} onClick={() => oneToOne()}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="2" /><path d="M7 13V7.5l-1.5 1M11 8h.01M14 8h.01" /></svg></button>
            <button type="button" className={`material-compare-btn icon${linked ? " active" : ""}`} title={t("materials.compare.linked")} aria-label={t("materials.compare.linked")} aria-pressed={linked} onClick={toggleLinked}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.1 12.1 11.9 8m-6 5.5H5a3 3 0 0 1 0-6h3m4 0h3a3 3 0 0 1 0 6h-3" /></svg></button>
            <button type="button" className="material-compare-btn icon" title={t("materials.compare.reset")} aria-label={t("materials.compare.reset")} onClick={resetAll}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 9a6 6 0 1 1 1.4 4M4 5v4h4" /></svg></button>
              </div>
            ) : null}
            <button type="button" className="material-compare-btn icon material-compare-toggle" title={toolsExpanded ? t("materials.compare.collapseTools") : t("materials.compare.expandTools")} aria-label={toolsExpanded ? t("materials.compare.collapseTools") : t("materials.compare.expandTools")} aria-expanded={toolsExpanded} onClick={() => setToolsExpanded((value) => !value)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
            <span className="material-compare-zoomreadout">{activeReadout}</span>
            <button type="button" className="material-compare-btn material-compare-close" onClick={() => { closingRef.current = true; onClose(); }} aria-label={t("materials.compare.close")}>✕</button>
          </div>
        </div>
        {insufficient && picker.kind === "closed" ? (
          <div className="material-compare-insufficient" role="status">
            <p>{t("materials.compare.reason.tooFew")}</p>
            <button type="button" className="material-compare-btn" onClick={() => setPicker({ kind: "supplement" })}>{t("materials.compare.addSlot")}</button>
          </div>
        ) : null}
        {slots.length > 0 ? (
          <div className={`material-compare-grid cols-${columns}${expandedPicker ? " supplementing" : ""}`}>
            {slots.map((asset, index) => {
              const view = views[asset.id];
              const zoom = zooms[asset.id] ?? FIT_ZOOM();
              const stage = stageSize(asset.id);
              const fit = view?.status === "ready" ? resolveCompareFitScale(stage, view.image) : 1;
              const safeFit = Number.isFinite(fit) && fit > 0 ? fit : 1;
              const bounds = resolveCompareMultiplierBounds(safeFit);
              const multiplier = clampCompareMultiplierToBounds(zoom.multiplier, bounds);
              const scale = multiplier * safeFit;
              const projectedWidth = view?.status === "ready" ? view.image.width * scale : 0;
              const projectedHeight = view?.status === "ready" ? view.image.height * scale : 0;
              const renderOffsetX = view?.status === "ready" ? clampComparePanOffset(zoom.offset.x, projectedWidth, stage.width) : 0;
              const renderOffsetY = view?.status === "ready" ? clampComparePanOffset(zoom.offset.y, projectedHeight, stage.height) : 0;
              const identity = SLOT_IDENTITY(asset);
              const active = asset.id === activeSlotId;
              return (
                <div
                  key={asset.id}
                  className={`material-compare-cell${active ? " active" : ""}`}
                  data-cell-index={index}
                  onPointerDown={() => setActiveId(asset.id)}
                >
                  <div className="material-compare-cell-head">
                    <span className="material-compare-name" title={asset.name}>{asset.name}</span>
                    <span className="material-compare-dims">
                      {view && view.status === "ready" ? `${view.image.width} × ${view.image.height}` : "—"}
                    </span>
                  </div>
                  <div
                    ref={(element) => { stageRefs.current[asset.id] = element; }}
                    className="material-compare-stage"
                    data-testid={`compare-stage-${asset.id}`}
                    onPointerDown={(event) => startPan(asset, event)}
                    onDragStart={(event) => event.preventDefault()}
                  >
                    {view?.status === "missing" ? (
                      <div className="material-compare-error" role="alert">
                        <span>{t("materials.compare.missing")}</span>
                        <button type="button" className="material-compare-btn" onClick={(event) => { event.stopPropagation(); setPicker({ kind: "replace", index }); }}>{t("materials.compare.replace")}</button>
                        <button type="button" className="material-compare-btn" onClick={(event) => { event.stopPropagation(); removeSlot(asset.id); }}>{t("materials.compare.remove")}</button>
                      </div>
                    ) : view?.status === "error" ? (
                      <div className="material-compare-error" role="alert">
                        <span>{t("materials.compare.loadFailed")}</span>
                        <button type="button" className="material-compare-btn" onClick={(event) => { event.stopPropagation(); setViews((current) => ({ ...current, [asset.id]: { status: "loading" } })); }}>{t("materials.compare.retry")}</button>
                        <button type="button" className="material-compare-btn" onClick={(event) => { event.stopPropagation(); setPicker({ kind: "replace", index }); }}>{t("materials.compare.replace")}</button>
                      </div>
                    ) : (
                      <img
                        src={SLOT_SOURCE(asset)}
                        alt={asset.name}
                        draggable={false}
                        data-testid={`compare-image-${asset.id}`}
                        style={{ transform: `translate(${renderOffsetX}px, ${renderOffsetY}px) scale(${scale})` }}
                        ref={(element) => {
                          if (!element || !element.complete) return;
                          // Only the REAL loading->ready transition runs the
                          // ready bookkeeping (this inline ref re-attaches on
                          // every commit; ready slots must be a no-op).
                          if (views[asset.id]?.status !== "loading") return;
                          const ok = element.naturalWidth > 0 && element.naturalHeight > 0;
                          const image = ok ? { width: element.naturalWidth, height: element.naturalHeight } : null;
                          setViews((current) => {
                            const slot = current[asset.id];
                            if (!slot || slot.status !== "loading") return current;
                            if (SLOT_IDENTITY(assetsById.get(asset.id) ?? asset) !== identity) return current;
                            return { ...current, [asset.id]: ok && image ? { status: "ready", image } : { status: "error" } };
                          });
                          if (ok && image) adoptLinkedScale(asset.id, image);
                        }}
                        onLoad={(event) => {
                          // Same transition gate as the ref path: a load event
                          // for a slot already marked ready (e.g. the cached
                          // ref path won the race) changes nothing.
                          if (views[asset.id]?.status !== "loading") return;
                          const element = event.currentTarget;
                          const image = { width: element.naturalWidth, height: element.naturalHeight };
                          setViews((current) => {
                            if (SLOT_IDENTITY(assetsById.get(asset.id) ?? asset) !== identity) return current;
                            const slot = current[asset.id];
                            if (slot && slot.status === "ready") return current;
                            return { ...current, [asset.id]: { status: "ready", image } };
                          });
                          adoptLinkedScale(asset.id, image);
                        }}
                        onError={() => {
                          setViews((current) => {
                            if (SLOT_IDENTITY(assetsById.get(asset.id) ?? asset) !== identity) return current;
                            const slot = current[asset.id];
                            if (slot && slot.status === "error") return current;
                            return { ...current, [asset.id]: { status: "error" } };
                          });
                        }}
                      />
                    )}
                  </div>
                  <div className="material-compare-cell-foot">
                    <span className={`material-compare-slotstate${view?.status === "loading" ? " loading" : ""}${(view?.status === "error" || view?.status === "missing") ? " error" : ""}`}>
                      {view?.status === "loading" ? t("materials.compare.loading")
                        : view?.status === "error" ? t("materials.compare.loadFailed")
                        : view?.status === "missing" ? t("materials.compare.missing")
                        : (Math.abs(scale - 1) < 1e-3 ? "1:1" : `${Math.round(scale * 100)}%${Math.abs(multiplier - 1) < 1e-6 ? " fit" : ""}`)}
                    </span>
                    <span className="material-compare-slotactions">
                      <button type="button" className="material-compare-mini" onClick={(event) => { event.stopPropagation(); setPicker({ kind: "replace", index }); }}>{t("materials.compare.replace")}</button>
                      <button type="button" className="material-compare-mini" onClick={(event) => { event.stopPropagation(); removeSlot(asset.id); }}>{t("materials.compare.remove")}</button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {picker.kind !== "closed" ? (
          <div className={`material-compare-picker${expandedPicker ? " expanded" : ""}`} role="dialog" aria-label={t("materials.compare.pickTitle")}>
            <div className="material-compare-picker-head">
              <span>{t("materials.compare.pickTitle")}</span>
              {expandedPicker && slots[0] ? <span className="material-compare-kept" title={slots[0].name}>
                <img src={SLOT_SOURCE(slots[0])} alt="" />{t("materials.compare.keptImage")}: {slots[0].name}
              </span> : null}
              <button type="button" className="material-compare-mini" onClick={() => setPicker({ kind: "closed" })} aria-label={t("materials.compare.close")}>✕</button>
            </div>
            <div className="material-compare-picker-list">
              {pickerCandidates.length === 0 ? <span className="material-compare-picker-empty">{t("materials.compare.pickEmpty")}</span> : null}
              {pickerCandidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className="material-compare-picker-item"
                  onClick={() => {
                    if (picker.kind === "replace") replaceSlot(picker.index, candidate);
                    else addSlot(candidate);
                    setPicker({ kind: "closed" });
                  }}
                >
                  <img src={SLOT_SOURCE(candidate)} alt="" draggable={false} />
                  <span title={candidate.name}>{candidate.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
