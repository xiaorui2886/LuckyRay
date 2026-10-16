/** Camera math uses screen pixels and logarithmic scale, independent of graph physics. */
export type Camera = { scale: number; panX: number; panY: number };
export type ZoomPoint = { x: number; y: number };
export const GRAPH_MIN_SCALE = 0.025;
export const GRAPH_MAX_SCALE = 12;
const WHEEL_GAIN = 0.0025;

/** A hit node stays at its current screen position, including when the pointer
 * is a few pixels off its centre. Empty-space zoom retains the pointer anchor. */
export function wheelZoomPoint(camera: Camera, pointer: ZoomPoint, node?: ZoomPoint | null): ZoomPoint {
  return node ? {x: node.x * camera.scale + camera.panX, y: node.y * camera.scale + camera.panY} : pointer;
}

export function wheelCamera(displayed: Camera, target: Camera, point: ZoomPoint, delta: number): Camera {
  // A reverse gesture cancels outstanding travel immediately, even a small trackpad tick.
  const reversing = Math.sign(Math.log(target.scale / displayed.scale)) === Math.sign(delta);
  const base = reversing ? displayed.scale : target.scale;
  const scale = Math.max(GRAPH_MIN_SCALE, Math.min(GRAPH_MAX_SCALE, base * Math.exp(-delta * WHEEL_GAIN)));
  return { scale, panX: point.x - (point.x - displayed.panX) * scale / displayed.scale,
    panY: point.y - (point.y - displayed.panY) * scale / displayed.scale };
}

export function stepCamera(displayed: Camera, target: Camera, anchor: ZoomPoint | null, elapsed: number,
  reducedMotion = false): { camera: Camera; moving: boolean } {
  const logDistance = Math.log(target.scale / displayed.scale);
  const panDistance = Math.hypot(target.panX - displayed.panX, target.panY - displayed.panY);
  if (reducedMotion || (Math.abs(logDistance) < 0.00008 && panDistance < 0.08)) {
    return {camera: {...target}, moving: false};
  }
  // A single 28 ms time constant avoids the former slow tail after wheel input ends.
  const factor = 1 - Math.exp(-Math.max(1, Math.min(48, elapsed)) / 28);
  const scale = displayed.scale * Math.exp(logDistance * factor);
  return {moving: true, camera: anchor ? {
    scale, panX: anchor.x - (anchor.x - displayed.panX) * scale / displayed.scale,
    panY: anchor.y - (anchor.y - displayed.panY) * scale / displayed.scale,
  } : {scale, panX: displayed.panX + (target.panX - displayed.panX) * factor,
    panY: displayed.panY + (target.panY - displayed.panY) * factor}};
}

export function fitGraphCamera(points: ReadonlyArray<ZoomPoint>, width: number, height: number): Camera | null {
  if (!points.length || width <= 0 || height <= 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const scale = Math.max(GRAPH_MIN_SCALE, Math.min(1.6, width * 0.86 / Math.max(120, maxX - minX), height * 0.86 / Math.max(120, maxY - minY)));
  return {scale, panX: width / 2 - (minX + maxX) * scale / 2, panY: height / 2 - (minY + maxY) * scale / 2};
}
