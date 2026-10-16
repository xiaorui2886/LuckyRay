// Loopback static server for the S1 fixture page (Issue #13 §5D).
//
// The page is served from 127.0.0.1 so the real manifest content scripts
// (matches http://*/*) inject exactly as they would on a production page.
// The fixture port is deliberately outside the LocalTransport discovery
// range (37418..37467) so the page server can never be mistaken for the
// fake desktop service.

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DISCOVERY_FIRST_PORT, DISCOVERY_LAST_PORT } from "./fake-local-transport.mjs";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// 1x1 transparent PNG (fixture image for untrusted hover/contextmenu spoofs).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function startFixturePageServer(options = {}) {
  const spoofContent = fs.readFileSync(path.join(FIXTURES_DIR, "spoof-page.html"), "utf8");
  const hoverContent = fs.readFileSync(path.join(FIXTURES_DIR, "hover-page.html"), "utf8");
  const hoverFrameContent = fs.readFileSync(path.join(FIXTURES_DIR, "hover-frame.html"), "utf8");
  // M1-S4 FIX-1 fixtures: overlay-page (P1-2 unified overlay states),
  // resolve-page (P1-2 needs-resolve in an anchor-isolated page) and
  // retarget-page (P1-3 explicit-selection identity).
  const overlayContent = fs.readFileSync(path.join(FIXTURES_DIR, "overlay-page.html"), "utf8");
  const resolveContent = fs.readFileSync(path.join(FIXTURES_DIR, "resolve-page.html"), "utf8");
  const retargetContent = fs.readFileSync(path.join(FIXTURES_DIR, "retarget-page.html"), "utf8");
  const server = createServer((request, response) => {
    const pathname = (request.url || "/").split("?")[0];
    if (pathname === "/trusted-types-overlay.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "require-trusted-types-for 'script'; trusted-types 'none'" });
      response.end(overlayContent.replace('</body>', '<img id="tt-drag-image" src="plain.jpg" width="120" height="90" draggable="true" style="position:fixed;left:380px;top:20px" alt="TT drag fixture"></body>'));
      return;
    }
    if (pathname === "/" || pathname === "/spoof-page.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(spoofContent);
      return;
    }
    if (pathname === "/hover-page.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(hoverContent);
      return;
    }
    if (pathname === "/hover-frame.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(hoverFrameContent);
      return;
    }
    if (pathname === "/overlay-page.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(overlayContent);
      return;
    }
    if (pathname === "/retarget-page.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(retargetContent);
      return;
    }
    if (pathname === "/resolve-page.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(resolveContent);
      return;
    }
    if (/\.(png|jpe?g|webp|gif)$/i.test(pathname)) {
      const type = /\.png$/i.test(pathname) ? "image/png"
        : /\.webp$/i.test(pathname) ? "image/webp"
          : /\.gif$/i.test(pathname) ? "image/gif" : "image/jpeg";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(TINY_PNG);
      return;
    }
    if (/^\/movie-(720|1080|480)p\.mp4$/.test(pathname)) {
      // Network-observation fixture only; playback uses separate real media QA.
      response.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
      response.end(Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  const requestedPort = options.port || 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  if (port >= DISCOVERY_FIRST_PORT && port <= DISCOVERY_LAST_PORT) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error(
      `Fixture page server picked port ${port} inside the LocalTransport discovery range; `
      + "refusing to run (the extension would probe it as a desktop candidate).",
    );
  }
  return {
    port,
    pageUrl: `http://127.0.0.1:${port}/spoof-page.html`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
