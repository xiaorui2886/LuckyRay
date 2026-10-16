# License index clarification — A16 / B17

This clarification is part of the distribution notice materials for the
immutable1.9.16/1.9.17 Windows test candidates. It does not modify installer
bytes, original copyright/license text, the updater's signature/trust, or
third-party rights.

## wasmparser0.244.0 (Deno2.9.4 conservative dependency inventory)

The exact published crate declares:

`Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`

The candidate's informational `selectedLicense` index field accidentally says
`MIT WITH LLVM-exception`. The actual alternative selected for distribution is
**MIT**, which is independently granted by that original declaration. The
published original grant/attributions and full MIT text are already supplied.
The additional LLVM-exception text was conservatively included and does not
create an extra condition on the independently available MIT alternative.
Do not interpret the informational label as a replacement for the original
license grant.

The three listed Cranelift0.117.2 packages actually declare
`Apache-2.0 WITH LLVM-exception`; their labels and supplied texts are unchanged.

Exact original wasmparser archive:
https://crates.io/api/v1/crates/wasmparser/0.244.0/download

The archive SHA-256 and original published grant/attribution provenance remain
in `third-party-notices/deno-2.9.4/INDEX.json`. No different package version's
license is substituted. This is a notice/index-label clarification only; all
original permissions and warranty terms remain in force. Keep this document
with the test candidates and their notice supplement.

## Repaired A18 / B19 metadata

The 1.9.18/1.9.19 source and notice indexes directly carry the corrected **MIT**
selected-license label. The original grants, attributions and license bodies
remain identical. This document retains the historical A16/B17 clarification;
it is not a claim that the new candidates still contain that informational error.
