// One-off generator: turns the local LightSeek icon assets into the inline
// SVG geometry map used by the content-script Shadow DOM surfaces.
//
// History: these icons used to ship as `data:image/svg+xml` mask URLs. That
// technique breaks on pages with a restrictive CSP (`img-src 'self'`, no
// `data:`) — the mask fetch is blocked at the document level and Shadow DOM
// does not isolate it, leaving the buttons as empty boxes. Reproduced in a
// real Chromium with a real CSP header; see the R2-REPAIR-R3 U1 evidence.
// The generator therefore emits raw `<svg>` inner geometry consumed by
// `lrCollectorIconSvg()` in content-script.js, which builds inline SVG
// elements (no fetch, no manifest/WAR widening, `currentColor` theming).
//
// Source of truth stays `icons/ui/*.svg`; re-run after changing an asset and
// paste the output over `lrCollectorIconGeometry`:
//
//   node scripts/embed-shadow-icons.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = path.join(root, "browser-extension-prototype", "icons", "ui");

const names = [
  "video", "close", "success", "failure", "warning", "loading", "offline",
  "online", "folder-open", "add", "stop", "restore", "smart-folder",
  "collection-inbox", "search", "note",
];

for (const name of names) {
  const svg = fs.readFileSync(path.join(iconDir, `${name}.svg`), "utf8").trim();
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    // Emit single-quoted HTML attributes inside a double-quoted JS string,
    // exactly like the hand-written map in content-script.js.
    .replace(/"/g, "'")
    .trim();
  const key = /^[a-z]+$/.test(name) ? name : `"${name}"`;
  process.stdout.write(`  ${key}: "${body}",
`);
}
