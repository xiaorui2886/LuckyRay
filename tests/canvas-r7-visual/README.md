# Canvas R7 synthetic visual checks

This isolated test fixture renders the actual Canvas Agent, creative-tool and direct image-crop UI components with entirely synthetic, in-memory inputs. Production UI files are copied byte-for-byte, with SHA-256 hashes in SOURCE-MANIFEST.json. It does not include a private repository history, runtime kernel, model credentials, real user conversations, or user assets.

The test branch is not a release. No installer, update feed, website, or default branch is changed. No native bridge or provider request is used. Browser requests are restricted to the local fixture server, with locally generated data images.

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npx --no-install playwright install chromium`, `node audit-inputs.mjs`, then `node run-all.cjs`. The workflow installs required Chromium OS dependencies on its disposable hosted runner.

The evidence covers production React UI rendering and synthetic interactions in Chromium. It does not prove real Windows WebView behavior, native LSH integration, provider streaming, billing, or paid media generation. NPM dependencies retain their original licenses; application sources retain the repository license.

Agent, creative-tool and crop browser scripts run in separate processes. A failed crop check does not prevent the original Agent/creative regressions from producing their own evidence. Saved-image checks decode synthetic PNG bytes locally; they do not write to a user canvas or contact a provider.
