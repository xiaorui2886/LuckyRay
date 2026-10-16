// R2-REPAIR-R3 U1 — the content-script's injected icons must not depend on
// subresources a page CSP can block.
//
// Central's ruling was AMBIGUOUS pending a real reproduction. The
// reproduction is settled: a page with `img-src 'self'` (no `data:`) blocks
// the old `data:image/svg+xml` mask fetches at the document level — Shadow DOM
// does not isolate it — and the icons render as empty boxes (verified with the
// real unpacked extension in a real Chromium; see the U1 evidence pack). The
// icons are inline SVG children now, and this test keeps it that way.
//
// Run with `node --test` (no build step, no browser).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const CONTENT_SCRIPT = join(ROOT, "browser-extension-prototype", "content-script.js");
const POPUP_CSS = join(ROOT, "browser-extension-prototype", "popup.css");

test("content-script icons are inline SVG, not data:-URL masks", () => {
  const source = readFileSync(CONTENT_SCRIPT, "utf8");

  // The delivery mechanism is an SVG element builder.
  assert.match(source, /function lrCollectorIconSvg\(name\)/);
  assert.match(source, /document\.createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  // Theming still follows the semantic token through currentColor.
  assert.match(source, /setAttribute\("stroke", "currentColor"\)/);

  // No data: image URLs remain anywhere in the injected stylesheet or markup —
  // a single reintroduced one is all it takes to blank an icon on strict CSP.
  assert.doesNotMatch(source, /url\(\s*["']?data:image/, "no data: mask URLs");
  assert.doesNotMatch(source, /--lr-icon-[a-z-]+:\s*url\(/, "no icon custom properties hold URLs");
  // And no mask-based icon painting survives in the injected CSS.
  assert.doesNotMatch(source, /-webkit-mask:\s*var\(--lr-icon-url\)/);
  assert.doesNotMatch(source, /mask:\s*var\(--lr-icon-url\)/);

  // The three consumed surfaces attach their icon as a child element.
  for (const name of ["chipIcon", "closeIcon", "markIcon"]) {
    assert.match(source, new RegExp(`const ${name} = lrCollectorIconSvg\\(`), `${name} built`);
  }
});

test("the geometry map covers every icon the shadow surfaces reference", () => {
  const source = readFileSync(CONTENT_SCRIPT, "utf8");
  const map = /const lrCollectorIconGeometry = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(map, "geometry map exists");
  const defined = new Set([...map[1].matchAll(/\n\s+"?([a-z-]+)"?: "/g)].map((m) => m[1]));
  const used = new Set([...source.matchAll(/lrCollectorIconSvg\("([a-z-]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.size > 0, "icons are actually consumed");
  for (const name of used) {
    assert.ok(defined.has(name), `lrCollectorIconSvg("${name}") has geometry`);
  }
});

test("popup may keep its own mask technique — extension pages are not page-CSP scoped", () => {
  // popup.css runs in the extension's own document, whose CSP the extension
  // controls; the strict-page hazard does not apply there. This test just
  // pins that reasoning to the file so a future move of popup styles into the
  // content script is caught.
  const css = readFileSync(POPUP_CSS, "utf8");
  assert.match(css, /--lr-icon-url/);
});

test("generator emits the same geometry the content-script embeds", () => {
  // Run the maintained generator and compare its output for the consumed
  // icons against the embedded map, so asset edits cannot drift silently.
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "embed-shadow-icons.mjs")], {
    encoding: "utf8",
  });
  const generated = new Map([...out.matchAll(/\n?\s+"?([a-z-]+)"?: "(.+)",/g)].map((m) => [m[1], m[2]]));
  assert.ok(generated.size >= 10, "generator produced the icon set");

  const source = readFileSync(CONTENT_SCRIPT, "utf8");
  const map = /const lrCollectorIconGeometry = \{([\s\S]*?)\n\};/.exec(source);
  const embedded = new Map([...map[1].matchAll(/\n\s+"?([a-z-]+)"?: "(.+)",/g)].map((m) => [m[1], m[2]]));
  for (const [name, geometry] of generated) {
    assert.equal(
      embedded.get(name),
      geometry,
      `geometry drifted for "${name}" — re-run scripts/embed-shadow-icons.mjs and update lrCollectorIconGeometry`
    );
  }
});
