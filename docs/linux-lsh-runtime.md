# Linux LSH runtime

The Linux x86-64/glibc runtime has a separate Node/npm closure. Windows
runtime records and Windows engine-update envelopes do not authorize Linux
executables. The upstream application remains `@deepseek-ai/dsh@0.2.1-rc.3`;
Linux does not substitute a synthetic CLI or a system-installed Node.

## Inputs and assembly

The four frozen host inputs remain in `luckyray-app/dsh-host/`. The Linux
package selection is `dsh-host/linux-x64/input-packages.json`. It selects 564
packages from the same frozen pnpm lock, including the actual Linux native
modules for Koffi, node-pty, Sharp/libvips and the Node builtin bridge.
The mandatory upstream JavaScript package `dsh-win32-process` remains in the
graph; its name does not make it a Linux native executable.

Preparation uses the official Linux Node 22.19.0 archive and the npm-published
[pnpm 11.7.0 archive](https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz).
The preparation scripts pin their bytes and the Node URL. Acquisition
checks lockfile SHA-512 integrity and bounded tar structure. All lifecycle
hooks and pnpmfile hooks remain disabled. Publication-time policy is retained
for the complete frozen lock.

Run these from `luckyray-app`, using new output directories:

```sh
node scripts/linux/acquire-lsh-inputs.mjs /absolute/new-input-cache
node scripts/linux/prepare-lsh-runtime.mjs \
  /absolute/node-v22.19.0-linux-x64.tar.gz /absolute/pnpm-11.7.0.tgz \
  /absolute/new-input-cache /absolute/new-runtime /absolute/new-records
node scripts/linux/stage-lsh-resources.mjs \
  /absolute/new-runtime /absolute/new-resources
```

Assembly first populates a fresh pnpm store from a verified, loopback-only
cache. It then closes that relay and performs a frozen offline installation
in a separate host directory. Socket/DNS accounting covers pnpm's main and
worker contexts. Only the known detached pnpm metadata and the existing
pinned distribution-metadata projection are omitted. The 13 pnpm bin links
become regular shell launchers that explicitly select the bundled Node.
The final tree contains no symlinks, hardlinks or special files.

The compiled Linux records authenticate 34,491 files / 651,381,242 bytes.
The closure SHA-256 is
`b5fe4c01567d650a1b2e21b36310b8127dd0df55afabe3041b8f5d529a9a27b5`.
Its byte format is UTF-8 byte-sorted relative path, NUL, decimal mode, NUL,
decimal length, NUL, file SHA-256, LF. It is different from the Windows
closure format. `runtime-authority.json` binds the manifest, package audit,
notices and original archives. Native code pins those record bytes.

Staging copies the verified runtime to `lr-lsh/199-1/deepseek-harness` and
the exact 18 pinned adapter assets to the sibling `dsh-host`. It preserves
executable modes and rechecks the copied closure. An existing resource root
is never replaced by this helper. License records are placed separately in
`licenses/lsh-linux`.

## Native use boundaries

Linux checks the complete installed closure before creating DSH state, then
retains object identities for the critical executable, entrypoint, package
and ancestor directories. New generations and subsequent use boundaries
revalidate those identities and the closure. Traversal rejects links,
unlisted files/directories, unsafe ownership/mode and unsupported attributes.
These are detection checks; another process with the same user identity can
still modify a dependency while a generation runs.

The authenticated parent/child frame protocol, fresh native probe evidence,
surface binding revocation and generation admission use the production host.
The Linux host and its DSH descendants use the existing native process-group
owner. The retained, unreaped leader anchors the group identity. Failed
in-place reclamation escalates to that owner before a replacement generation.
Escaped descendants and abrupt application death retain the documented Linux
limits. An original-group settlement is not a claim about escaped processes.

Node receives a private HOME/XDG/TMPDIR and an explicit PATH. Ambient loader
options, proxy credentials and unrelated account variables are not inherited.
The existing explicit DeepSeek search-key projection is retained. The probe
uses its local synthetic provider; it does not authorize a real account.

The WebKitGTK LSH child sits in a native overlay over the main webview. This
avoids the runtime's GTK Box path, which vertically packs siblings and ignores
positioned bounds. Linux geometry commands acknowledge their actual GTK
mutation on Main; cancelled queued mutations cannot affect a later lifecycle.
The existing main-caller command checks remain in force for the remote child.

The optional compatibility *baseline trial* now runs on Linux with its own
native group ownership: the trial child is spawned with `detached: true`, so
`setsid` makes its process group id its own pid and that group is provably
disjoint from the live carrier's. The sweep signals that group only while the
leader is still unreaped (a reaped pid may be reused), then waits for the exit
it was promised; anything else reports `owned-group-unsettled` instead of a
settled verdict. The trial keeps the Windows semantics: a one-shot temp home
with the same `AppData` layout, `minimalDshEnvironment`, no user data copied, a
launch URL required and answered over HTTP, and the temp root removed
afterwards. First boot, HTTP and cleanup are covered offline; the pinned real
runtime still needs `DSH_TEST_RUNTIME_ROOT` (CI/QA). The *preload* feature is
still Windows-only and off by default, exactly as in the shipped desktop
build.

## Packaging work

This resource staging helper is not a desktop package preparation gate.
Sidecar source identities, request-mediated browser hosting, Native Messaging
revocation, required media runtimes and installer behavior have their own
admission requirements.

The dependency audit and aggregated notices describe the actual Linux graph.
In particular, Linux libvips is `LGPL-3.0-or-later`; its upstream package carries
a third-party license table and component versions. Complete corresponding
source, required license texts and relinking materials still need to be
assembled for distribution. Do not infer redistribution readiness from a
successful local resource stage or a package's license field.
