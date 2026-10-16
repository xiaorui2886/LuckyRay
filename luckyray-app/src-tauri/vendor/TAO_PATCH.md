# Tao 0.35.3 local Windows keyboard fix

Source: crates.io `tao` 0.35.3, copied unchanged except the two Windows
keyboard files. Upstream MIT/Apache-2.0 license files are retained.

Main's non-invasive live stack on 2026-10-04 showed the UI thread holding
`KEY_EVENT_BUILDERS` in `process_message`, calling `PeekMessageW`, receiving a
synchronous Win32 callback, and trying to acquire the same mutex again.
The key-down/up branches also held `LAYOUT_CACHE` while peeking.

Snapshot the next keyboard message in the window callback **before** acquiring
either lock. Pass that snapshot to the existing key-event state machine. Keep
the same HWND/filter/PM_NOREMOVE and all normal focus, AltGr, UTF-16, and IME
paths; do not drop a nested event or use a recursive mutable borrow.

This is a local narrowly scoped fix, not an upstream release or a claim that
all Windows focus/IME sequences have been validated.

Regression evidence (2026-10-04): the same isolated hidden-window probe uses a
thread-local WH_CALLWNDPROC hook and a worker's synchronous WM_KILLFOCUS during
WM_KEYDOWN. Original 0.35.3 deadlocks and reaches its 12-second test timeout;
patched 0.35.3 completes 20 iterations. Only the probe's own HWND receives input.
The source patch keeps the original Tao license and copyright. Build and
behavioral checks do not establish all real input-method sequences; actual
Windows focus/IME acceptance remains a separate check.
