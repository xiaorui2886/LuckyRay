# Signed desktop updater: candidate validation

Current repaired pair **1.9.18 → 1.9.19 candidate**. Publishing source does not change stable
downloads, Latest Release, website or production `latest.json`.

Existing flow: discovery → cancellable download/progress → signature verification →
explicit immediate update or schedule → existing note/IME/task barriers → real
LSH save/exit → installer → installer-owned automatic application reopen. Active
tasks, approvals, uncommitted input, failed saves and timeouts must block it.

Fixes address idle-preload false busy, owned HTTP long-stream retirement only
after saved/idle confirmation, NSIS stored language and official update arguments.
Code tests are not proof of a real installed A→B chain.

| Historical frozen input | Installer SHA-256 |
| --- | --- |
| A 1.9.14 | `157260eac6af90c82cb682b6110e9711d6bdda538cf636c00faf7e04b5b4b637` |
| B 1.9.15 | `25de3445a6be965720abaa903a1a75ad0c4c347a4bf1dea4514564066d8dc8f7` |

Do not substitute/re-sign different bytes at these versions. Both are signed with
the unchanged official updater key but are **not Windows Authenticode signed**.
File SHA-256, updater signatures and Windows signing are different checks.

A16/B17 were the necessary distribution-metadata/notice rebuild of those inputs.
Their first actual installed run
[38910975009](https://github.com/xiaorui2886/LuckyRay/actions/runs/38910975009)
failed **before update discovery** at background LSH admission. Generated records
had changed but three native embedded-record pins were missed. The native
integrity guard correctly refused them. Their historical release assets remain
unchanged and are explicitly marked as having this known blocker.

The repair synchronizes only those exact native hashes, preserves all integrity
checks, adds four normal-build record-pin regressions, and invokes the original
Rust admission implementation in verification-only tooling before any runner
trust or installer changes. Old pins fail both the portable regression and real
native verifier; corrected pins pass against the actual isolated runtime. It
also corrects the independently granted MIT metadata label in the new notices.
This does not change original license texts or the official LSH version.

A18/B19 package identities and the two repaired installed results will be added
only after actual immutable artifacts and independent runs exist. They are
**not accepted on the strength of source checks or component tests**.

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

Historical source checks, bounded behavior tests, resource/seal checks and updater
signature verification exist. The A16 installed preload admission failure is
retained, not relabelled as an environment or baseline problem. **Both repaired
continuous A18/B19 chains remain pending.** Their individual
PASS/FAIL/BLOCKED/NOT_RUN results and cleanup evidence will be recorded here.
No release-ready claim is made. Real IME and production-feed availability are not
proven by a controlled HTTPS replay or synthetic events.
