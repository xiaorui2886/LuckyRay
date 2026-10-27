# Bounded native confirmation check

This nonshipping test window renders the production `DshEngineUpdateCard` and
the real `@tauri-apps/plugin-dialog` on Windows. Only update status and restart
are synthetic. The restart handler increments a visible counter, never starts
an installer or touches LuckyRay data. It has a separate test application ID.

1. From this directory, run `node build-ui.mjs` and `cargo build --offline`.
2. Open `luckyray-dsh-restart-confirm-check.exe` through the supported Windows UI
   channel. Observe Cancel and closing the dialog leave the counter at zero.
3. Reopen the dialog, explicitly confirm, and observe exactly one counter call.

This proves native confirmation behavior, not an installed engine upgrade or
restart. Those results retain their separately recorded cloud evidence scope.
DOM tests also cover deferred replies, duplicate clicks and rejection/errors.
