import { test } from "node:test";
import assert from "node:assert/strict";
import { placeNoteMediaActions, attachNoteMediaActions } from "../src/features/notes/media/noteMediaActions.ts";

test("intrinsic small images keep every toolbar action in the clipping pane", () => {
  const scenarios = [
    { media: { left: 40, top: 28, right: 72, bottom: 52 }, bar: { width: 67, height: 36 }, clip: { left: 0, top: 0, right: 320, bottom: 180 } },
    { media: { left: 0, top: 0, right: 32, bottom: 24 }, bar: { width: 129, height: 36 }, clip: { left: 0, top: 0, right: 200, bottom: 180 } },
    { media: { left: 288, top: 156, right: 320, bottom: 180 }, bar: { width: 67, height: 36 }, clip: { left: 0, top: 0, right: 320, bottom: 180 } },
    { media: { left: 100, top: 50, right: 132, bottom: 74 }, bar: { width: 129, height: 36 }, clip: { left: 100, top: 30, right: 300, bottom: 180 } },
  ];
  for (const { media, bar, clip } of scenarios) {
    const value = placeNoteMediaActions(media, bar, clip);
    const left = media.left + value.left, top = media.top + value.top;
    assert.ok(left >= clip.left && left + bar.width <= clip.right);
    assert.ok(top >= clip.top && top + bar.height <= clip.bottom);
    assert.equal(media.right - media.left, 32, "the media itself was not enlarged");
  }
  const media = { left: 40, top: 50, right: 680, bottom: 410 };
  const bar = { width: 67, height: 36 };
  const position = placeNoteMediaActions(media, bar, { left: 0, top: 0, right: 800, bottom: 600 });
  assert.equal(media.right - (media.left + position.left + bar.width), 8);
  assert.equal(position.top, 8);
  const pixel = { left: 100, top: 100, right: 101, bottom: 101 };
  const small = placeNoteMediaActions(pixel, bar, { left: 0, top: 0, right: 320, bottom: 200 });
  assert.ok(pixel.left + small.left + bar.width > pixel.left && pixel.top + small.top < pixel.bottom,
    "even a one-pixel image and the toolbar overlap so hover has no gap");
});

test("toolbar geometry binding observes clipping ancestors and disposes pending work once", () => {
  const callbacks = new Map(), events = new Map(), properties = new Map([["right", "8px"]]);
  let next = 0, disconnected = 0;
  const key = value => value.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
  const style = new Proxy({
    getPropertyValue: name => properties.get(name) || "",
    getPropertyPriority: () => "",
    setProperty: (name, value) => properties.set(name, value),
    removeProperty: name => properties.delete(name),
  }, { get: (target, name) => name in target ? target[name] : properties.get(key(name)) || "",
       set: (_, name, value) => { properties.set(key(name), value); return true; } });
  const listen = prefix => ({ addEventListener: (name, fn) => events.set(prefix + name, fn), removeEventListener: name => events.delete(prefix + name) });
  const window = { innerWidth: 320, innerHeight: 180, ...listen("window:"),
    requestAnimationFrame: fn => { callbacks.set(++next, fn); return next; }, cancelAnimationFrame: id => callbacks.delete(id),
    getComputedStyle: () => ({ overflowX: "hidden", overflowY: "hidden" }) };
  const parent = { offsetWidth: 200, offsetHeight: 180, clientWidth: 200, clientHeight: 180, clientLeft: 0, clientTop: 0, parentElement: null, matches: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 180, width: 200, height: 180 }) };
  const owner = { defaultView: window, documentElement: { clientWidth: 320, clientHeight: 180 }, ...listen("document:") };
  const root = { ownerDocument: owner, parentElement: parent, isConnected: true, offsetWidth: 32, offsetHeight: 24, matches: () => true, ...listen("root:"),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 32, bottom: 24, width: 32, height: 24 }) };
  const actions = { isConnected: true, style, getBoundingClientRect: () => ({ width: 129, height: 36 }) };
  const observed = new Set();
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe(value) { observed.add(value); } disconnect() { disconnected++; } };
  try {
    const dispose = attachNoteMediaActions(root, actions);
    const initial = [...callbacks.values()]; callbacks.clear(); initial.forEach(fn => fn());
    assert.ok(observed.has(parent));
    assert.equal(style.left, "0px");
    assert.equal(style.right, "auto");
    assert.equal(style.maxWidth, "200px");
    parent.matches = () => true;
    window.getComputedStyle = () => ({ overflowX: "visible", overflowY: "visible", paddingLeft: "40px", paddingRight: "40px" });
    root.getBoundingClientRect = () => ({ left: 40, top: 0, right: 72, bottom: 24, width: 32, height: 24 });
    actions.getBoundingClientRect = () => ({ width: 67, height: 36 });
    events.get("root:pointerenter")();
    assert.equal(style.left, "0px", "controls stay in the reading/text column instead of a gutter or padding");
    assert.equal(style.maxWidth, "120px");
    events.get("document:scroll")();
    assert.equal(callbacks.size, 1);
    dispose(); dispose();
    assert.equal(callbacks.size, 0);
    assert.equal(events.size, 0);
    assert.equal(disconnected, 1);
    assert.deepEqual([...properties], [["right", "8px"]]);
  } finally { globalThis.ResizeObserver = previous; }
});
