// R2-REPAIR-R3 U2 — the extension's semantic theme tokens must keep small
// informational text readable.
//
// Central measured the default dark `--lr-text-faint` against `--lr-surface` at
// 2.983:1 and asked for a real audit rather than a spot fix. This test is the
// regression gate: it parses BOTH surfaces (the popup `:root` tokens in
// theme.css and the content-script Shadow host rules), computes the WCAG
// contrast for the pairs that actually carry text, and fails if any drops
// below the 4.5:1 body-text target.
//
// Run with `node --test` (no build step, no browser).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const THEME_CSS = join(ROOT, "browser-extension-prototype", "theme.css");
const CONTENT_SCRIPT = join(ROOT, "browser-extension-prototype", "content-script.js");

const THEMES = [
  "dark",
  "light",
  "ivory-editorial",
  "rose-tea",
  "github-dark",
  "white-zero",
  "bangladesh-green",
  "lilac-milk",
  "blue-whisper",
];

/** Pairs that carry real small/informational text, with the surface behind
 *  them. Every one of these must reach the body-text threshold. */
const TEXT_PAIRS = [
  ["text", "surface"],
  ["text", "surface-raised"],
  ["text-muted", "surface"],
  ["text-muted", "surface-raised"],
  ["text-faint", "surface"],
  ["text-faint", "surface-raised"],
  ["accent", "surface"],
  ["accent", "surface-raised"],
  ["accent-ink", "accent"],
  ["success", "surface"],
  ["warning", "surface"],
  ["danger", "surface"],
];

const TARGET = 4.5;

function hexToRgb(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Collect `--lr-*: #hex` declarations from a CSS fragment. */
function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/--lr-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function popupSurfaces() {
  const css = readFileSync(THEME_CSS, "utf8");
  const found = {};
  for (const theme of THEMES) {
    const anchor =
      theme === "dark"
        ? css.indexOf("/* ---- dark (default) ---- */")
        : css.indexOf(`:root[data-lr-theme="${theme}"]`);
    assert.ok(anchor >= 0, `theme block exists: ${theme}`);
    const open = css.indexOf("{", anchor);
    const close = css.indexOf("}", open);
    const tokens = tokensFrom(css.slice(open, close));
    assert.ok(Object.keys(tokens).length > 0, `theme ${theme} declares tokens`);
    found[theme] = tokens;
  }
  return found;
}

function shadowSurfaces() {
  const script = readFileSync(CONTENT_SCRIPT, "utf8");
  const found = {};
  const base = /:host\{([^}]*)\}/.exec(script);
  assert.ok(base, "the content-script declares a base :host rule");
  found.dark = tokensFrom(base[1]);
  for (const theme of THEMES) {
    if (theme === "dark") continue;
    const m = new RegExp(`:host\\(\\[data-lr-theme="${theme}"\\]\\)\\{([^}]*)\\}`).exec(script);
    assert.ok(m, `shadow host declares theme ${theme}`);
    found[theme] = tokensFrom(m[1]);
  }
  return found;
}

for (const [label, surfaces] of [
  ["popup theme.css", popupSurfaces()],
  ["content-script Shadow host", shadowSurfaces()],
]) {
  test(`${label}: every text-bearing token pair reaches ${TARGET}:1`, () => {
    const failures = [];
    for (const theme of THEMES) {
      const tokens = surfaces[theme];
      assert.ok(tokens, `${label} has theme ${theme}`);
      for (const [fgKey, bgKey] of TEXT_PAIRS) {
        const fg = hexToRgb(tokens[fgKey]);
        const bg = hexToRgb(tokens[bgKey]);
        assert.ok(fg, `${label}/${theme} defines --lr-${fgKey}`);
        assert.ok(bg, `${label}/${theme} defines --lr-${bgKey}`);
        const value = ratio(fg, bg);
        if (value < TARGET) {
          failures.push(`${theme} --lr-${fgKey} on --lr-${bgKey} = ${value.toFixed(3)}:1`);
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      `text pairs below ${TARGET}:1:\n  ${failures.join("\n  ")}`
    );
  });
}

test("both surfaces define the same nine themes", () => {
  const popup = popupSurfaces();
  const shadow = shadowSurfaces();
  assert.deepEqual(Object.keys(popup).sort(), [...THEMES].sort());
  assert.deepEqual(Object.keys(shadow).sort(), [...THEMES].sort());
});

// The specific measurement central took, pinned so it cannot regress silently.
test("the default dark faint text central measured now clears the threshold", () => {
  const tokens = popupSurfaces().dark;
  const value = ratio(hexToRgb(tokens["text-faint"]), hexToRgb(tokens["surface"]));
  assert.ok(value >= TARGET, `dark text-faint/surface = ${value.toFixed(3)}:1`);
  // …and it is still a muted tone, not promoted to primary text.
  const primary = ratio(hexToRgb(tokens.text), hexToRgb(tokens.surface));
  assert.ok(
    value < primary,
    "faint text stays visually subordinate to primary text"
  );
});
