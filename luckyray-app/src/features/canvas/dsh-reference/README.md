# Official DSH UI primitives, 0.2.1-rc.2

This is direct reuse of `@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2`, not a visual approximation or a rewritten Markdown renderer. The complete published `lib` implementation, CSS modules, and type declarations live in `upstream/primitives`. The MIT license and original package manifest are preserved there.

## Application imports

```tsx
import {
  DisclosureRow, TextShimmer, MarkdownText,
  IconThinkOutlineRegular, IconApiOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  JsonTree, CodeBlock, ReadBlock, DiffBlock, SearchBlock, TerminalBlock, WebBlock,
} from './dsh-reference/primitives';
```

`primitives.ts` re-exports the complete official API. It has no component implementation or local substitutes. The only extra file in the upstream directory is `lib/index.d.ts`, a one-line declaration bridge to the unchanged published declarations. It is intentionally excluded from the original-file hash inventory.

Official `MarkdownText` retains the direct mdast parser, GFM, incremental streaming cache, code highlighting, KaTeX, safe-protocol handling, and delegate callbacks. Official `DisclosureRow` retains its controlled state, header accessory, leading-icon/hover-chevron swap, row/keyboard activation policy, and nested `TextShimmer` behavior.

## Dependencies and bundling

Merge `runtime-dependencies.json` into the application dependency manifest and regenerate its lockfile. Do not install into an existing shared `node_modules` symlink. This proposal pins 24 packages exactly and leaves the application's existing React and React DOM versions alone.

The upstream package lists actual runtime imports under `devDependencies`, so merely installing the published primitive package does not provide a reliable dependency closure. The proposal accounts for:

- Every bare static and dynamic import in the official primitive JavaScript.
- `immer` and `zustand`, imported by the official store package but likewise listed only as development dependencies there.
- `@deepseek-ai/cordis`, required by the official packages' peer/type contracts. No Cordis runtime or model service is initialized by this adapter.

Vite must process the `.module.css` imports normally. Do not convert them to global CSS, stub them, or replace component styles with an imitation. The imported KaTeX stylesheet needs the bundler's normal font asset handling. Shiki's dynamically imported language grammars should remain split chunks where supported.

## Host theme contract

The primitives consume DSH `--dsw-*`, `--ds-*`, and selected `--dsh-*` variables from their containing surface. The canvas owns the scoped bridge from LuckyRay theme tokens to these variables. Do not patch upstream CSS to fit the host theme.

For the status row, supply at least `--dsw-alias-label-tertiary`, `--dsw-alias-label-secondary`, and `--dsw-alias-label-shimmer`. The default disclosure sizing is already in upstream CSS: 24px row, 16px leading box, 14px glyph, and 13px secondary text, adjusted by `--dsh-content-font-delta` and `--dsh-content-font-size-secondary`. Markdown and tool bodies additionally need the color, typography, border, code, and radius tokens they consume. `theme-token-usage.json` inventories tokens by source CSS file for the host bridge.

Keep the `MarkdownText.labels` object stable, as documented by its official declarations. Use `MarkdownDelegateProvider` for owner-controlled external/local navigation rather than bypassing its link policy.

## Fidelity and licensing

`source-manifest.json` records SHA-256 for all 132 copied original files, the npm tarball URL, its registry integrity/shasum, and upstream repository location. Every recorded file was additionally compared byte-for-byte against the exact npm registry tarball. No upstream JavaScript, CSS, declaration, package metadata, or license bytes were edited.

Run the small integrity/dependency contract without building the application:

```sh
node src/features/canvas/dsh-reference/verify-upstream.mjs
```

Preserve the upstream MIT copyright/license when redistributing. Installed dependency packages retain their own licenses and should continue through the application's normal third-party notice process.

## Verification and known upstream compatibility note

Focused verification completed on 2026-10-22:

- SHA-256 inventory and exact npm tarball comparison passed for all 132 original files.
- An isolated esbuild browser bundle resolved the complete dependency closure, CSS modules, fonts, requested icons, Markdown, and tool-body exports.
- A TypeScript smoke test preserved official required prop types, including negative checks for missing DisclosureRow props and missing Markdown labels.
- Server-render smoke passed for disclosure/ARIA, active shimmer, GFM tables/formatting, safe URLs/raw-HTML exclusion, streaming Markdown, and KaTeX using a test-only DOMParser implementation.

These are focused checks, not a full application build or a visual interaction pass. A Chromium interaction attempt was blocked by this execution sandbox's socket permission; it did not execute the UI tests.

Upstream targets React 18 and uses `inert: ""` for TextShimmer's decorative copy. React 19 warns and omits that boolean attribute. The original `aria-hidden="true"`, `pointer-events: none`, clipped decorative copy, and reduced-motion CSS remain intact. Keep shimmer children strictly presentational, without effects, IDs, or focusable controls, as required by the official API. Header actions belong in `headerAccessory`, outside the shimmer. This compatibility issue is addressed by the explicit reversible patch documented below.

Math rendering calls browser `DOMParser`; plain Node SSR needs a DOM implementation. The production canvas is browser-based and should not replace this renderer merely to accommodate a Node-only test.

## React 19 compatibility correction
The single `inert: ""` property in TextShimmer is changed to `inert: true` for React 19. See react19-compatibility.patch and compatibility-manifest.json. Verification reverses exactly this patch then checks the original source hash. This replaces the upstream empty-string warning and preserves an actually inert decorative copy. All other official implementation bytes remain unchanged.
