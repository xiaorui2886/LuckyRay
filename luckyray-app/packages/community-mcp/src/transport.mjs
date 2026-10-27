// Versioned web grant transport; shared read-only proof/network helpers remain in materials-mcp.
import {
  MaterialError,
  inventory,
  selectTarget,
  httpJson,
} from "../../materials-mcp/src/transport.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const fail = (code) => {
  throw new MaterialError(code);
};
const normalize = (value) => resolve(value).replaceAll("\\", "/").toLowerCase();
export function validateConfig(config) {
  if (
    config?.authKind !== "library-mcp-scoped-v1" ||
    config?.profileProofVersion !== 3
  )
    fail("library-grant-required");
  if (
    !config ||
    config.version !== 1 ||
    typeof config.desktopExe !== "string" ||
    !isAbsolute(config.desktopExe) ||
    typeof config.profileRoot !== "string" ||
    !isAbsolute(config.profileRoot)
  )
    fail("configuration-required");
  if (
    [config.desktopExe, config.profileRoot].some(
      (p) => p.startsWith("\\\\") || p.startsWith("//"),
    )
  )
    fail("configuration-invalid");
  const fields = [
    "version",
    "desktopExe",
    "profileRoot",
    "authKind",
    "baseUrl",
    "clientId",
    "clientName",
    "libraryId",
    "expiresAt",
    "scope",
    "credentialFile",
    "profileProofVersion",
    "vaultId",
  ];
  if (Object.keys(config).some((k) => !fields.includes(k)))
    fail("configuration-invalid");
  if (
    typeof config.vaultId !== "string" ||
    !config.vaultId ||
    config.vaultId.length > 256 ||
    /[\x00-\x1f]/.test(config.vaultId)
  )
    fail("configuration-invalid");
  if (
    ![config.clientId, config.clientName, config.libraryId].every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 256 &&
        !/[\x00-\x1f]/.test(v),
    )
  )
    fail("configuration-invalid");
  if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= 0)
    fail("configuration-invalid");
  const scope = [
    "materials.search",
    "materials.inspect",
    "folders.read",
    "materials.import",
    "knowledge.search",
    "knowledge.read",
    "knowledge.import-markdown",
  ];
  if (
    !Array.isArray(config.scope) ||
    config.scope.length !== scope.length ||
    !scope.every((s) => config.scope.includes(s))
  )
    fail("configuration-invalid");
  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    fail("configuration-invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    Number(url.port) < 37418 ||
    Number(url.port) > 37468
  )
    fail("configuration-invalid");
  if (
    typeof config.credentialFile !== "string" ||
    !isAbsolute(config.credentialFile) ||
    config.credentialFile.startsWith("\\\\") ||
    config.credentialFile.startsWith("//")
  )
    fail("configuration-invalid");
  return Object.freeze({ ...config, scope: Object.freeze([...config.scope]) });
}
export async function scopedCredential(config) {
  let pair;
  try {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(
          new URL(
            "../../materials-mcp/src/read-credential.ps1",
            import.meta.url,
          ),
        ),
        "-Path",
        config.credentialFile,
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 32768 },
    );
    pair = JSON.parse(stdout);
  } catch {
    fail("authorization-unavailable");
  }
  return credentialForConfig(config, pair);
}
export function credentialForConfig(config, pair) {
  if (!pair || !/^[a-f0-9]{64}$/.test(pair.credential || ""))
    fail("credential-unusable");
  const { credential, ...metadata } = pair;
  const sealed = validateConfig({
    ...metadata,
    credentialFile: config.credentialFile,
  });
  for (const key of Object.keys(config)) {
    if (JSON.stringify(config[key]) !== JSON.stringify(sealed[key]))
      fail("pairing-binding-mismatch");
  }
  return credential;
}
const safeEqual = (a, b) =>
  /^[a-f0-9]{64}$/i.test(a || "") &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
export class LibraryTransport {
  constructor(config, deps = {}) {
    this.config = validateConfig(config);
    this.inventory = deps.inventory || inventory;
    this.credential = deps.credential || scopedCredential;
    this.http = deps.http || httpJson;
    this.now = deps.now || (() => Date.now() / 1000);
  }
  async bind() {
    const c = this.config;
    if (c.expiresAt <= this.now()) fail("pairing-expired");
    const target = selectTarget(this.config, await this.inventory());
    const ports = [
      ...new Set(
        target.ports.filter(
          (p) => Number.isInteger(p) && p >= 37418 && p <= 37468,
        ),
      ),
    ];
    if (!ports.length) fail("port-not-ready");
    // The desktop proves both physical identities and the selected vault using v3.
    // This dedicated web client never falls back to an older materials-only proof.
    const credential = await this.credential(c);
    if (!/^[a-f0-9]{64}$/.test(credential)) fail("credential-unusable");
    const verified = [];
    let invalid = false,
      unsupported = false,
      denied = false;
    for (const port of ports) {
      const nonce = randomBytes(32).toString("hex");
      let response;
      try {
        response = await this.http(port, "/api/v1/materials/proof", {
          body: {
            clientId: c.clientId,
            clientNonce: nonce,
            profileProofVersion: 3,
          },
          timeout: 2000,
        });
      } catch {
        continue;
      }
      const d = response.body?.data;
      if (response.status === 401 || response.status === 403) {
        denied = true;
        continue;
      }
      const version = 3;
      if (
        response.status !== 200 ||
        response.body?.ok !== true ||
        d?.protocolVersion !== version
      ) {
        unsupported = true;
        continue;
      }
      if (
        typeof d.profileRoot !== "string" ||
        typeof d.desktopExe !== "string" ||
        normalize(d.profileRoot) !== normalize(c.profileRoot) ||
        normalize(d.desktopExe) !== normalize(c.desktopExe)
      ) {
        invalid = true;
        continue;
      }
      const expected = createHmac("sha256", Buffer.from(credential, "hex"))
        .update(
          [
            "luckyray-local-transport-credential-v1",
            "library-mcp-proof",
            "v" + version,
            c.clientId,
            c.libraryId,
            c.vaultId,
            c.expiresAt,
            port,
            nonce,
            d.serverNonce,
            d.profileRoot,
            d.desktopExe,
          ].join("\0"),
        )
        .digest("hex");
      if (
        d.vaultId !== c.vaultId ||
        d.clientId !== c.clientId ||
        d.libraryId !== c.libraryId ||
        d.expiresAt !== c.expiresAt ||
        d.port !== port ||
        d.clientNonce !== nonce ||
        !/^[a-f0-9]{64}$/.test(d.serverNonce || "") ||
        !safeEqual(d.proof, expected)
      ) {
        invalid = true;
        continue;
      }
      verified.push({ target, port, credential });
    }
    if (invalid) fail("wrong-instance");
    if (verified.length > 1) fail("target-ambiguous");
    if (!verified.length)
      fail(
        denied
          ? "not-authorized"
          : unsupported
            ? "version-unsupported"
            : "port-not-ready",
      );
    const current = selectTarget(this.config, await this.inventory());
    if (
      current.pid !== target.pid ||
      current.created !== target.created ||
      !current.ports.includes(verified[0].port)
    )
      fail("target-changed");
    if (c.expiresAt <= this.now()) fail("pairing-expired");
    return verified[0];
  }
  async call(path, body) {
    const knowledge = [
      "/api/v1/library-mcp/knowledge/search",
      "/api/v1/library-mcp/knowledge/read",
      "/api/v1/library-mcp/knowledge/import-markdown",
    ].includes(path);
    if (
      !knowledge &&
      ![
        "/api/v1/tools/run",
        "/api/v1/assets/import-file",
        "/api/v1/folders",
      ].includes(path)
    )
      fail("operation-denied");
    if (
      path === "/api/v1/tools/run" &&
      !["materials.search", "materials.inspect"].includes(body?.toolId)
    )
      fail("operation-denied");
    const binding = await this.bind();
    let out;
    try {
      out = await this.http(binding.port, path, {
        body,
        credential: binding.credential,
        timeout:
          path.endsWith("import-file") || path.endsWith("import-markdown")
            ? 135000
            : 30000,
      });
    } catch (e) {
      if (path.endsWith("import-file") || path.endsWith("import-markdown"))
        fail("import-outcome-unknown");
      throw e;
    }
    if (out.status === 401 || out.status === 403) fail("not-authorized");
    if (
      out.status === 404 ||
      out.status === 405 ||
      out.body?.error?.code === "tool-unavailable" ||
      out.body?.error?.code === "tool-not-found"
    )
      fail("version-unsupported");
    if (
      knowledge &&
      out.status >= 300 &&
      [
        "request-id-conflict",
        "import-outcome-unknown",
        "note-name-exists",
        "imported-note-changed",
        "knowledge-parent-missing",
        "markdown-file-required",
        "markdown-download-failed",
        "markdown-utf8-required",
        "note-response-too-large",
      ].includes(out.body?.error?.code)
    )
      fail(out.body.error.code);
    if (out.status >= 300 || out.body?.ok !== true)
      fail(
        path.endsWith("import-file")
          ? "import-rejected"
          : "desktop-request-failed",
      );
    if (
      ["/api/v1/folders", "/api/v1/assets/import-file"].includes(path) &&
      out.body.data?.libraryId !== this.config.libraryId
    )
      fail("response-library-mismatch");
    if (knowledge && out.body.data?.vaultId !== this.config.vaultId)
      fail("response-vault-mismatch");
    return out.body.data;
  }
  async status() {
    const b = await this.bind();
    return {
      ready: true,
      protocolVersion: 3,
      pid: b.target.pid,
      port: b.port,
      libraryId: this.config.libraryId,
      vaultId: this.config.vaultId,
      expiresAt: this.config.expiresAt,
      scope: this.config.scope,
      authentication: this.config.authKind,
    };
  }
}
