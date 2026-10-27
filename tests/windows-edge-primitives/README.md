# Synthetic Windows / Edge platform primitives

This is newly authored generic QA, not LuckyRay product acceptance. It imports no
LuckyRay helper, account manager, frontend, Rust source, or private artifacts.

Run on a disposable Windows runner with installed Microsoft Edge:

```powershell
npm install --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact playwright-core@1.56.1
node --check edge-primitives.test.mjs
node --test edge-primitives.test.mjs
```

It verifies two owned browser profiles, cookie/localStorage isolation and restart
persistence, independent-page concurrency, a generic per-key serialization fixture,
and explicit headed-window creation/close followed by background reopening. The
serialization fixture does not verify any product scheduler. A headed browser
window is verified through CDP, not human visibility or foreground focus policy.

All app-page navigation is to the test's 127.0.0.1 HTTP server. Browser routing
blocks other page requests, with additional background-networking and DNS flags.
No provider login, account creation, generation, billing, credentials, or imported
sessions are involved. Dependency installation uses the public npm registry;
Microsoft Edge is the runner-installed version, recorded in the result rather
than silently presented as a pinned browser build.

Only a bounded JSON summary and Node test output are logged. No screenshots,
profiles, source archives, raw browser logs, or artifacts are uploaded. Created
profiles are removed in finally; an exceptional forced job termination is handled
by disposal of the hosted runner, not by uploading diagnostic data.

A pass cannot establish current private helper stdio behavior, production account
isolation, application background/foreground policy, or Windows native compilation.
Those require separate candidate-specific verification.
