import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { serve } from "../src/protocol.mjs";
import { TOOLS } from "../src/library.mjs";
import { MaterialError } from "../../materials-mcp/src/transport.mjs";
async function exchange(messages, run = async () => ({ ok: true })) {
  const input = new PassThrough(),
    output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk));
  const ended = once(output, "end");
  await serve({ run }, input, output, { tools: TOOLS });
  for (const m of messages)
    input.write(typeof m === "string" ? m + "\n" : JSON.stringify(m) + "\n");
  input.end();
  await ended;
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}
const init = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];
test("web protocol negotiates and lists only eight library tools", async () => {
  const out = await exchange([
    ...init,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(out[0].result.protocolVersion, "2025-06-18");
  assert.equal(out[1].result.tools.length, 8);
  assert.deepEqual(
    out[1].result.tools.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
  assert.ok(
    out[1].result.tools.every(
      (t) => !/(agent|terminal|codex|zcode)/i.test(t.name),
    ),
  );
});
test("web protocol rejects calls before initialization and duplicate request IDs", async () => {
  let calls = 0;
  const out = await exchange(
    [
      { jsonrpc: "2.0", id: 0, method: "tools/call" },
      ...init,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_notes" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/call" },
    ],
    async () => {
      calls++;
      return { notes: [] };
    },
  );
  assert.equal(out[0].error.message, "Initialize first");
  assert.equal(out.at(-1).error.message, "Duplicate outstanding request id");
  assert.equal(calls, 1);
});
test("the pinned tunnel can reuse completed IDs across repeated legacy handshakes", async () => {
  const out = await exchange([
    ...init,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ...init,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(out.length, 4);
  assert.ok(out.every((r) => !r.error));
  assert.equal(out[3].result.tools.length, 8);
});
const modern = { _meta: {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} };
test("modern discovery and independent calls do not open the legacy gate", async () => {
  const out = await exchange([
    { jsonrpc: "2.0", id: 0, method: "server/discover", params: modern },
    { jsonrpc: "2.0", id: 0, method: "tools/list", params: modern },
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    { jsonrpc: "2.0", id: 0, method: "tools/list", params: { _meta: { ...modern._meta, "io.modelcontextprotocol/protocolVersion": "2027-01-01" } } },
    { jsonrpc: "2.0", id: 0, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } },
  ]);
  assert.equal(out[0].result.resultType, "complete");
  assert.ok(out[0].result.supportedVersions.includes("2026-07-28"));
  assert.equal(out[1].result.tools.length, 8);
  assert.equal(out[2].error.message, "Initialize first");
  assert.equal(out[3].error.code, -32022);
  assert.equal(out[4].error.code, -32602);
});
test("web protocol finishes accepted work after EOF and redacts arbitrary errors", async () => {
  const out = await exchange(
    [
      ...init,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_note" },
      },
    ],
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw Error("private credential text");
    },
  );
  assert.equal(out.at(-1).result.content[0].text, "operation-failed");
  const known = await exchange(
    [...init, { jsonrpc: "2.0", id: 2, method: "tools/call" }],
    async () => {
      throw new MaterialError("not-authorized");
    },
  );
  assert.equal(known.at(-1).result.content[0].text, "not-authorized");
});
