import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountBlackHole, BLACK_HOLE } from '../src/features/canvas/canvasBlackHoleRenderer.ts';

function harness({ reduced = false, visible = true, context = true, interactive = true, detailScale = 1, animated = true } = {}) {
  const callbacks = new Map(), listeners = new Map(), motionListeners = new Map(), canvasListeners = new Map(), pointerListeners = new Map();
  const frames = [];
  let serial = 0, disconnected = false, intersection, textureAllocations = 0;
  function makeContext(record) {
    const properties = {};
    return new Proxy({}, { get: (_target, name) => {
      if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (name === 'clearRect') return () => { if (record) frames.push([]); };
      return (...args) => { if (record && frames.length) frames.at(-1).push({ name, args, strokeStyle: properties.strokeStyle }); };
    }, set: (_target, name, value) => { properties[name] = value; return true; } });
  }
  const ctx = makeContext(true), textureCtx = makeContext(false);
  const launcher = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 64, height: 64 }),
    addEventListener: (n, f) => pointerListeners.set(n, f), removeEventListener: n => pointerListeners.delete(n) };
  const motion = { matches: reduced, addEventListener: (n, f) => motionListeners.set(n, f), removeEventListener: n => motionListeners.delete(n) };
  const win = { devicePixelRatio: 4, matchMedia: () => motion,
    requestAnimationFrame: f => { callbacks.set(++serial, f); return serial; }, cancelAnimationFrame: id => callbacks.delete(id),
    IntersectionObserver: class { constructor(f) { intersection = f; } observe() {} disconnect() { disconnected = true; } },
  };
  const doc = { defaultView: win, hidden: !visible,
    createElement: () => { textureAllocations++; return { width: 0, height: 0, getContext: () => textureCtx }; },
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
  const canvas = { dataset: {}, addEventListener: (n, f) => canvasListeners.set(n, f), removeEventListener: n => canvasListeners.delete(n),
    closest: () => interactive ? launcher : null, ownerDocument: doc, width: 0, height: 0, getContext: () => context ? ctx : null };
  const renderer = mountBlackHole(canvas, { busy: false, unavailable: false }, detailScale, animated);
  return { renderer, canvas, callbacks, listeners, motionListeners, canvasListeners, pointerListeners, frames,
    get paints() { return frames.length; }, get disconnected() { return disconnected; }, get textureAllocations() { return textureAllocations; },
    tick(now) { const pair = [...callbacks][0]; if (pair) { callbacks.delete(pair[0]); pair[1](now); } },
    advance(from, to) { for (let now = from; now <= to; now += 50) this.tick(now); },
    pointer(type, x = 132, y = 232, pointerType = 'mouse') { pointerListeners.get(type)?.({ clientX: x, clientY: y, pointerType }); },
    hide(value) { doc.hidden = value; listeners.get('visibilitychange')?.(); },
    reduced(value) { motion.matches = value; motionListeners.get('change')?.(); },
    intersect(value) { intersection([{ isIntersecting: value }]); },
  };
}
const commands = (h, name) => h.frames.at(-1).filter(command => command.name === name);
const position = h => commands(h, 'translate')[0].args;
const orbit = h => commands(h, 'rotate')[1].args[0];

test('flatter opposite tilt and DPR cap preserve tiny transparent bounds', () => {
  assert.equal(BLACK_HOLE.tilt, -Math.PI / 12); assert.equal(BLACK_HOLE.flatten, .49);
  const h = harness(); assert.equal(h.canvas.width, 176); assert.equal(h.canvas.height, 128); assert.equal(h.paints, 1); assert.equal(h.callbacks.size, 1); h.renderer.dispose();
  const detailed = harness({ detailScale: 99 }); assert.equal(detailed.canvas.width, 704); assert.equal(detailed.canvas.height, 512); detailed.renderer.dispose();
});
test('30fps paints; busy update keeps exactly one loop', () => {
  const h = harness(); h.tick(40); const start = h.paints; h.tick(50); assert.equal(h.paints, start); h.tick(80); assert.equal(h.paints, start + 1);
  h.renderer.update({ busy: true, unavailable: false }); assert.equal(h.callbacks.size, 1); h.renderer.dispose();
});
test('dust and tapered accretion streams travel at different visible speeds without new textures', () => {
  const h = harness(); const initialOrbit = orbit(h), initialHead = commands(h, 'ellipse')[0].args[5];
  h.advance(100, 1100);
  assert.ok(orbit(h) - initialOrbit >= .13, 'ambient dust must not revert to the imperceptible four-minute orbit');
  assert.ok(commands(h, 'ellipse')[0].args[5] - initialHead >= .57, 'edge streams move visibly within one second');
  assert.equal(commands(h, 'ellipse').length, 48, 'bounded 36 moving arcs plus 12 near-edge glints');
  assert.equal(h.textureAllocations, 1, 'cached dust is not rebuilt on each frame');
  assert.ok(commands(h, 'stroke').some(c => c.strokeStyle.startsWith('rgba(247,223,201,')), 'near lip retains a clear warm highlight');
  h.renderer.dispose();
});
test('pointer response eases, clamps travel and tilt, then recenters on leave and cancel', () => {
  const h = harness(); h.tick(100); h.pointer('pointerenter', 10000, -10000); h.tick(150);
  const first = position(h);
  assert.ok(first[0] > 44 && first[0] < 44 + BLACK_HOLE.pointerTravel, 'entry is eased, not snapped');
  h.advance(200, 800);
  assert.ok(position(h)[0] <= 44 + BLACK_HOLE.pointerTravel);
  assert.ok(position(h)[1] >= 32 - BLACK_HOLE.pointerTravel * .65);
  assert.ok(Math.abs(commands(h, 'rotate')[0].args[0] - BLACK_HOLE.tilt) <= BLACK_HOLE.pointerTilt);
  h.pointer('pointerleave'); h.advance(850, 1850);
  assert.ok(Math.abs(position(h)[0] - 44) < .001); assert.ok(Math.abs(position(h)[1] - 32) < .001);
  h.pointer('pointermove', 164, 264); h.advance(1900, 2200); h.pointer('pointercancel'); h.advance(2250, 3250);
  assert.ok(Math.abs(position(h)[0] - 44) < .001);
  assert.equal(h.callbacks.size, 1); h.renderer.dispose();
});
test('hover and keyboard focus increase flow; touch does not leave a sticky hover', () => {
  const idle = harness(), hovered = harness(), focused = harness(), touched = harness();
  hovered.pointer('pointerenter'); focused.pointer('focus'); touched.pointer('pointerenter', 164, 264, 'touch');
  for (const h of [idle, hovered, focused, touched]) h.advance(100, 1100);
  assert.ok(orbit(hovered) > orbit(idle) * 1.3); assert.ok(orbit(focused) > orbit(idle) * 1.3);
  assert.equal(orbit(touched), orbit(idle)); assert.deepEqual(position(touched), [44, 32]);
  for (const h of [idle, hovered, focused, touched]) h.renderer.dispose();
});
test('decorative header has no pointer listeners or interactive displacement', () => {
  const h = harness({ interactive: false }); h.pointer('pointerenter', 164, 264); h.advance(100, 500);
  assert.equal(h.pointerListeners.size, 0); assert.deepEqual(position(h), [44, 32]); h.renderer.dispose();
});
test('hidden and offscreen pause, visible resumes one loop without catch-up motion', () => {
  const h = harness(); h.advance(100, 500); const before = orbit(h);
  h.hide(true); assert.equal(h.callbacks.size, 0); h.tick(50000); h.hide(false); assert.equal(h.callbacks.size, 1);
  h.tick(50100); assert.equal(orbit(h), before, 'background time does not fast-forward the orbit');
  h.intersect(false); assert.equal(h.callbacks.size, 0); h.intersect(true); assert.equal(h.callbacks.size, 1); h.intersect(true); assert.equal(h.callbacks.size, 1); h.renderer.dispose();
});
test('reduced motion remains still even with pointer or focus, and resets an active tilt', () => {
  const h = harness({ reduced: true }); assert.equal(h.paints, 1); assert.equal(h.callbacks.size, 0);
  h.pointer('pointerenter', 164, 264); h.pointer('focus'); h.advance(100, 1000);
  assert.equal(h.paints, 1); assert.deepEqual(position(h), [44, 32]);
  h.reduced(false); assert.equal(h.callbacks.size, 1); h.pointer('pointerenter', 164, 264); h.advance(100, 400); assert.ok(position(h)[0] > 44);
  h.reduced(true); assert.equal(h.callbacks.size, 0); assert.deepEqual(position(h), [44, 32]);
  assert.equal(commands(h, 'rotate')[0].args[0], BLACK_HOLE.tilt); h.renderer.dispose();
});
test('unmount removes frames, observer, all input listeners; repeated disposal and remount work', () => {
  const h = harness(); assert.equal(h.pointerListeners.size, 6); h.renderer.dispose();
  assert.equal(h.callbacks.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.motionListeners.size, 0); assert.equal(h.pointerListeners.size, 0); assert.equal(h.disconnected, true);
  h.renderer.dispose(); h.renderer.update({ busy: true, unavailable: false }); assert.equal(h.callbacks.size, 0);
  const fresh = harness(); assert.equal(fresh.callbacks.size, 1); fresh.renderer.dispose();
});
test('missing 2D context cleanly returns fallback', () => { assert.equal(harness({ context: false }).renderer, null); });
test('context loss reveals fallback and restoration restarts one loop', () => {
  const h = harness(); let prevented = false; h.canvasListeners.get('contextlost')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.callbacks.size, 0); assert.equal(h.canvas.dataset.ready, 'false');
  h.canvasListeners.get('contextrestored')(); assert.equal(h.canvas.dataset.ready, 'true'); assert.equal(h.callbacks.size, 1);
  assert.equal(h.textureAllocations, 2); h.renderer.dispose(); assert.equal(h.canvasListeners.size, 0);
});
test('launcher uses disk extents plus measured Main halo calibration, not the square button', () => {
  const css = readFileSync(new URL('../src/features/canvas/canvasAgentOrb.css', import.meta.url), 'utf8');
  assert.match(css, /right:calc\(var\(--orb-edge-gap\) \+ 9.9px\)/);
  assert.match(css, /bottom:calc\(var\(--orb-edge-gap\) - 3.7px\)/);
  assert.match(css,/NOT an exact alpha-paint bound/);
  const radius = 43, b = radius * .66, tilt = BLACK_HOLE.tilt;
  const x = Math.hypot(radius*Math.cos(tilt),b*Math.sin(tilt));
  const y = Math.hypot(radius*Math.sin(tilt),b*Math.cos(tilt));
  for (const gap of [22,32,42]) assert.ok(Math.abs((gap+9.9+32-x)-(gap-3.7+32-y)) < 1.5, 'perceived halo extents remain close across responsive gaps');
  assert.match(css,/right=50px\/bottom=45px; raise it 5px/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)[\s\S]*?transform:none/);
});

test('settled transcript avatars paint once without scheduling historical animation loops',()=>{
 const h=harness({animated:false});assert.equal(h.paints,1);assert.equal(h.callbacks.size,0);h.advance(100,3000);assert.equal(h.paints,1);h.hide(true);h.hide(false);assert.equal(h.callbacks.size,0);h.renderer.dispose();
});

test('R7 multiple avatars share one dust texture and releasing one cannot erase another',()=>{
 const h=harness();
 const canvas={...h.canvas,dataset:{},addEventListener(){},removeEventListener(){},closest(){return null;}};
 const second=mountBlackHole(canvas,{busy:false,unavailable:false},1,false);
 assert.equal(h.textureAllocations,1,'cached pigment is shared within one document');
 h.renderer.dispose();second.update({busy:true,unavailable:false});
 assert.equal(h.textureAllocations,1);
 second.dispose();second.dispose();
 const third=mountBlackHole(canvas,{busy:false,unavailable:false},1,false);
 assert.equal(h.textureAllocations,2,'last owner releases the cache; a later mount creates one new texture');
 third.dispose();
});
