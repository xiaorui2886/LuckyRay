# LuckyRay DSH runtime closure

This directory defines the DSH-0 supply-chain boundary. It does not start a
process, open a transport, publish readiness, or connect DSH to AgentEngine.
The separate DSH-1 host remains the only process/JIT/transport authority.

Runtime authority is the exact `@deepseek-ai/dsh@0.1.7-rc.2` npm tarball plus
the frozen `pnpm-lock.yaml` closure. The recorded rc.2 Git tag commit is a
separate audit identity; it is not asserted as byte provenance for the npm package.

The staging flow requires three pre-fetched inputs:

- the official Node.js Windows x64 archive pinned in `runtime-authority.json`;
- the exact pnpm tarball pinned in `runtime-authority.json`;
- the complete 449-file extracted pnpm tree manifest pinned in
  `runtime-authority.json` and produced by the app-owned Node extractor;
- a pnpm content-addressed store already populated from this lockfile.

Run `scripts/prepare-dsh-runtime.ps1` with explicit paths to those inputs and a
new output directory. The script verifies both archives, extracts only the
app-owned Node executable and license, and launches the pinned pnpm entry with
an empty app-owned configuration environment. No PATH-selected archive tool
can create executable pnpm bytes. The tracked extractor accepts only
checksum-valid USTAR regular-file headers with empty prefix/link fields and
exact magic/version; links, extended headers, Windows path aliases, reserved
names, collisions, unknown types, and over-budget archives/entries/paths fail
before output is created. The extracted tree is re-hashed immediately before
the same Node process imports it. Pnpmfiles are disabled, package imports are
copied rather than hardlinked, the isolated resolver layout is fixed on the
command line, and lifecycle scripts remain disabled. The tracked,
authenticated workspace policy explicitly fixes pnpm's release-age gate at
1,440 minutes, enables strict transitive enforcement, and rejects registry
entries whose release time is missing. The rc.2 closure requires no release-age
exceptions, and the authenticated policy rejects any exclusion list. The exact
publish candidate must contain no multiply-linked regular files before its
content, resolver graph, entrypoint, PE x64 evidence, and records are verified.
The same app-owned Node then loads `koffi`, `node-pty`, `sharp`, and
`node-addon-require-builtin` and runs
the inert `dsh --version` capability probe. Neither probe starts a supervisor
or opens a transport. The verified candidate is published by a same-parent
directory rename. Before any success handle is returned, every resolver link
is rebuilt at the final root from the authenticated recorded graph rather than
from an old link target. The final path then repeats detached, closure,
native-load, entrypoint/version, and closure-seal verification. A rebind or
final-path failure removes the unpublished output. The flow never falls back
to system Node and never updates the lockfile or supply-chain records.

`records/dependency-audit.json` inventories every staged package, lifecycle
script declaration, license file, native executable, root/nested resolver
edge, and the resolved launch entrypoint. It also reconciles each of the 591
locked identities as one of 516 staged identities or 75 explicitly reasoned
platform/architecture/optional prunes. Mandatory and optional-only identities
are derived from the real importer/snapshot graph; a missing mandatory Windows
x64 dependency fails closed. The CycloneDX SBOM, third-party notice,
launch manifest, and runtime manifest are generated from that same audited
closure and are validated byte-for-byte by the DSH supply-chain contract.

`pnpm test:dsh-supply-chain` is the canonical production gate. It requires
`DSH_NODE_ARCHIVE`, `DSH_PNPM_TARBALL`, `DSH_OFFLINE_STORE`, and
`DSH_EXISTING_STAGE`; missing fixtures fail non-zero. The gate executes every
production contract under the exact staged Node 22.19.0 with zero skips. It
uses a tracked reporter that emits only Node test-runner events, not test
stdout. Every top-level contract carries a stable `dsh0.*` identity; the gate
requires the exact declaration-ordered 20-ID inventory with no duplicates,
substitutions, failures, cancellations, or skips. The test child receives an
explicit Windows environment allowlist: system root/command shell/temp,
minimal system and PowerShell PATH entries, the four validated fixture paths,
and `DSH_REQUIRE_PRODUCTION_FIXTURES=1`. Node preload/loader variables,
`DSH_PREPARE_SCRIPT`, user package configuration, and the caller PATH are not
inherited. In production-fixture mode the tests resolve only the canonical,
non-symlinked tracked `scripts/prepare-dsh-runtime.ps1`; the override remains a
unit-only seam.
`pnpm test:dsh-supply-chain:unit` is the separate fixture-free developer check
and must not be used as DSH-0, CI, package, or release evidence.

The DSH-1 host keeps the existing app-owned compatibility state root at
`deepseek-harness/native-state/rc8-v1` below the application data directory.
That root belongs only to the DSH runtime; it is not a LuckyRay product-data
store. Every diagnostic run takes fresh native session/turn evidence by
comparing the authenticated state before and after the run. The rc.2 upgrade
intentionally retains this namespace so existing rc.8 sessions remain visible;
it does not introduce a second store or migrate live data.
