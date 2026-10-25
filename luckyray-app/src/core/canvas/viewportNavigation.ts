/** Canvas camera policy. Values are in canvas CSS pixels, never device pixels. */
export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasPoint = { x: number; y: number };
export const CANVAS_MIN_ZOOM = 0.08;
export const CANVAS_MAX_ZOOM = 8;
export const CANVAS_ZOOM_STOPS = [0.08, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;
export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
export function clampCanvasZoom(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, value)) : 1;
}
export function normalizeCanvasViewport(value: unknown): CanvasViewport {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CANVAS_VIEWPORT };
  const v = value as Partial<CanvasViewport>;
  return {x: Number.isFinite(Number(v.x)) ? Number(v.x) : 0, y: Number.isFinite(Number(v.y)) ? Number(v.y) : 0, zoom: clampCanvasZoom(Number(v.zoom))};
}
export function zoomAtPoint(viewport: CanvasViewport, zoom: number, point: CanvasPoint): CanvasViewport {
  const v = normalizeCanvasViewport(viewport), z = clampCanvasZoom(zoom);
  const p = {x: Number.isFinite(point.x) ? point.x : 0, y: Number.isFinite(point.y) ? point.y : 0};
  return {x: p.x - (p.x - v.x) * z / v.zoom, y: p.y - (p.y - v.y) * z / v.zoom, zoom: z};
}
export function nextCanvasZoom(zoom: number, direction: 1 | -1) {
  return (direction > 0 ? CANVAS_ZOOM_STOPS.find(z => z > zoom + .0001)
    : [...CANVAS_ZOOM_STOPS].reverse().find(z => z < zoom - .0001)) ?? (direction > 0 ? CANVAS_MAX_ZOOM : CANVAS_MIN_ZOOM);
}
/** Bound a single wheel packet, not the whole gesture; large OS steps cannot teleport the view. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean) {
  if (!Number.isFinite(deltaY)) return 1;
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 240 : 1);
  const exponent = Math.max(-.28, Math.min(.28, -pixels * (pinch ? .006 : .0018)));
  return Math.exp(exponent);
}
export function parseCanvasZoomPercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned); return Number.isFinite(n) && n > 0 ? clampCanvasZoom(n / 100) : null;
}
export type CameraDriver = {
  read: () => CanvasViewport;
  write: (viewport: CanvasViewport) => void;
  requestFrame: (fn: (time: number) => void) => number;
  cancelFrame: (id: number) => void;
  onActive: (active: boolean) => void;
  onSettled: (viewport: CanvasViewport) => void;
};
/** One interruptible animation, one persisted finish. No D3 transitions or CSS transform easing. */
export function createCanvasZoomMotion(driver: CameraDriver) {
  let frame: number | null = null, target: CanvasViewport | null = null;
  let previousTime: number | null = null, elapsed = 0, active = false;
  const finish = (persist: boolean) => {
    if (frame !== null) driver.cancelFrame(frame);
    frame = null; target = null; previousTime = null; elapsed = 0;
    const wasActive = active; active = false; driver.onActive(false);
    if (persist && wasActive) driver.onSettled(driver.read());
  };
  const step = (time: number) => {
    frame = null; if (!target) return;
    const current = driver.read();
    const dt = previousTime === null ? 16 : Math.min(48, Math.max(1, time - previousTime));
    previousTime = time; elapsed += dt;
    const alpha = 1 - Math.exp(-dt / 38);
    const done = elapsed >= 800 || (Math.abs(Math.log(target.zoom / current.zoom)) < .0005 && Math.abs(target.x-current.x) < .15 && Math.abs(target.y-current.y) < .15);
    try { driver.write(done ? target : {x: current.x + (target.x-current.x)*alpha, y: current.y + (target.y-current.y)*alpha, zoom: current.zoom + (target.zoom-current.zoom)*alpha}); }
    catch (error) { finish(false); throw error; }
    if (done) finish(true); else frame = driver.requestFrame(step);
  };
  const move = (next: CanvasViewport, immediate: boolean) => {
    target = normalizeCanvasViewport(next); elapsed = 0; active = true; driver.onActive(true);
    if (immediate) { try { driver.write(target); } catch (error) { finish(false); throw error; } finish(true); }
    else if (frame === null) frame = driver.requestFrame(step);
  };
  return {
    zoomTo(zoom: number, point: CanvasPoint, immediate = false) { move(zoomAtPoint(driver.read(), zoom, point), immediate); },
    wheel(factor: number, point: CanvasPoint, immediate = false) {
      const current = driver.read();
      // New mouse location uses the CURRENT world point; accumulated scale remains responsive.
      move(zoomAtPoint(current, (target?.zoom ?? current.zoom) * factor, point), immediate);
    },
    pan(dx: number, dy: number, immediate = false) {
      const current = target ?? driver.read();
      move({x: current.x - (Number.isFinite(dx) ? dx : 0), y: current.y - (Number.isFinite(dy) ? dy : 0), zoom: current.zoom}, immediate);
    },
    step(direction: 1 | -1, point: CanvasPoint, immediate = false) {
      move(zoomAtPoint(driver.read(), nextCanvasZoom(target?.zoom ?? driver.read().zoom, direction), point), immediate);
    },
    cancel(persist = true) { finish(persist); },
    get active() { return active; },
  };
}
