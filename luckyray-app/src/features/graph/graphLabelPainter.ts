const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const PADDING = 4;
const MAX_PIXELS = 8 * 1024 * 1024;
type LabelRaster = { canvas: HTMLCanvasElement; width: number; height: number; fontSize: number };
type RasterRequest = {text: string; color: string; fontSize: number};

/** Keep text shaping/rasterization out of continuous camera frames. The label
 * positions, font size, colour and opacity still come from the existing renderer. */
export class GraphLabelPainter {
  private rasters = new Map<string, LabelRaster>();
  private pixels = 0;
  private density = 0;
  private pending = new Map<string, RasterRequest>();
  private idle = 0;

  clear() {
    if (this.idle) window.cancelIdleCallback(this.idle);
    this.idle = 0;
    this.pending.clear();
    for (const {canvas} of this.rasters.values()) { canvas.width = 0; canvas.height = 0; }
    this.rasters.clear();
    this.pixels = 0;
  }

  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fontSize: number, color: string, dpr: number) {
    if (this.density !== dpr) { this.clear(); this.density = dpr; }
    // Rasterize near the actual reading size, then scale by the exact continuous
    // size. One maximum-size bitmap made small names too faint on 1x displays.
    const rasterFontSize = Math.max(12, Math.round(fontSize));
    const key = `${rasterFontSize}\0${color}\0${text}`;
    let raster = this.rasters.get(key);
    if (raster) { this.rasters.delete(key); this.rasters.set(key, raster); }
    else if (typeof window.requestIdleCallback === 'function') {
      if (this.pending.size < 512) this.pending.set(key, {text, color, fontSize: rasterFontSize});
      this.prepareWhenIdle();
    }
    if (raster) {
      const scale = fontSize / raster.fontSize;
      ctx.drawImage(raster.canvas, x - PADDING * scale, y - PADDING * scale, raster.width * scale, raster.height * scale);
    } else {
      // A cold name uses the original renderer. Preparing many textures inside
      // this input frame would merely replace the old spike with another one.
      ctx.font = `${fontSize}px ${FONT_FAMILY}`; ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }
  }

  private prepareWhenIdle() {
    if (this.idle) return;
    this.idle = window.requestIdleCallback(deadline => {
      this.idle = 0;
      while (deadline.timeRemaining() > 2 && this.pending.size) {
        const next = this.pending.entries().next().value!;
        this.pending.delete(next[0]);
        this.prepare(next[0], next[1]);
      }
      if (this.pending.size) this.prepareWhenIdle();
    });
  }

  private prepare(key: string, {text, color, fontSize: rasterFontSize}: RasterRequest) {
    const dpr = this.density;
    const canvas = document.createElement('canvas');
    const paint = canvas.getContext('2d');
    if (paint) {
      paint.font = `${rasterFontSize}px ${FONT_FAMILY}`;
      const width = Math.ceil(paint.measureText(text).width + PADDING * 2);
      const height = rasterFontSize * 1.5 + PADDING * 2;
      const pixels = Math.ceil(width * dpr) * Math.ceil(height * dpr);
      // Extremely long names retain the direct renderer rather than allocating
      // a very wide texture. Cache memory is bounded per visible graph pane.
      if (pixels <= MAX_PIXELS / 8) {
        while (this.pixels + pixels > MAX_PIXELS || this.rasters.size >= 512) {
          const oldest = this.rasters.entries().next().value;
          if (!oldest) break;
          this.rasters.delete(oldest[0]);
          this.pixels -= oldest[1].canvas.width * oldest[1].canvas.height;
          oldest[1].canvas.width = 0; oldest[1].canvas.height = 0;
        }
        canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
        paint.setTransform(dpr, 0, 0, dpr, 0, 0);
        paint.font = `${rasterFontSize}px ${FONT_FAMILY}`;
        paint.textBaseline = 'top'; paint.fillStyle = color;
        paint.fillText(text, PADDING, PADDING);
        const raster = {canvas, width: canvas.width / dpr, height: canvas.height / dpr, fontSize: rasterFontSize};
        this.rasters.set(key, raster); this.pixels += pixels;
      }
    }
  }
}
