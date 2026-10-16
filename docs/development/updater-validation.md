# Signed desktop updater: candidate validation

Source version **1.9.15 candidate**. Publishing source does not change stable
downloads, Latest Release, website or production `latest.json`.

Existing flow: discovery → cancellable download/progress → signature verification →
explicit immediate update or schedule → existing note/IME/task barriers → real
LSH save/exit → installer → installer-owned automatic application reopen. Active
tasks, approvals, uncommitted input, failed saves and timeouts must block it.

Fixes address idle-preload false busy, owned HTTP long-stream retirement only
after saved/idle confirmation, NSIS stored language and official update arguments.
Code tests are not proof of a real installed A→B chain.

| Frozen input | Installer SHA-256 |
| --- | --- |
| A 1.9.14 | `157260eac6af90c82cb682b6110e9711d6bdda538cf636c00faf7e04b5b4b637` |
| B 1.9.15 | `25de3445a6be965720abaa903a1a75ad0c4c347a4bf1dea4514564066d8dc8f7` |

Do not substitute/re-sign different bytes at these versions. Both are signed with
the unchanged official updater key but are **not Windows Authenticode signed**.
File SHA-256, updater signatures and Windows signing are different checks.

After binary privacy/distribution review, test attachments may be placed only in
a **TEST ONLY / UPGRADE ACCEPTANCE INCOMPLETE** pre-release, never Latest/feed.

## Two independent continuous Windows chains

Each fresh standard GitHub-hosted Windows runner installs exact A into a Chinese
and space path, creates synthetic note/settings/material-and-note-only grant,
then executes one scenario:

1. **Immediate:** real discovery/download/verification → edit → immediate button →
   saved confirmation before normal exit → actual installer → automatically opened
   B → compare full note, document identity, settings, grant/credential fingerprints
   and exact B executable.
2. **Scheduled:** download/verify → schedule → remain usable and edit → protected
   normal exit and product-defined next-launch trigger → installer → automatic B
   reopen → the same complete comparisons.

No manual B launch, language-dialog clicking, forged runner environment, relaxed
identity assertion, private-repository token or private signing key is allowed.
Synthetic events do not prove real IME behavior. Native installer observation is
read-only; security/permission prompts cannot be bypassed.

Frozen EXEs use the fixed official GitHub manifest URL. To avoid changing Latest,
an ephemeral test HTTPS replay needs **fresh explicit owner approval for each new
trust/credential scope**. Past-run approval is not inherited. CA/leaf private keys
stay on the disposable machine; only sanitized observations can be retained.

## Current result

Local full builds, bounded behavior tests, resource/seal checks and updater
signature verification exist. **Both new installed continuous chains are not yet
passed.** Public Windows run links and individual PASS/FAIL/BLOCKED/NOT_RUN results
will be recorded here. Until then, no release-ready claim is made.
