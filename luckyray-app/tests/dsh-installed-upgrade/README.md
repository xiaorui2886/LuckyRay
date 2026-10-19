# One-off installed desktop → DSH acceptance

This observer is test infrastructure, not a release or an update feed. It is
restricted to the owner's explicit dispatch on this reviewed test branch, a
standard disposable GitHub Windows runner, and a fresh synthetic profile.

The single continuous scenario is:

1. Install the immutable original public desktop 1.9.8. Create an old session
   with its actual old engine and a deterministic loopback provider (no paid
   model), a synthetic Markdown note, settings, and a materials/notes-only grant.
   Import one synthetic material before either upgrade and keep its library,
   record identity, registered source and file bytes throughout both legs.
   This preparation runs **without proxy or temporary CA**, after the original
   engine's background readiness is observed. The optional official MCP package
   is acquired through its ordinary public download/verification flow; the new
   synthetic grant uses the existing explicit consent API. Use the actual UI
   to select normal exit (rather than its tray default), then quit normally.
   If preparation fails, stop before any certificate action. Reopen the same A,
   same profile and grant only after preparing the approved update-file replay;
   this separately labelled fixture reopen is not an automatic-update result.
2. Discover and download the formally signed desktop 1.9.9 through the installed
   UI, edit a note through the real editor, request immediate update, observe
   normal save/exit and the official passive installer, and require installer-
   owned automatic reopen. Compare the exact note, settings and original grant.
3. Prove that this installed new host is still running the old 0.1.7-rc.2 engine.
   From the AI settings UI discover the signed 0.2.1-rc.2 candidate, acquire the
   pinned official inputs, assemble and verify its complete closure, and request
   the product's normal restart/switch. No active-pointer write or manual launch
   may substitute for that restart. Complete the product's local health check.
4. Observe the actual selected process image/package version, old conversation
   and unchanged original session generation. Type an unsent synthetic draft in
   the real composer, perform a separately labelled ordinary close/reopen and
   compare the restored text. Add a material PDF and canonical Markdown note by
   actual sidebar clicks; verify official binary-upload success, target session,
   name and stored bytes without submitting a prompt.

Only the exact reviewed update-file URLs are replayed. The temporary CA is used
only on this specifically approved disposable machine and removed in an
`always()` step; the proxy is passed only to the installed test process and its
children. Credential-bearing requests and other hosts/paths are rejected. The
independent upstream-discovery API is not impersonated; this test does not claim
that the live public feeds have been published or are available.
MCP downloads are not proxied or replayed in the continuous update phase.

The private input ZIP is transferred with a short-lived download URL in an
environment Secret restricted to this branch. No private repository token or
private source checkout is used by the runner. A local controller must delete
the Secret on success, failure or cancellation and verify expiry/revocation of
the URL. Never dispatch until `expected.json` and all signatures are frozen.

Only encrypted evidence is uploaded. The committed recipient is a **test return
encryption public key**, not a production update trust key. Its private key stays
DPAPI-protected on the operator machine, outside repositories and result assets.
TLS keys, credentials and temporary download URLs are never evidence inputs.
The installed processes receive an explicit Windows environment allowlist, not
Actions runtime credentials, repository tokens or the transfer Secret.
Their process-local `PSModulePath` is explicitly Windows native modules first,
then the shared Windows PowerShell module directory. Both paths derive from
validated Windows installation directories, not inherited CI/module values.
The original 1.9.8 helper otherwise rebuilt a hosted-image module search path
and exceeded its unchanged 20-second bound on first `New-Object` loading.
Run `39190789416` compared the same helper bytes/cwd/pipes: default search timed
out, ordered native search completed in 392 ms, and the unchanged original app
completed component installation after a normal same-profile reopen in 3.26 s.
The actual-app comparison also followed separate native-module diagnostic
controls; it does not claim an independent cold-cache measurement. The direct
same-byte ordered control succeeded before those instrumented controls.
No helper, original installer, execution policy, timeout or grant was patched.
Preparation paths are normalized at the observer's JSON input boundary. The
exact installer directory, process ownership, language and automatic-reopen
assertions are unchanged; Windows separator differences cannot cause a false
directory-mismatch result.

Existing component, compatibility, cancellation, real local IME and broader MCP
evidence is reused separately. A syntax check, crypto unit test, installer exit
code or `webview-created` alone is not an installed upgrade PASS. Do not change
guards, manufacture a GitHub environment locally, or launch B manually to make
this observer pass.

## Focused original-version storage diagnostic (no CA)

`storage-initialize-diagnostic.yml` is a separate, owner-dispatched standard
Windows job. It downloads only the exact original public 1.9.8 and does not
request a private transfer, credential, temporary trust or update proxy. Existing
formal-signature evidence for those unchanged original bytes is reused; neither
upgrade is started by this diagnostic.

The native test observer uses Toolhelp process snapshots for a child of this
one actual installed A PID. It validates the exact initialize-only argument
vector before recording it. Read-only, bounded x64 process-parameter inspection
is image/path checked; it records cwd and the three standard-handle types/pipe
metadata, never environment values or stream content. No debug privilege, audit
policy, code injection, debugger attach or security disablement is used.
Native process exit status is read through a held query/synchronize handle, not
inferred from a vanished process or another round's logs.

Same-byte direct controls keep the actual helper, cwd and ordinary process
environment, comparing immediately closed versus open stdin. A separately
labelled instrumented initialize-only copy gives supplementary stage markers;
it never replaces the installed helper and is not same-byte acceptance proof.
One independently observed retry is allowed only for this same initialize
timeout, in the same original app process. The product's 20-second limit and
all signature/integrity/authentication checks remain unchanged. Only the new
owned direct-control helper can be terminated at its existing 20-second bound;
the observer never terminates the app or its actual child.

The process-parameter inspection follows Microsoft's documented PEB/process
query approach with explicit x64 layout/image checks; internal offsets are not
treated as portable product APIs. Relevant primary references:
[PEB](https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-peb),
[Microsoft process-query example](https://github.com/microsoft/vscode-windows-process-tree/blob/main/src/process_commandline.cc),
[pipe metadata](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-getnamedpipeinfo).

Evidence returns under the existing separate test-return encryption public key.
No plaintext screenshot/trace, private key or synthetic credential is uploaded.

## Separate DSH-only acceptance (Ray, 2026-10-19)

This is a separate acceptance scope, not a replacement for the unfinished full
1.9.8 -> 1.9.9 desktop/MCP integration chain. `chain.mjs`, `prepare-fixture.mjs`
and the original workflow retain their full-chain assertions. The shared engine
helper defaults to `full-integration`; explicit `dsh-only` rejects all grant
parameters and refuses existing community MCP state. No grant is manufactured.

The new `.github/workflows/dsh-only-installed-acceptance.yml` is restricted to
owner manual dispatch on `test/dsh021-only-ray-20261019`, a standard disposable
Windows runner and its separate environment. It directly installs the exact
frozen signed B 1.9.9 after existing native signature verification. It does not
download/install A or the community MCP component. B must still contain the real
0.1.7-rc.2 engine. No version bump, product rebuild or signing occurs.

`prepare-dsh-only.mjs` runs before CA/proxy preparation. It reuses the genuine
old-engine probe and material import helpers and normal note/settings APIs on a
fresh synthetic profile, then quits normally. Probe-created conversation and
synthetic workspace metadata are not real-user conversation-input evidence.
`dsh-only.mjs` then reuses the real engine UI download/verify/stage/restart/health
flow, owned Node identity, frozen host identity and original-session byte checks.
It verifies note API content, settings, material identity, draft restore, original
file additions to the correct composer and cleared draft non-resurrection. It
never submits a real model prompt. A pre-CDP event captures the product's reopened
process before connection is attempted. Manual repair cannot replace that reopen.

Only `PASS_DSH_ONLY_INSTALLED_ENGINE_UPGRADE` may be reported for this path.
Desktop A-to-B stays `NOT_RUN`, community MCP authorization stays
`NOT_APPLICABLE_TO_DSH_ONLY`. Production feed availability, real IME and external
web tunnel stay unverified. Success here is not release approval.

Before a real dispatch, obtain this run's approval for its temporary LocalMachine
CA and exact-URL process proxy, and provision the reviewed transfer through
`DSH_ONLY_TRANSFER_20261019` in the separate environment. The workflow's boolean
and reference record approval; they do not grant it. Preserve the existing
transfer/spec/DSH signature and closure verification without rebuilding inputs.
Supply a reviewed RSA public key and its SPKI DER SHA256 in the two required
recipient inputs; retain the matching private key outside the runner. The old
recipient cannot be assumed available. Public recipient validation precedes the
test; uploads are encrypted-only, with no plaintext fallback. No private key is
read, created or uploaded by this driver. Existing CA cleanup runs on failure;
the controller must additionally remove the temporary Secret/environment and
verify expiry of the same transfer URL, retaining any unresolved gap.

Cheap local checks (not installed-engine acceptance):

    node --test tests/dsh-installed-upgrade/harness-contract.test.mjs tests/dsh-installed-upgrade/dsh-only-contract.test.mjs tests/formal-update/windows-native-encoding.test.mjs
    node --check tests/dsh-installed-upgrade/dsh-only.mjs
    node --check tests/dsh-installed-upgrade/prepare-dsh-only.mjs
    node --check tests/dsh-installed-upgrade/engine-chain.mjs
    node --check tests/dsh-installed-upgrade/preservation-policy.mjs

Windows-native observer tests skip on other platforms. Do not interpret local
contract checks as an installer, signed engine upgrade or release PASS.

The already-registered `updater-installed-acceptance.yml` is also the dispatch
entry on the isolated new branch: select `dsh_only=true`, `storage_only=false`.
It calls the separate DSH-only reusable workflow. Original desktop and storage
jobs explicitly exclude DSH-only; their prior branches and assertions remain.
No default/main branch modification is needed for workflow registration.
