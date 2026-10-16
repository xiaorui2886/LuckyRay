// Isolated test HTTPS endpoint only. No credentials, signing or publishing.
import { createServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [root, descriptor] = process.argv.slice(2);
if (!root || !descriptor || !root.includes("luckyray-qualified-version-proof-")) throw Error("isolated-fixture-root-required");
const server = createServer({ cert: readFileSync(join(root, "tls-cert.pem")), key: readFileSync(join(root, "tls-key.pem")) }, (request, response) => {
  const mode = readFileSync(join(root, "mode.txt"), "utf8");
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (request.url === "/feed.json") {
    if (mode === "missing" || mode === "network") { response.writeHead(mode === "missing" ? 404 : 503).end(); return; }
    const bytes = readFileSync(join(root, `${mode === "bad-signature" ? "bad-signature" : "candidate"}.json`));
    response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length }).end(bytes);
  } else if (request.url === "/descriptor.json") {
    const bytes = readFileSync(descriptor);
    if (mode === "bad-artifact") bytes[bytes.length - 1] ^= 1;
    response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length }).end(bytes);
  } else { response.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1", () => writeFileSync(join(root, "ready.json"), JSON.stringify({ feed: `https://127.0.0.1:${server.address().port}/feed.json` }), { flag: "wx" }));
createInterface({ input: process.stdin }).on("line", line => { if (line === "close") server.close(() => process.exit(0)); })
  .on("close", () => server.close(() => process.exit(0)));
