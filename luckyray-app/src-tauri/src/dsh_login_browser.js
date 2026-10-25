// DSH 0.2.1-rc.2 BrowserLogin preopens about:blank, then calls
// popup.location.replace(authorizeUrl). A denied native popup returns null,
// so a new-window URL handler alone never receives the authorization URL.
// This shim is installed only on LuckyRay's DSH child. Rust is the final
// allowlist and cancels external navigation after opening the system browser.
(() => {
  const originalOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    if (url !== 'about:blank' || target !== '_blank' || features !== undefined) {
      return originalOpen(url, target, features);
    }
    let closed = false;
    let navigated = false;
    return {
      opener: null,
      get closed() { return closed; },
      close() { closed = true; },
      location: {
        replace(value) {
          if (closed || navigated) return;
          const destination = new URL(value);
          if (destination.origin !== 'https://platform.deepseek.com'
              || destination.pathname !== '/dsh/authorize'
              || destination.username || destination.password || destination.hash) {
            throw new Error('dsh-login-browser-url-rejected');
          }
          navigated = true;
          window.location.assign(destination.href);
        },
      },
    };
  };
})();
