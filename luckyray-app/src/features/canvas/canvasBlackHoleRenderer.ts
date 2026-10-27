/** Tiny transparent accretion disk. Texture work happens once, not on each frame.
 * Canvas2D deliberately avoids WebGL contexts on an already GPU-heavy canvas. */
export const BLACK_HOLE = {
  width: 88, height: 64, tilt: -Math.PI / 12, flatten: .49, maxDpr: 2, fps: 30,
  orbitSpeed: .14, flowSpeed: .58, pointerTravel: 1.6, pointerTilt: .055,
} as const;
type OrbState = { busy: boolean; unavailable: boolean };
function seededRandom(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function makeDustTexture(document: Document) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = seededRandom(7219);
  ctx.translate(192, 192);
  // A broad, smoky annulus, with no solid outer border.
  const haze = ctx.createRadialGradient(0, 0, 66, 0, 0, 185);
  haze.addColorStop(0, 'rgba(30,30,56,0)');
  haze.addColorStop(.12, 'rgba(28,32,59,.80)');
  haze.addColorStop(.32, 'rgba(82,94,150,.72)');
  haze.addColorStop(.55, 'rgba(60,79,146,.44)');
  haze.addColorStop(.78, 'rgba(46,60,119,.15)');
  haze.addColorStop(1, 'rgba(20,27,67,0)');
  ctx.fillStyle = haze; ctx.fillRect(-192, -192, 384, 384);
  // Broken pools of periwinkle, cobalt and lilac live inside the same V1 annulus.
  // These are cached pigment clouds, not an extra outer ring or geometry warp.
  const palette = [[82, 108, 196], [119, 116, 183], [151, 153, 180], [71, 92, 157]];
  ctx.filter = 'blur(3px)';
  for (let i = 0; i < 135; i++) {
    const angle = random() * Math.PI * 2, radius = 91 + random() * 63;
    const color = palette[Math.floor(random() * palette.length)];
    ctx.save(); ctx.translate(Math.cos(angle) * radius, Math.sin(angle) * radius); ctx.rotate(angle);
    ctx.fillStyle = `rgba(${color.join(',')},${.025 + random() * .085})`;
    ctx.beginPath(); ctx.ellipse(0, 0, 2 + random() * 7, 5 + random() * 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // One restrained cobalt outer sector keeps the palette visibly varied at launcher scale.
  for (let i = 0; i < 14; i++) {
    const a = .12 + i * .035, r = 139 + Math.sin(i * .7) * 7;
    ctx.save(); ctx.translate(Math.cos(a) * r, Math.sin(a) * r); ctx.rotate(a);
    ctx.fillStyle = 'rgba(68,103,211,.09)'; ctx.beginPath(); ctx.ellipse(0, 0, 6, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  ctx.filter = 'none';
  // Discontinuous curved filaments retain dusty structure rather than concentric CSS rings.
  for (let i = 0; i < 2900; i++) {
    const radius = 74 + Math.pow(random(), .8) * 103;
    const start = random() * Math.PI * 2;
    const length = .025 + random() * .53;
    const ridge = .25 + .75 * Math.pow(.5 + .5 * Math.sin(radius * .23 - start * 3), 2);
    const fade = Math.pow(Math.max(0, 1 - (radius - 90) / 93), 1.7);
    const warm = random() > .91;
    const bluePatch = .5 + .5 * Math.sin(start * 2.3 + radius * .038);
    ctx.strokeStyle = warm ? `rgba(208,185,170,${(.12 + random() * .48) * fade})` : `rgba(${100 + Math.floor(random() * 55) - Math.floor(bluePatch * 20)},${119 + Math.floor(random() * 45)},${182 + Math.floor(random() * 50)},${(.12 + random() * .45) * fade * ridge})`;
    ctx.lineWidth = .35 + random() * 1.65;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let j = 0; j <= 15; j++) {
      const angle = start + j / 15 * length;
      const r = radius + Math.sin(angle * 3 + radius * .08) * 3.2 + j / 15 * (7 + Math.sin(radius) * 5);
      const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
      if (!j) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // A few winding dark fissures separate the luminous streams into uneven clouds.
  ctx.globalCompositeOperation = 'source-atop';
  ctx.filter = 'blur(.8px)';
  for (let i = 0; i < 180; i++) {
    const start = random() * Math.PI * 2, radius = 84 + random() * 76;
    ctx.strokeStyle = `rgba(3,6,18,${.08 + random() * .19})`;
    ctx.lineWidth = .7 + random() * 2; ctx.beginPath();
    const length = .06 + random() * .38;
    for (let j = 0; j <= 20; j++) {
      const angle = start + j / 20 * length, r = radius + j / 20 * 11 + Math.sin(angle * 4 + radius) * 2.5;
      if (!j) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r); else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.stroke();
  }
  ctx.filter = 'none';
  // Sparse pointed ink-dark fragments, embedded in the dust rather than long pen strokes.
  for (let i = 0; i < 48; i++) {
    const angle = random() * Math.PI * 2, radius = 94 + random() * 61;
    const length = 5 + random() * 13, width = .8 + random() * 3.2;
    ctx.save(); ctx.translate(Math.cos(angle) * radius, Math.sin(angle) * radius); ctx.rotate(angle + Math.PI / 2 + (random() - .5) * .25);
    ctx.beginPath(); ctx.moveTo(-length * .65, 0);
    ctx.quadraticCurveTo(-length * .2, -width * .15, -length * .1, -width);
    ctx.lineTo(length * .08, -width * .45); ctx.lineTo(length * .55, -.1);
    ctx.quadraticCurveTo(length * .12, width * .28, -length * .05, width * .9);
    ctx.lineTo(-length * .28, width * .18); ctx.closePath();
    ctx.fillStyle = `rgba(2,5,15,${.35 + random() * .45})`; ctx.fill(); ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 1500; i++) {
    const angle = random() * Math.PI * 2, r = 81 + random() * 91;
    const alpha = (.1 + random() * .55) * Math.pow(1 - (r - 81) / 103, 2);
    ctx.fillStyle = i % 17 === 0 ? `rgba(238,210,179,${alpha * 1.1})` : `rgba(207,209,237,${alpha})`;
    ctx.beginPath(); ctx.ellipse(Math.cos(angle) * r, Math.sin(angle) * r, .35 + random() * .85, .35 + random() * .85, 0, 0, Math.PI * 2); ctx.fill();
  }
  return canvas;
}

// All marks in a document share pigment work; each visible mark owns only its small canvas.
const dustTextures = new WeakMap<Document, { canvas: HTMLCanvasElement; users: number }>();
function acquireDust(document: Document) {
  const existing = dustTextures.get(document);
  if (existing) { existing.users++; return existing.canvas; }
  const canvas = makeDustTexture(document);
  if (canvas) dustTextures.set(document, { canvas, users: 1 });
  return canvas;
}
function releaseDust(document: Document) {
  const entry = dustTextures.get(document);
  if (entry && --entry.users === 0) { entry.canvas.width = entry.canvas.height = 0; dustTextures.delete(document); }
}
export function mountBlackHole(canvas: HTMLCanvasElement, initial: OrbState, detailScale = 1, animated = true) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const doc = canvas.ownerDocument, win = doc.defaultView;
  if (!win) return null;
  let texture = acquireDust(doc);
  if (!texture) return null;
  let state = initial, disposed = false, frame = 0, elapsed = 0, last = 0, lastPaint = 0, inView = true, contextLost = false;
  let pointerX = 0, pointerY = 0, targetX = 0, targetY = 0, presence = 0, hovered = false, focused = false;
  // Only a launcher is interactive; the same decorative renderer in a header is not.
  const launcher = canvas.closest<HTMLElement>('.canvas-agent-orb, .canvas-agent-turn');
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const dpr = Math.min(BLACK_HOLE.maxDpr, Math.max(1, win.devicePixelRatio || 1)) * Math.min(4, Math.max(1, detailScale));
  canvas.width = BLACK_HOLE.width * dpr; canvas.height = BLACK_HOLE.height * dpr;
  function paint() {
    if (!ctx || contextLost) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, BLACK_HOLE.width, BLACK_HOLE.height);
    ctx.translate(44 + pointerX * BLACK_HOLE.pointerTravel, 32 + pointerY * BLACK_HOLE.pointerTravel * .65);
    ctx.rotate(BLACK_HOLE.tilt + pointerX * BLACK_HOLE.pointerTilt);
    // Ambient light has transparent bounds and never paints a rectangular backdrop.
    ctx.save(); ctx.scale(1, .66);
    const halo = ctx.createRadialGradient(0, 0, 12, 0, 0, 43);
    halo.addColorStop(0, 'rgba(56,58,112,0)'); halo.addColorStop(.6, 'rgba(91,105,186,.17)'); halo.addColorStop(1, 'rgba(67,71,147,0)');
    ctx.fillStyle = halo; ctx.fillRect(-44, -44, 88, 88); ctx.restore();
    ctx.save(); ctx.scale(1, BLACK_HOLE.flatten + pointerY * .018);
    ctx.save(); ctx.rotate(elapsed * BLACK_HOLE.orbitSpeed); ctx.drawImage(texture!, -43, -43, 86, 86); ctx.restore();
    // Differential streams visibly travel through the dust instead of spinning a
    // nearly uniform texture. Short tapered trails remain within the cached annulus.
    // This is a fixed 36 arcs/frame, with no per-frame texture allocation.
    for (let i = 0; i < 12; i++) {
      const radius = 21.6 + (i % 5) * 2.3;
      const head = elapsed * (BLACK_HOLE.flowSpeed + (i % 4) * .075) + i * 2.39996;
      const warm = i % 4 === 0;
      for (let tail = 0; tail < 3; tail++) {
        const start = head - .12 * (tail + 1), end = head - .12 * tail;
        ctx.beginPath(); ctx.ellipse(0, 0, radius, radius, 0, start, end);
        ctx.strokeStyle = warm
          ? `rgba(242,218,196,${(.52 - tail * .13) * (1 + presence * .15)})`
          : `rgba(177,201,255,${(.56 - tail * .14) * (1 + presence * .15)})`;
        ctx.lineWidth = tail === 0 ? .62 : .42; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    // The near rim is lit independently of the orbiting dust: a dimensional, uneven lip.
    for (let i = 0; i < 12; i++) {
      const r = 20.5 + i * .55;
      ctx.beginPath();
      for (let j = 0; j <= 45; j++) {
        const a = .5 + i * .025 + j / 45 * (2.35 - i * .07);
        const rr = r + Math.sin(a * 7 + i * 2) * .18;
        if (!j) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.strokeStyle = `rgba(236,217,210,${.42 - i * .024})`; ctx.lineWidth = .24 + i * .012; ctx.stroke();
    }
    // Champagne glints keep the near edge legible against a dark canvas.
    for (const [start, end, radius] of [[1.85, 2.35, 23.1], [.98, 1.31, 25.4], [.42, .66, 22.5]]) {
      for (let i = 0; i < 4; i++) {
        ctx.beginPath(); ctx.ellipse(0, 0, radius + i * .3, radius + i * .3, 0, start + i * .025, end - i * .02);
        ctx.strokeStyle = `rgba(247,223,201,${.58 - i * .085})`; ctx.lineWidth = .36; ctx.stroke();
      }
    }
    // Fixed directional shading gives the turning disk a front lip and a recessed far side.
    const shadow = ctx.createLinearGradient(0, -30, 0, 28);
    shadow.addColorStop(0, 'rgba(2,4,13,.48)'); shadow.addColorStop(.52, 'rgba(5,6,15,0)'); shadow.addColorStop(1, 'rgba(174,167,201,.13)');
    ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = shadow; ctx.fillRect(-43, -43, 86, 86); ctx.globalCompositeOperation = 'source-over';
    const voidGradient = ctx.createRadialGradient(0, -1, 12, 0, 0, 20.2);
    voidGradient.addColorStop(0, '#020309'); voidGradient.addColorStop(.68, '#03040b'); voidGradient.addColorStop(.84, 'rgba(4,5,13,.98)'); voidGradient.addColorStop(1, 'rgba(4,5,13,0)');
    ctx.fillStyle = voidGradient; ctx.beginPath(); ctx.arc(0, 0, 20.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function stop() { if (frame) win!.cancelAnimationFrame(frame); frame = 0; last = 0; }
  function tick(now: number) {
    frame = 0;
    if (disposed || contextLost || doc.hidden || !inView || motion.matches || !animated) return;
    const delta = last ? Math.min(Math.max(now - last, 0), 100) / 1000 : 0;
    // Frame-rate-independent easing avoids a jump on entry, leave, or restored focus.
    const ease = 1 - Math.exp(-delta * 8);
    presence += ((hovered || focused ? 1 : 0) - presence) * ease;
    pointerX += (targetX - pointerX) * ease; pointerY += (targetY - pointerY) * ease;
    elapsed += delta * (state.busy ? 1.8 : 1) * (1 + presence * .45);
    last = now;
    if (now - lastPaint >= 1000 / BLACK_HOLE.fps) { paint(); lastPaint = now; }
    frame = win!.requestAnimationFrame(tick);
  }
  function sync() {
    stop(); if (disposed) return;
    if (motion.matches || doc.hidden || !inView) {
      pointerX = pointerY = targetX = targetY = presence = 0; hovered = focused = false;
    }
    paint();
    if (!contextLost && !doc.hidden && inView && !motion.matches && animated) frame = win!.requestAnimationFrame(tick);
  }
  function onPointer(event: PointerEvent) {
    if (disposed || motion.matches || doc.hidden || !inView || event.pointerType === 'touch' || !launcher) return;
    const bounds = launcher.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    hovered = true;
    targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
    targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
  }
  function onLeave() { hovered = false; targetX = targetY = 0; }
  function onFocus() { if (!motion.matches) focused = true; }
  function onBlur() { focused = false; onLeave(); }
  function onContextLost(event: Event) { event.preventDefault(); contextLost = true; canvas.dataset.ready = 'false'; stop(); }
  function onContextRestored() {
    if (disposed) return;
    // Recreate the paint resource only after an actual context loss.
    releaseDust(doc); texture = acquireDust(doc); contextLost = !texture;
    canvas.dataset.ready = texture ? 'true' : 'false'; sync();
  }
  canvas.addEventListener('contextlost', onContextLost); canvas.addEventListener('contextrestored', onContextRestored);
  launcher?.addEventListener('pointerenter', onPointer); launcher?.addEventListener('pointermove', onPointer);
  launcher?.addEventListener('pointerleave', onLeave); launcher?.addEventListener('pointercancel', onLeave);
  launcher?.addEventListener('focus', onFocus); launcher?.addEventListener('blur', onBlur);
  const observer = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; sync(); }) : null;
  observer?.observe(canvas);
  doc.addEventListener('visibilitychange', sync); motion.addEventListener('change', sync);
  sync();
  return {
    update(next: OrbState) { if (!disposed) state = next; },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); observer?.disconnect(); doc.removeEventListener('visibilitychange', sync); motion.removeEventListener('change', sync);
      canvas.removeEventListener('contextlost', onContextLost); canvas.removeEventListener('contextrestored', onContextRestored);
      launcher?.removeEventListener('pointerenter', onPointer); launcher?.removeEventListener('pointermove', onPointer);
      launcher?.removeEventListener('pointerleave', onLeave); launcher?.removeEventListener('pointercancel', onLeave);
      launcher?.removeEventListener('focus', onFocus); launcher?.removeEventListener('blur', onBlur);
      if (texture) { releaseDust(doc); texture = null; }
    },
  };
}
