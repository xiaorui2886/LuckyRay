# LSH runtime update trust

## review-20261016

This public source review preserves the existing Ed25519 public key, fingerprint,
exact HTTPS metadata/descriptor namespace, strict field validation and rejection
of environment-provided production trust. No private signing key, new runtime,
feed or stable desktop release is published by this document.

The source-review reference in `config/dsh-production-update-source.json` names
this public document instead of an internal coordination receipt. The parser
accepts only this public review namespace and a numeric identifier. This is a
provenance publication adjustment, not a new trust root or weakened signature,
platform, generation or descriptor check.

LSH remains 0.1.7-rc.2. Runtime updates are distinct from the signed **desktop
installer** updater described in [updater-validation.md](updater-validation.md).
