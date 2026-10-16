(function (global) {
  "use strict";
  const key = "luckyrayVideoOverlayEnabledV1";
  const enabled = value => value !== false;
  async function read() { return enabled((await chrome.storage.local.get(key))[key]); }
  async function set(value) { await chrome.storage.local.set({ [key]: value === true }); return value === true; }
  let toggling = Promise.resolve();
  function toggle() {
    const operation = toggling.then(async () => set(!await read()));
    toggling = operation.catch(() => {});
    return operation;
  }
  function subscribe(listener, onError = () => {}) {
    let disposed = false, revision = 0;
    const changed = (changes, area) => {
      if (disposed || area !== "local" || !Object.hasOwn(changes, key)) return;
      revision += 1; listener(enabled(changes[key].newValue));
    };
    chrome.storage.onChanged.addListener(changed);
    const initial = revision;
    read().then(value => { if (!disposed && initial === revision) listener(value); }, onError);
    return () => { disposed = true; chrome.storage.onChanged.removeListener(changed); };
  }
  const api = { key, read, set, toggle, subscribe };
  global.LuckyRayVideoOverlayPreference = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
