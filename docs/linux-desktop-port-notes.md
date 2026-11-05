# Linux desktop integration

The target is x86_64-unknown-linux-gnu on an Ubuntu 22.04 build baseline.
The source is an incomplete desktop candidate. A diagnostic executable can
exclude bundle inputs to investigate native code and UI behavior; it does not
establish resource identity, signed-runtime or package admission.

## Process lifecycle

Linux uses a separate process group created before exec. The executable is an
absolute, no-follow, single-link ELF opened through a held directory and executed
via its descriptor. Environment inheritance is cleared, and stdin/stdout/stderr
are explicit pipes.

The parent retains its unreaped group leader with waitid(WNOWAIT) while the
authority is live. This reserves the numeric leader/group identity. Normal
shutdown can signal the group and inspect its remaining non-zombie members;
loss of the child wait authority is treated as unknown and disables signaling
through that numeric ID. Closing the group authority attempts cleanup, and a
reaper thread handles the application's own leader.

A descendant may escape with setsid/setpgid. Abrupt desktop death can leave
tools running. A successful group-settlement sample covers that original
group, rather than all possible descendants. No user namespace, delegated
cgroup, service or additional privilege is required by this implementation.

## File commits and recovery

Linux path traversal opens every directory component without following links.
Regular files are opened nonblocking and without following the final name,
then checked for type, link count and filesystem object identity. Directory
identity is checked again at operation boundaries. These checks detect observed
changes; they cannot stop another process running as the same user from editing
or renaming objects between checks.

Writes compare the loaded object and content, create an independent durable
backup, draft and journal, move the old object to a separate recovery name,
and publish the new object with a no-replace rename. The moved and published
objects are checked again. Participating writers use a nonblocking advisory
directory lock. External edits and interrupted commits retain recovery files.

Startup recovery restores a validated prior object only into a vacant name.
An unrelated current file is retained and requires conflict review. Completed
writes retain backup copies and receipts. A draft retained after interrupted
recovery can be recovered manually. Automatic backup retention/cleanup and a
dedicated backup browser are not implemented. Note deletion retains an
independent copy and a deletion-attempt receipt.

Replacement preserves ordinary POSIX mode and group through opened descriptors.
Access ACLs, default directory ACLs, labels and extended file attributes are not
yet supported by the replacement path: it refuses them before changing the
target rather than dropping restrictions. Newly private profiles and credential
files also reject extended attributes. Existing inode paths are retained, so
an external editor's delayed writes remain recoverable in the displaced file.
Recovery restores that original inode; a missing original requires review of
the retained copy rather than guessing its original permissions.

Copying a file into a Vault (`attachments/`) and the companion's staged
attachment publish use the same name, size and reuse policy as Windows. On
Linux the Vault root is held as an owned directory under the write lease,
`attachments/` is created (mode 0700) or opened through that descriptor
without following a link, and the bytes are staged in a private 0600
`.lrk-attachment-*.tmp` file, verified, and published with a no-replace
rename. An occupied name, including a symbolic link, is never overwritten.
As on Windows, a failed stage is removed, but only while its name still
denotes the file this operation created (device and inode, without following
a link); anything else is left as a hidden `.lrk-` file, which the attachment
list ignores.

Deleting a material file keeps the Windows sequence: move the file to a
hidden quarantine name in the same folder, commit the catalog change, then
delete permanently. Linux does not use the desktop trash. Before the move,
the file is opened without following a link and must be a regular file with
one link. As on Windows, changed content does not block the quarantine
move; restore and permanent deletion compare the catalog hash and keep a
mismatching file pending. The move is a no-replace
rename. The quarantined object's device and inode are recorded in
`material-delete-identity/` next to the portable recovery manifest. Permanent
deletion requires that record and the quarantined name to still denote the
same object; otherwise the file is kept and cleanup stays pending (reported
by the existing delete result and pending-deletion retry count). Restoring
a quarantined file refuses an occupied original name. Tombstones from removed
attachments are not cleaned up automatically.

## Credentials

Linux credentials use the same serialized authority and origin allowlist as
the other desktop backends. Their app-owned profile must belong to the current
user and have private directory permissions; credential files must be
single-link, user-owned regular files without group/other access. Existing
unsafe permissions or links are rejected without changing them.

Reads and writes use held directory descriptors. Persistence compares the
version loaded by that authority instance and retains recovery evidence.
Credential derivation rechecks the loaded credential/grant records, so an
instance with an observed stale rotation or grant change refuses authentication
until it reloads. A native host's read does not create a missing profile or
credential. Generic arbitrary-path manifest writing remains rejected on Linux;
the scoped installer uses its separate no-replace registration path. Existing
managed registrations can be revoked and re-enabled through transactions that
retain independent backups and displaced inodes. Autostart uses the same
checked record layer and an explicit `Hidden=true` disabled state. See
[per-user integration](linux-user-integration.md) for CLI usage and recovery
boundaries.

## Runtime and graphical coverage

Linux runtime file leases retain descriptors, metadata and content digests and
revalidate them at use boundaries. They detect changes and do not provide
Windows mandatory exclusion for the whole use window.

The Linux x86-64/glibc LSH closure and authenticated native host now have their
own compiled records and preparation path. They use the real Node 22.19.0 and
`@deepseek-ai/dsh@0.2.1-rc.3`; Windows records cannot authorize Linux execution.
See [Linux LSH runtime](linux-lsh-runtime.md) for exact inputs, offline assembly,
use-boundary checks and the remaining redistribution materials.

The GTK child uses a native overlay because the generic GTK Box path packs
webviews vertically and ignores positioned child bounds. Main stays full-size;
LSH placement, visibility and retirement remain within the existing lifecycle.
Request-mediated personal-browser hosting, required media runtimes, real-browser
Native Messaging testing and installers remain separate implementation work.

The Linux directory-opening command uses the desktop's GIO handler. Its
synthetic handler test validates the production GIO call, while the native
smoke script drives the real Tauri executable with WebKitWebDriver under Xvfb.
That script uses a fresh profile, synthetic notes and a PNG, and checks IPC
flows, catalog persistence, process disappearance after a quit request and
reopening. It does not collect the application's exit status or decode the
imported image. Neither a synthetic handler nor an IPC smoke establishes every
visible UI interaction, Wayland, hardware media or installer behavior.

## Material move across filesystems

Windows v1.9.9 copies a material when `SetFileInformationByHandle` reports
`ERROR_NOT_SAME_DEVICE`. Linux now does the same: the held source is copied
into a `.lrk-move-<pid>-<nanos>.tmp` name in the destination directory, the
copy is flushed and verified against the caller's SHA-256 and length, published
with `renameat2(RENAME_NOREPLACE)`, and only then is the source unlinked after
its `{dev,ino,size,mtime}` stamp is re-checked. A failure before the publish
removes only the temporary and leaves the source alone; a failed source removal
reports `attachment-move-source-kept` while the verified destination stays.
The rename path is unchanged for same-filesystem moves. The temporary family is
counted by the smoke's residue scan (`moveLeftovers`).

## Shared source coordination

Windows branches remain platform-gated. Shared source bytes still affect
compiled contract/adapter fingerprints, including lib.rs and tool_cli.rs.
Integrating a platform change requires rebuilding the corresponding sidecars
and reviewing their identities. The Linux branch does not update another
platform's checkout, formal publisher, version or installer.

## Canvas and workspace write-through

Windows commits canvas documents and workspace files through a write-through
replace (`MoveFileExW(MOVEFILE_WRITE_THROUGH)` / a `FILE_FLAG_WRITE_THROUGH`
commit handle), so a completed replacement is durable. The Linux branches now
match that semantics: the staged file is `sync_all`-ed, the replacement is an
atomic rename (or a no-clobber `hard_link` for the workspace), and the parent
directory entry is fsynced through `linux_fs::sync_directory` before the write
reports success. A missing directory fsync reports the operation as failed, and
the caller's temporary cleanup applies as before; the canvas agent and the
workspace module never unlink a published name. The canvas document writer is
compiled into the offline filesystem crate, which covers replace, read-back,
temporary cleanup and the refused-replace cases; the workspace sites are
verified by CI compilation and the shared helper.

## Companion Gateway on Linux (first slice)

The Companion Gateway's Windows foundation uses DPAPI for the desktop identity
and `GetAdaptersAddresses` for the private LAN list. On Linux the identity is one
fixed entry in the freedesktop Secret Service, reached through `keyring` 3.6.3
with its pure-Rust backend (`async-secret-service`, `tokio`, `crypto-rust`: no
libdbus C library, no system package). The stored value is the same identity
document Windows protects, base64 encoded, and no plaintext or weakly protected
identity file is ever written. A missing or unreachable store refuses with
`companion-keyring-unavailable` / 「未找到系统钥匙环，未做任何修改」; a locked
store (or a dismissed unlock prompt) refuses with `companion-keyring-locked` /
「系统钥匙环已锁定，未做任何修改」; a missing credential takes the ordinary
"identity missing" path and an undecodable one the existing
`companion-secret-recovery-required` path. The LAN list is read through
`getifaddrs` (the existing `libc` dependency) with the same private-LAN
filtering as Windows. The community MCP plugin runner stays Windows-only
(`plugin-platform-unsupported`) until its packaged plugin exists.

## 10. T55 slice 3: Linux Agent Browser through the real host

The read-only Agent Browser now uses `luckyray-browser-host --agent-readonly`
on Linux. The sidecar verifies the pinned Chrome for Testing headless shell,
then starts and owns it on the dedicated `luckyray-agent-browser-engine`
thread. That thread remains alive for the session, so the engine's
`PR_SET_PDEATHSIG` remains attached to its spawning thread. Status, navigation,
read and extract are generation-bound; a dead engine pipe or keeper thread
fails closed. The Agent Browser's two Linux runtime availability gates are
removed without changing the Personal Browser's unsupported response or any
Windows branch.

Session profiles are created as `0700`; the effective-UID-owned real
`LuckyRay/AgentBrowser/v1` directory chain is closed to group and other users
before use. Only fixture/test builds accept the absolute
`LUCKYRAY_AGENT_BROWSER_TEST_SHELL` override. Production resolves the shell
at `<prefix>/lib/LuckyRay/agent-browser/chrome-headless-shell-linux64/chrome-headless-shell`
(the prefix above the host's `bin`, changed in slice 4) and checks it against
`tools/linux-agent-browser/pin.json`; it never searches `PATH`. Packaging is
section 11.

Verification uses synthetic loopback pages only, through the real gateway,
sidecar, pinned shell and `dsh_resource_broker` `luckyray_browser_open` /
`read` / `extract` path. The scratch harness completed 11 tests, including
generation cleanup, sidecar rejection, rendered read/extract and SIGKILL of the
sidecar with disappearance of the whole Chrome process group followed by a
failed read. Its app-service shims and omitted unrelated DSH operation bodies
are harness-only, not product fallbacks. The preflight workflow builds the
real sidecar, runs exactly four named runtime/DSH tests and fails unless the
summary is exactly four passed; missing or renamed tests therefore fail the
step. Both `linux-notes-ci.test.py` (118 tests) and
`linux-runtime-ci.test.py` (4 tests) pass locally.

The local app crate cannot be compiled on this box because `glib-sys` is not
installed, so end-to-end execution used the scratch harness around the real
product sources. Engine tests live in the app library rather than the sidecar
binary's own test harness because they depend on the library gateway. The
pre-existing profile-directory residue after a spawn failure is not broadened
or claimed fixed here. Startup recovery, `browser_broker`, LSH/DSH behavior
outside the existing browser-operation path, releases, installers, feeds and
keys are unchanged.

## 11. T55 slice 4: packaging the Agent Browser engine

The deb and AppImage carry the pinned `chrome-headless-shell` 157.0.8103.38 as
the Tauri resource `agent-browser/`, installed at
`/usr/lib/LuckyRay/agent-browser/` (AppImage: `$APPDIR/usr/lib/LuckyRay/...`).
Before a Linux bundle, stage it from the verified archive:

    python3 luckyray-app/tools/linux-agent-browser/shell.py stage <archive> luckyray-app/src-tauri/agent-browser

`stage` checks the archive size and sha256, unpacks with zip-slip and symlink
guards, re-checks the executable sha256 and licence files, then requires the
whole-bundle digest (`bundleSha256`, sorted `<sha256>  <mode>  <path>` lines
over all 287 regular files) and file count from `pin.json`. The staged
directory is gitignored. `scripts/linux/check-agent-browser-bundle.mjs`
recomputes the same digest and refuses a missing, mismatched, extended,
symlinked or unlicensed bundle, a missing or loosened AppArmor profile, or a
host engine path that differs. `prepare-tauri-build.mjs` runs it first and
still exits 1 on the remaining unresolved inputs, so no Linux bundle is
produced yet.

Licence notices: `LICENSE.headless_shell` (Chromium and its third-party
licences) and `ABOUT` ship unmodified beside the engine and are required by
both checks. The shared `third-party-notices/` supplement is a Windows release
input and is not changed.

Sandbox: the engine always runs with its renderer sandbox and never with
`--no-sandbox`. Ubuntu 23.10+ (`kernel.apparmor_restrict_unprivileged_userns=1`)
blocks the user namespace it needs. The deb ships
`src-tauri/linux/apparmor/luckyray-agent-browser` (`flags=(unconfined)` plus
`userns,` for exactly the root-owned installed engine path) to
`/usr/share/luckyray/apparmor/`; postinst installs and loads it only where
`/etc/apparmor.d/abi/4.0` exists, postrm unloads and removes it. No SUID
helper, no profile on a user-writable path, no sysctl change. The AppImage
gets no profile: if the engine dies at start while the sysctl is `1` the host
reports `agent-browser-sandbox-unavailable` (phase
`sandbox-userns-restricted`) and the runtime surfaces exactly that code; every
other launch failure stays `agent-browser-unavailable`.

Not verified here: loading the profile on a real Ubuntu 24.04 host and an
installed deb/AppImage end to end (no AppArmor userns kernel or apt on the
build box). CI checks the profile text, the deb wiring and the bundle gate.
