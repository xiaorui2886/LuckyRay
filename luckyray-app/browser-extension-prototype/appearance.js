(function installAppearance(global) {
  "use strict";
  if (global.LuckyRayAppearance) return;
  const THEMES = new Set(["dark", "light", "ivory-editorial", "rose-tea", "github-dark", "white-zero", "bangladesh-green", "lilac-milk", "blue-whisper"]);
  const CACHE_KEY = "luckyrayAppearanceV1";
  const PORT_NAME = "luckyray-appearance-v1";
  function validate(value) {
    if (!value || !/^[a-f0-9]{32}$/.test(value.instanceId) || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    return { instanceId: value.instanceId, revision: value.revision,
      theme: THEMES.has(value.theme) ? value.theme : "dark",
      accent: /^#[a-f0-9]{6}$/i.test(value.accent) ? value.accent.toLowerCase() : "#7c8aff" };
  }
  function luminance(hex) {
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  function apply(target, value) {
    const valid = validate(value);
    if (!valid) return;
    target.setAttribute("data-lr-theme", valid.theme);
    target.style.setProperty("--lr-accent", valid.accent);
    target.style.setProperty("--lr-accent-hover", valid.accent);
    target.style.setProperty("--lr-accent-soft", `color-mix(in srgb, ${valid.accent} 16%, transparent)`);
    target.style.setProperty("--lr-accent-line", `color-mix(in srgb, ${valid.accent} 44%, transparent)`);
    // Text on a filled accent always chooses the better black/white contrast.
    target.style.setProperty("--lr-accent-ink", luminance(valid.accent) > .179 ? "#000000" : "#ffffff");
    if (typeof getComputedStyle === "function" && target.isConnected) {
      const style = getComputedStyle(target);
      const backgrounds = [];
      for (const token of ["--lr-bg", "--lr-surface", "--lr-surface-raised", "--lr-surface-sunken", "--lr-surface-hover", "--lr-glass"]) {
        const color = style.getPropertyValue(token).trim();
        if (/^#[a-f0-9]{6}$/i.test(color)) backgrounds.push(color);
        else {
          const parts = /^rgba?\(([^)]+)\)$/.exec(color)?.[1].split(',').map(Number);
          if (parts?.length >= 3 && parts.every(Number.isFinite)) {
            const alpha = parts[3] ?? 1;
            for (const under of [0, 255]) backgrounds.push('#' + parts.slice(0,3).map(c=>Math.round(c*alpha+under*(1-alpha)).toString(16).padStart(2,'0')).join(''));
          }
        }
      }
      target.style.setProperty("--lr-accent-text", accessibleAccent(valid.accent, backgrounds));
    }
  }
  function accessibleAccent(accent, backgrounds) {
    const passes = candidate => backgrounds.every(bg => {
      const a=luminance(candidate), b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
    });
    if (!backgrounds.length || passes(accent)) return accent;
    const rgb=accent.slice(1).match(/../g).map(v=>parseInt(v,16));
    for(let step=1;step<=100;step++) for(const end of [0,255]) {
      const candidate='#'+rgb.map(c=>Math.round(c+(end-c)*step/100).toString(16).padStart(2,'0')).join('');
      if(passes(candidate))return candidate;
    }
    return accent;
  }
  function cachedAppearance(raw) {
    const id = raw?.lastInstanceId;
    const value = validate(raw?.byInstance?.[id]);
    return value?.instanceId === id ? value : null;
  }
  function createBroker({ read, write, request, schedule = setTimeout, cancel = clearTimeout, interval = 1250 }) {
    const listeners = new Set();
    let current = null, cache = {}, timer = null, running = false, generation = 0, failures = 0;
    const ready = Promise.resolve().then(read).then(raw => {
      current = cachedAppearance(raw);
      cache = current ? { [current.instanceId]: current } : {};
      for (const listener of listeners) if (current) listener(current);
    }).catch(() => {});
    async function tick() {
      timer = null;
      if (running || !listeners.size) return;
      running = true;
      const owner = generation;
      try {
        await ready;
        const value = validate(await request());
        if (!value) throw new Error("invalid-appearance");
        if (owner !== generation || !listeners.size) return;
        failures = 0;
        if (JSON.stringify(current) !== JSON.stringify(value)) {
          current = value;
          cache = { ...cache, [value.instanceId]: value };
          const ids = Object.keys(cache).slice(-4);
          cache = Object.fromEntries(ids.map(id => [id, cache[id]]));
          for (const listener of listeners) listener(value);
          await write({ lastInstanceId: value.instanceId, byInstance: cache });
        }
      } catch (_) { failures = Math.min(failures + 1, 3); }
      finally {
        running = false;
        if (listeners.size) timer = schedule(tick, failures ? Math.min(10000, interval * 2 ** failures) : interval);
      }
    }
    return { subscribe(listener) {
      listeners.add(listener);
      if (current) listener(current);
      if (!running && timer === null) void tick();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { generation++; if (timer !== null) cancel(timer); timer = null; }
      };
    } };
  }

  // One port per document, shared by its visible surfaces. Hidden tabs and
  // closed overlays stop subscribing; only the service worker reads HTTP.
  let current = null, port = null, retry = null;
  const surfaces = new Set();
  const visible = target => target.isConnected && target.style.display !== "none" && !document.hidden;
  function refresh() {
    const active = [...surfaces].some(visible);
    if (!active) { if (retry) clearTimeout(retry); retry = null; if (port) { const old = port; port = null; old.disconnect(); } return; }
    if (port || retry || !global.chrome?.runtime?.connect) return;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener(value => {
        const valid = validate(value);
        if (!valid) return;
        current = valid;
        for (const target of surfaces) apply(target, valid);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = null;
        if ([...surfaces].some(visible)) retry = setTimeout(() => { retry = null; refresh(); }, 1500);
      });
    } catch (_) { retry = setTimeout(() => { retry = null; refresh(); }, 1500); }
  }
  function bindSurface(target) {
    surfaces.add(target);
    if (current) apply(target, current);
    else if (global.chrome?.storage?.local) {
      Promise.resolve(chrome.storage.local.get(CACHE_KEY)).then(data => {
        if (!current) current = cachedAppearance(data[CACHE_KEY]);
        if (current && surfaces.has(target)) apply(target, current);
      }).catch(() => {});
    }
    const observer = new MutationObserver(refresh);
    observer.observe(target, { attributes: true, attributeFilter: ["style"] });
    refresh();
    return () => { observer.disconnect(); surfaces.delete(target); refresh(); };
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", refresh);
    global.addEventListener("pagehide", () => { surfaces.clear(); refresh(); });
  }
  const api = { validate, apply, accessibleAccent, cachedAppearance, createBroker, bindSurface, refresh, CACHE_KEY, PORT_NAME };
  global.LuckyRayAppearance = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
