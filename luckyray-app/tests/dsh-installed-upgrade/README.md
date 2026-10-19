# One-off installed desktop → DSH acceptance

This observer is test infrastructure, not a release or an update feed. It is
restricted to the owner's explicit dispatch on this reviewed test branch, a
standard disposable GitHub Windows runner, and a fresh synthetic profile.

The single continuous scenario is:

1. Install the immutable original public desktop 1.9.8. Create an old session
   with its actual old engine and a deterministic loopback provider (no paid
   model), a synthetic Markdown note, settings, and a materials/notes-only grant.
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
Preparation paths are normalized at the observer's JSON input boundary. The
exact installer directory, process ownership, language and automatic-reopen
assertions are unchanged; Windows separator differences cannot cause a false
directory-mismatch result.

Existing component, compatibility, cancellation, real local IME and broader MCP
evidence is reused separately. A syntax check, crypto unit test, installer exit
code or `webview-created` alone is not an installed upgrade PASS. Do not change
guards, manufacture a GitHub environment locally, or launch B manually to make
this observer pass.
