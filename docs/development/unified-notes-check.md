# Unified Notes check branch

This isolated branch checks the current 1.9.8 development source and Notes changes;
it is not a stable release, installer, or update offer. Main and existing downloads
are unchanged.

The exact runtime authority is DeepSeek Harness 0.2.1-rc.2, Node 22.19.0 and
frozen-assembly pnpm 11.7.0. The authenticated closure contains 633 locked packages
and 561 staged packages. Existing runtime seals, notices and staging checks remain
strict. Frontend and Windows check toolchains remain pinned in source-checks.yml.

CI runs only for ray/unified-notes-check-20261025. It checks the frontend, directed
synthetic tests and full Windows native library; it does not build an installer,
publish a release, or access a private repository, user data or model credentials.
A successful check is not installation, sync migration or release acceptance.
