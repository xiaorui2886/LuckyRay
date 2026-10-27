import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import {
  LibraryTransport as MaterialTransport,
  validateConfig,
  credentialForConfig,
} from "../src/transport.mjs";
import { LibraryTools, TOOLS, markdownInput, fileInput } from "../src/library.mjs";
const c = {
  version: 1,
  authKind: "library-mcp-scoped-v1",
  profileProofVersion: 3,
  desktopExe: resolve("/fixture/luckyray-app.exe"),
  profileRoot: resolve("/fixture/profile"),
  credentialFile: resolve("/fixture/credential.dpapi"),
  baseUrl: "http://127.0.0.1:37419",
  clientId: "a".repeat(64),
  clientName: "Web",
  libraryId: "library-a",
  vaultId: "vault-a",
  expiresAt: 2000000000,
  scope: [
    "materials.search",
    "materials.inspect",
    "folders.read",
    "materials.import",
    "knowledge.search",
    "knowledge.read",
    "knowledge.import-markdown",
  ],
};
const credential = "c".repeat(64),
  target = { exe: c.desktopExe, pid: 7, created: "fixture", ports: [37419] };
function transport(mutate = (d) => d, operationResponse) {
  const calls = [];
  const http = async (port, path, { body, credential: bearer } = {}) => {
    calls.push({ path, bearer });
    if (path.endsWith("/proof")) {
      const d = {
        protocolVersion: 3,
        clientId: c.clientId,
        libraryId: c.libraryId,
        vaultId: c.vaultId,
        expiresAt: c.expiresAt,
        port,
        clientNonce: body.clientNonce,
        serverNonce: "b".repeat(64),
        profileRoot: c.profileRoot,
        desktopExe: c.desktopExe,
      };
      d.proof = createHmac("sha256", Buffer.from(credential, "hex"))
        .update(
          [
            "luckyray-local-transport-credential-v1",
            "library-mcp-proof",
            "v3",
            d.clientId,
            d.libraryId,
            d.vaultId,
            d.expiresAt,
            d.port,
            d.clientNonce,
            d.serverNonce,
            d.profileRoot,
            d.desktopExe,
          ].join("\0"),
        )
        .digest("hex");
      return { status: 200, body: { ok: true, data: mutate(d) } };
    }
    return operationResponse ?? {
      status: 200,
      body: { ok: true, data: { vaultId: c.vaultId, notes: [] } },
    };
  };
  return {
    calls,
    client: new MaterialTransport(c, {
      inventory: async () => [target],
      credential: async () => credential,
      verifyProfile: async () => {
        throw Error("v3 must not open a DB");
      },
      http,
      now: () => 100,
    }),
  };
}
test("unified grant must name both fixed libraries, all scopes and v3", () => {
  assert.equal(validateConfig(c).vaultId, "vault-a");
  for (const changed of [
    { vaultId: "" },
    { profileProofVersion: 2 },
    { scope: c.scope.slice(0, 4) },
    { authKind: "materials-mcp-scoped-v1" },
  ])
    assert.throws(() => validateConfig({ ...c, ...changed }));
  assert.equal(
    credentialForConfig(c, { ...c, credentialFile: undefined, credential }),
    credential,
  );
  assert.throws(() =>
    credentialForConfig(
      { ...c, vaultId: "other" },
      { ...c, credentialFile: undefined, credential },
    ),
  );
});
test("v3 proves knowledge target before any credential-bearing request", async () => {
  const { calls, client } = transport();
  await client.call("/api/v1/library-mcp/knowledge/search", { query: "" });
  assert.equal(calls[0].bearer, undefined);
  assert.equal(calls[1].bearer, credential);
  for (const mutate of [
    (d) => ({ ...d, vaultId: "other" }),
    (d) => ({ ...d, protocolVersion: 2 }),
    (d) => ({ ...d, profileRoot: "/wrong" }),
  ]) {
    const { calls, client } = transport(mutate);
    await assert.rejects(
      client.call("/api/v1/library-mcp/knowledge/search", {}),
    );
    assert.ok(calls.every((c) => !c.bearer));
  }
});
test("new scope cannot invoke editing, deletion, terminal or agent endpoints", async () => {
  const { client, calls } = transport();
  for (const path of [
    "/api/v1/knowledge/documents",
    "/api/v1/knowledge/replace",
    "/api/v1/library-mcp/knowledge/delete",
    "/api/v1/agents/run",
  ])
    await assert.rejects(client.call(path, {}));
  assert.equal(calls.length, 0);
});
test("markdown requires HTTPS original MD name and stable request id", () => {
  const valid = {
    url: "https://example.com/file?temporary=1",
    fileName: "中文.md",
    requestId: "request-001",
  };
  assert.deepEqual(markdownInput(valid), valid);
  for (const diff of [
    { fileName: "a.exe" },
    { fileName: "../a.md" },
    { url: "http://127.0.0.1/file" },
    { requestId: "../foo" },
    { folder: "../x" },
    { folder: "a\\b" },
    { folder: "/a" },
    { folder: "a//b" },
  ])
    assert.throws(() => markdownInput({ ...valid, ...diff }));
  assert.equal(
    markdownInput({ ...valid, folder: "资料/本周" }).folder,
    "资料/本周",
  );
});

test("missing knowledge parent is reported explicitly without retrying the import", async () => {
  const {client, calls} = transport(undefined, {
    status: 400,
    body: {ok: false, error: {code: "knowledge-parent-missing"}},
  });
  await assert.rejects(client.call("/api/v1/library-mcp/knowledge/import-markdown", {
    url: "https://example.com/synthetic.md", fileName: "中文.md",
    requestId: "missing-parent-001", folder: "不存在",
  }), {code: "knowledge-parent-missing"});
  assert.equal(calls.filter(c => c.path.endsWith("import-markdown")).length, 1);
});

test("an unknown Markdown outcome stays unknown and is not retried or reported as success", async () => {
  const {client, calls} = transport(undefined, {
    status: 409,
    body: {ok: false, error: {code: "import-outcome-unknown"}},
  });
  const tools = new LibraryTools(client, () => assert.fail("unknown import is not success"));
  await assert.rejects(tools.run("import_markdown", {
    url: "https://example.com/synthetic.md", fileName: "中文.md",
    requestId: "existing-pending-001",
  }), {code: "import-outcome-unknown"});
  assert.equal(calls.filter(c => c.path.endsWith("import-markdown")).length, 1);
});

test("Markdown folder contract distinguishes existing knowledge directories from materials", () => {
  const tool = TOOLS.find(t => t.name === "import_markdown");
  assert.match(tool.description, /Omit folder to use the vault root/);
  assert.match(tool.inputSchema.properties.folder.description, /Existing relative directory/);
  assert.match(tool.inputSchema.properties.folder.description, /not a material-library folder/);
});
test("import requires a real note receipt and records web success only afterward", async () => {
  let seen = 0,
    paths = [];
  const receipt = {
    noteId: "note-1",
    vaultId: "vault-a",
    disposition: "imported",
    contentSha256: "f".repeat(64),
    warnings: ["referenced-files-not-imported"],
  };
  const tool = new LibraryTools(
    {
      call: async (path) => {
        paths.push(path);
        return receipt;
      },
    },
    () => seen++,
  );
  const args = {
    url: "https://example.com/file",
    fileName: "example.md",
    requestId: "request-001",
  };
  assert.deepEqual(await tool.run("import_markdown", args), receipt);
  assert.equal(seen, 1);
  assert.equal(paths[0], "/api/v1/library-mcp/knowledge/import-markdown");
  const bad = new LibraryTools(
    { call: async () => ({ queued: true }) },
    () => seen++,
  );
  await assert.rejects(bad.run("import_markdown", args));
  assert.equal(seen, 1);
});
test("tool descriptions expose only bounded library capabilities", () => {
  assert.equal(TOOLS.length, 8);
  assert.ok(TOOLS.every((t) => t.inputSchema.additionalProperties === false));
  assert.ok(
    !TOOLS.some((t) => /delete|edit|terminal|lsh|zcode|codex/.test(t.name)),
  );
});
test("ChatGPT file parameters keep names and still use the existing importer checks", () => {
  const file = { download_url: "https://files.oaiusercontent.com/example?signature=synthetic", file_id: "file_synthetic", file_name: "中文资料.md", mime_type: "text/markdown" };
  assert.deepEqual(fileInput({ file }), { url: file.download_url, fileName: file.file_name });
  assert.equal(markdownInput({ file, requestId: "web-file-001" }).fileName, "中文资料.md");
  for (const args of [
    { file, url: "https://example.com/a.md" },
    { file: { ...file, download_url: "http://127.0.0.1/private" } },
    { file: { ...file, file_name: "../private.md" } },
    { file: { ...file, file_id: "" } },
    { file: { ...file, cookie: "not-accepted" } },
    { file: { download_url: file.download_url, file_id: file.file_id } },
  ]) assert.throws(() => fileInput(args));
  assert.equal(fileInput({ file: { download_url: file.download_url, file_id: file.file_id }, fileName: "original.png" }).fileName, "original.png");
  for (const name of ["import_file", "import_markdown"]) {
    const tool = TOOLS.find(t => t.name === name);
    assert.deepEqual(tool._meta["openai/fileParams"], ["file"]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties.file.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
    assert.deepEqual(tool.inputSchema.properties.file.required, ["download_url", "file_id"]);
  }
});
