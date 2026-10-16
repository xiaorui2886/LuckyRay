// LuckyRay-owned DSH plugin compatibility authority (COMPAT-R1).
//
// Layered checks decide which DSH profile/bundle plugins may load, and a
// host-owned guard patch disables quarantined loader entries before import.
// Nothing here executes third-party code: static layers read manifests and
// source bytes only, and every verdict states its evidence scope.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_COMPAT_STATE_VERSION = 1;
export const PLUGIN_COMPAT_STATE_FILENAME = "luckyray-plugin-compat-v1.json";
export const PLUGIN_COMPAT_GUARD_FILENAME = "luckyray-plugin-compat-guard.patch.yml";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SCAN_FILE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 40;
const MAX_SCAN_DEPTH = 4;
const OFFICIAL_SCOPE = "@deepseek-ai/";

export const COMPAT_CHECKER_VERSION = 4;

function stateFailure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the profile manifest (package.json) that owns `dsh.profile.bundles`. */
export function parseProfileManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw stateFailure("plugin-compat-manifest-invalid");
  }
  if (!isPlainObject(manifest)) throw stateFailure("plugin-compat-manifest-invalid");
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some((name) => typeof name !== "string" || name.length === 0 || name.length > 214)) {
    throw stateFailure("plugin-compat-manifest-invalid");
  }
  const dependencies = isPlainObject(manifest.dependencies)
    ? Object.fromEntries(Object.entries(manifest.dependencies).filter(([key, value]) => (
      typeof key === "string" && typeof value === "string"
    )))
    : {};
  return { bundles: [...bundles], dependencies };
}

/**
 * Extract `insert` loader entries from a bundle patch (`cordis.patch.yml`).
 * DSH patch files are a controlled YAML subset; this parser stays line-level
 * and never evaluates anything (notably `!!js` expressions stay opaque
 * bytes). Block style, single-line flow style, multi-line flow arrays and
 * quoted names are all accepted with identical results. When a mount cannot
 * be resolved to a real loader entry id, the fallback record is explicitly
 * marked unresolved — callers must never emit it as a working guard id.
 */
export function parseBundlePatchEntries(text, fallbackPackageName) {
  const entries = [];
  let current = null;
  let flowBuffer = null;
  const pushCurrent = () => {
    if (current) entries.push(current);
    current = null;
  };
  const addEntry = (id, name, resolved) => {
    pushCurrent();
    entries.push({ entryId: id, packageName: name ?? null, resolved });
  };
  const emitFlowItems = (body) => {
    for (const rawItem of body.split(/\}\s*,\s*/u)) {
      const item = rawItem.replace(/[{}\[\]]/gu, " ");
      const id = /\bid\s*:\s*['"]?([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})['"]?/u.exec(item);
      if (!id) continue;
      const name = /\bname\s*:\s*['"]?([A-Za-z0-9@][A-Za-z0-9@/_.-]{0,213})['"]?/u.exec(item);
      addEntry(id[1], name ? name[1] : null, true);
    }
  };
  const lines = String(text).split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\t/g, "  ");
    if (flowBuffer !== null) {
      flowBuffer += ` ${line}`;
      if (line.includes("]")) {
        const body = flowBuffer.slice(flowBuffer.indexOf("[") + 1, flowBuffer.lastIndexOf("]"));
        emitFlowItems(body);
        flowBuffer = null;
      }
      continue;
    }
    if (/^\s*#/u.test(line)) continue;
    // Flow-style inline inserts are self-contained: parse regardless of any
    // surrounding block context.
    const flowInline = /^(\s*)-?\s*insert\s*:\s*\[(.*)\]\s*$/u.exec(line);
    if (flowInline) {
      pushCurrent();
      emitFlowItems(flowInline[2]);
      continue;
    }
    // Multi-line flow arrays: `insert:` (or `insert: [`) opening a bracket
    // that closes on a later line.
    const flowOpen = /^(\s*)-?\s*insert\s*:\s*\[?\s*$/u.exec(line);
    if (flowOpen && (line.includes("[") || lineIndex + 1 < lines.length)) {
      if (line.includes("[")) {
        pushCurrent();
        flowBuffer = line;
        continue;
      }
    }
    // Block-style insert header. A later top-level key ends the insert scope
    // so plain `- id:` overrides rows (official bundle patches use those)
    // are never collected as plugin entries.
    const insertHeader = /^(\s*)-?\s*insert\s*:\s*$/u.exec(line);
    if (insertHeader) {
      pushCurrent();
      current = { insertDepth: insertHeader[1].length + 1, open: true };
      continue;
    }
    if (current?.open) {
      const inserted = /^(\s*)-\s+id\s*:\s*['"]?([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})['"]?\s*$/u.exec(line);
      if (inserted && inserted[1].length >= current.insertDepth) {
        const insertDepth = current.insertDepth;
        pushCurrent();
        current = { entryId: inserted[2], packageName: null, resolved: true, insertDepth, open: true };
        continue;
      }
      const named = /^(\s+)name\s*:\s*['"]?([A-Za-z0-9@][A-Za-z0-9@/_.-]{0,213})['"]?\s*$/u.exec(line);
      if (current?.entryId && named) {
        current.packageName = named[2];
        continue;
      }
      if (line.trim().length > 0 && /^[\S]/u.test(line) && !/^\s/u.test(line)) {
        pushCurrent();
      }
      continue;
    }
    if (line.trim().length > 0) {
      pushCurrent();
    }
  }
  if (flowBuffer !== null) {
    // Unterminated flow array: nothing verifiable was declared.
    pushCurrent();
  }
  pushCurrent();
  const collected = entries.filter((entry) => typeof entry.entryId === "string");
  if (collected.length === 0) {
    // A plugin whose mount declaration cannot be parsed must never become
    // invisible to the guard: record the package scope as UNRESOLVED —
    // callers keep it visible but must not emit a working guard id for it.
    return [{ entryId: fallbackPackageName, packageName: fallbackPackageName, resolved: false }];
  }
  return collected.map((entry) => ({
    entryId: entry.entryId,
    // `||` (not `??`): an empty-string fallback from layer scans must fall
    // through to the entry id so unnamed mounts never turn invisible.
    packageName: entry.packageName || fallbackPackageName || entry.entryId,
    resolved: entry.resolved === true,
  }));
}

function extractNamedImports(source) {
  // Static ESM shapes only. Dynamic import()/require() are runtime behaviour
  // and stay outside the static verdict on purpose.
  const imports = [];
  const patterns = [
    /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu,
    /\bexport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      for (const rawName of match[1].split(",")) {
        const name = rawName.split(/\bas\b/u)[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) && name !== "default" && name !== "type") {
          imports.push({ name, specifier });
        }
      }
    }
  }
  return imports;
}

function extractNamedExports(source) {
  const exports = new Set();
  let inexact = false;
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const rawName of match[1].split(",")) {
      const parts = rawName.split(/\bas\b/u);
      const exported = parts.length > 1 ? parts[parts.length - 1].trim() : parts[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exported) && exported !== "default") exports.add(exported);
    }
  }
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)) {
    exports.add(match[1]);
  }
  if (/\bexport\s+\*\s*from\b/u.test(source) || /\bexport\s+\*\s+as\b/u.test(source)) inexact = true;
  return { exports, inexact };
}

function resolveFile(entryFile) {
  if (typeof entryFile !== "string" || entryFile.length === 0) return null;
  // Known non-JS data/specifier targets keep their extension: inventing a
  // .js suffix would turn a real file into a phantom "missing module".
  if (/\.(json|jsonc|css|wasm|txt|ya?ml|html?|node|map)$/iu.test(entryFile)) {
    return entryFile;
  }
  let candidate = entryFile;
  for (const suffix of [".js", ".mjs", "/index.js", "/index.mjs"]) {
    if (candidate.endsWith(suffix)) return candidate;
  }
  return `${candidate}.js`;
}

async function readBounded(path, limitBytes) {
  // A READ ERROR means absent/unreadable (null). A successfully read EMPTY
  // file is a real module (empty buffer) — callers distinguish content gaps
  // from IO gaps on that basis.
  const bytes = await readFile(path).catch(() => null);
  if (!bytes || bytes.length > limitBytes) return null;
  return bytes;
}

/**
 * Walk a plugin's own module graph (bounded) and collect named imports from
 * official runtime packages. Relative imports resolve against the importing
 * module's directory, not the package root. Reads bytes only; never imports
 * or evaluates. Returns what was actually scanned so truncated or empty
 * walks can downgrade the verdict honestly.
 */
export async function scanPluginStaticImports(packageDir, manifest) {
  const entry = resolveFile(manifest?.main ?? manifest?.exports?.["."]?.default)
    ?? resolveFile(manifest?.exports?.["."]?.import);
  if (!entry) return { ok: false, reason: "plugin-compat-entry-unreadable", imports: [] };
  const entryNormalized = entry.replace(/^[./]+/u, "");
  const queue = [{ file: entryNormalized, dir: dirnameOf(entryNormalized), depth: 0, referencedBy: null }];
  const seen = new Set();
  const imports = [];
  const missingReferences = [];
  const graphDigest = createHash("sha256");
  let commonjsOrDynamic = false;
  let files = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (files >= MAX_SCAN_FILES) {
      truncated = true;
      break;
    }
    const { file, dir, depth, referencedBy } = queue.shift();
    if (depth > MAX_SCAN_DEPTH) {
      truncated = true;
      continue;
    }
    const normalized = file.replace(/\\/gu, "/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const bytes = await readBounded(join(packageDir, normalized), MAX_SCAN_FILE_BYTES);
    if (!bytes) {
      if (referencedBy) {
        // A module the entry graph STATICALLY references but that is absent
        // is a known gap in the verified bytes — recorded, never silently
        // skipped into a fresh pass.
        missingReferences.push({ from: referencedBy, file: normalized });
      }
      continue;
    }
    files += 1;
    graphDigest.update(normalized);
    graphDigest.update(bytes);
    const source = bytes.toString("utf8");
    for (const item of extractNamedImports(source)) {
      imports.push(item);
      if (item.specifier.startsWith(".") || item.specifier.startsWith("/")) {
        const resolved = resolveRelative(dir, item.specifier);
        if (resolved) queue.push({ file: resolved.file, dir: resolved.dir, depth: depth + 1, referencedBy: normalized });
      }
    }
    // Walk every import FORM, not just named ones: side-effect imports
    // (import "./x.js"), default/namespace imports and re-exports all pull
    // local modules into the scan graph.
    const localPatterns = [
      /\bimport\s+["']([^"']+)["']/gu,
      /\bimport\s+[\w*${},\s]+from\s+["']([^"']+)["']/gu,
      /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?\s*)?(?:[\w{},\s]+from\s+)?["']([^"']+)["']/gu,
    ];
    for (const pattern of localPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
        const resolved = resolveRelative(dir, specifier);
        if (resolved) queue.push({ file: resolved.file, dir: resolved.dir, depth: depth + 1, referencedBy: normalized });
      }
    }
    if (/\brequire\s*\(/u.test(source) || /\bimport\s*\(/u.test(source)) {
      commonjsOrDynamic = true;
    }
  }
  return { ok: true, reason: null, imports, commonjsOrDynamic, filesScanned: files, truncated, missingReferences, graphDigest: graphDigest.digest("hex") };
}

function dirnameOf(file) {
  const normalized = file.replace(/\\/gu, "/");
  const at = normalized.lastIndexOf("/");
  return at < 0 ? "" : normalized.slice(0, at);
}

/** Resolve a relative import specifier against the importing module dir. */
function resolveRelative(dir, specifier) {
  const raw = specifier.replace(/\\/gu, "/");
  const stack = dir.length > 0 ? dir.split("/") : [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  if (stack.length === 0) return null;
  const file = stack.join("/");
  return { file: resolveFile(file) ?? `${file}.js`, dir: dirnameOf(file) };
}

/** Collect the actual named exports of one official runtime package. */
export async function collectRuntimePackageExports(runtimeRoot, packageName) {
  if (!packageName.startsWith(OFFICIAL_SCOPE)) return null;
  const packageDir = join(runtimeRoot, "host", "node_modules", packageName);
  const manifestBytes = await readBounded(join(packageDir, "package.json"), 64 * 1024);
  if (!manifestBytes) return null;
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return null;
  }
  const entry = resolveFile(manifest?.main ?? manifest?.exports?.["."]?.default);
  if (!entry) return null;
  const bytes = await readBounded(join(packageDir, entry), 4 * MAX_SCAN_FILE_BYTES);
  if (!bytes) return null;
  const { exports, inexact } = extractNamedExports(bytes.toString("utf8"));
  return { version: typeof manifest?.version === "string" ? manifest.version : null, exports: [...exports], inexact };
}

function comparePrereleaseAware(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value ?? "");
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  if (left[3] === right[3]) return 0;
  if (left[3] === null) return 1;
  if (right[3] === null) return -1;
  return comparePrereleaseTags(left[3], right[3]);
}

/** SemVer precedence for prerelease identifiers: numeric fields compare
 * numerically, numeric < alphanumeric, alphanumeric compare in ASCII order,
 * a longer identifier set wins when all shared fields are equal. */
function comparePrereleaseTags(a, b) {
  const split = (tag) => tag.split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Standard semver satisfies with correct prerelease gating (no string compare). */
export function satisfiesRange(version, range) {
  if (typeof version !== "string" || typeof range !== "string") return null;
  const parsedVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!parsedVersion) return null;
  const versionTuple = [Number(parsedVersion[1]), Number(parsedVersion[2]), Number(parsedVersion[3])];
  const versionPrerelease = parsedVersion[4] ?? null;
  let sawUnparsable = false;
  let anyParsed = false;
  for (const alternative of range.split("||").map((part) => part.trim())) {
    const clauses = alternative.split(/\s+/u).filter((clause) => clause.length > 0);
    if (clauses.length === 0) continue;
    let alternativeOk = true;
    let alternativeParsed = false;
    const comparatorVersions = [];
    for (const clause of clauses) {
      const match = /^(\^|~|>=?|<=?|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s*(<|<=)\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?$/.exec(clause);
      if (!match) {
        sawUnparsable = true;
        continue;
      }
      alternativeParsed = true;
      const operator = match[1] ?? "=";
      comparatorVersions.push(match[2]);
      const comparison = comparePrereleaseAware(version, match[2]);
      if (comparison === null) {
        sawUnparsable = true;
        continue;
      }
      let clauseOk;
      switch (operator) {
        case "^": {
          if (comparison < 0) clauseOk = false;
          else {
            const parsedLower = /^(\d+)\.(\d+)\.(\d+)/u.exec(match[2]);
            let upper;
            if (!parsedLower) upper = match[2];
            else if (Number(parsedLower[1]) > 0) upper = `${Number(parsedLower[1]) + 1}.0.0`;
            else if (Number(parsedLower[2]) > 0) upper = `0.${Number(parsedLower[2]) + 1}.0`;
            else upper = `0.0.${Number(parsedLower[3]) + 1}`;
            const upperComparison = comparePrereleaseAware(version, upper);
            clauseOk = upperComparison === null ? false : upperComparison < 0;
          }
          break;
        }
        case "~": {
          if (comparison < 0) clauseOk = false;
          else {
            const parsedLower = /^(\d+)\.(\d+)\.(\d+)/u.exec(match[2]);
            const upper = parsedLower
              ? `${Number(parsedLower[1])}.${Number(parsedLower[2]) + 1}.0`
              : match[2];
            const upperComparison = comparePrereleaseAware(version, upper);
            clauseOk = upperComparison === null ? false : upperComparison < 0;
          }
          break;
        }
        case ">": clauseOk = comparison > 0; break;
        case ">=": clauseOk = comparison >= 0; break;
        case "<": clauseOk = comparison < 0; break;
        case "<=": clauseOk = comparison <= 0; break;
        default: clauseOk = comparison === 0;
      }
      if (match[3] && match[4]) {
        comparatorVersions.push(match[4]);
        const upperComparison = comparePrereleaseAware(version, match[4]);
        if (upperComparison === null) {
          sawUnparsable = true;
          continue;
        }
        clauseOk = clauseOk && (match[3] === "<" ? upperComparison < 0 : upperComparison <= 0);
      }
      if (!clauseOk) {
        alternativeOk = false;
        break;
      }
    }
    // npm prerelease gate: a prerelease version only satisfies an alternative
    // that carries a prerelease comparator on the same [major, minor, patch].
    if (versionPrerelease !== null && alternativeOk) {
      const gated = comparatorVersions.some((comparator) => {
        const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(comparator);
        return parsed !== null && parsed[4] !== undefined
          && Number(parsed[1]) === versionTuple[0]
          && Number(parsed[2]) === versionTuple[1]
          && Number(parsed[3]) === versionTuple[2];
      });
      if (!gated) alternativeOk = false;
    }
    if (alternativeParsed && alternativeOk) return true;
    if (alternativeParsed) anyParsed = true;
  }
  return anyParsed ? false : (sawUnparsable ? null : false);
}

/** The L0 static verdict for one plugin against the installed runtime. */
export async function staticPluginVerdict({ plugin, runtimeRoot, nodeVersion = process.version }) {
  const findings = [];
  const manifestBytes = await readBounded(join(plugin.packageDir, "package.json"), 64 * 1024);
  if (!manifestBytes) {
    return { outcome: "unknown", reason: "plugin-compat-package-unreadable", findings, evidence: "static" };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return { outcome: "unknown", reason: "plugin-compat-package-invalid", findings, evidence: "static" };
  }
  // Exact per-plugin identity covers the WHOLE actually-scanned graph plus
  // the package's declared mount patch: a same-version edit of the manifest,
  // the entry, ANY scanned sub-module, or the patch bytes changes it.
  const declaredPatchPath = typeof manifest?.dsh?.bundle?.patch === "string"
    && manifest.dsh.bundle.patch.length > 0
    && !manifest.dsh.bundle.patch.includes("..")
    ? manifest.dsh.bundle.patch.replace(/^[./]+/u, "")
    : "cordis.patch.yml";
  const patchBytes = await readBounded(join(plugin.packageDir, declaredPatchPath), 128 * 1024);
  const scanForDigest = await scanPluginStaticImports(plugin.packageDir, manifest);
  const digest = digestOf(Buffer.concat([
    manifestBytes,
    Buffer.from(scanForDigest.graphDigest ?? "", "utf8"),
    patchBytes ?? Buffer.alloc(0),
  ]));
  if (typeof manifest?.engines?.node === "string" && typeof nodeVersion === "string" && nodeVersion.startsWith("v")) {
    const engineSatisfied = satisfiesRange(nodeVersion.slice(1), manifest.engines.node);
    if (engineSatisfied === false) {
      findings.push({ kind: "engine-node", range: manifest.engines.node, runtimeVersion: nodeVersion });
    } else if (engineSatisfied === null) {
      findings.push({ kind: "engine-node-unparsable", range: manifest.engines.node, runtimeVersion: nodeVersion });
    }
  }
  if (isPlainObject(manifest.peerDependencies)) {
    const optionalPeers = isPlainObject(manifest.peerDependenciesMeta)
      ? manifest.peerDependenciesMeta
      : {};
    for (const [dependency, range] of Object.entries(manifest.peerDependencies)) {
      if (!dependency.startsWith(OFFICIAL_SCOPE) || typeof range !== "string") continue;
      const runtime = await collectRuntimePackageExports(runtimeRoot, dependency);
      const optional = optionalPeers?.[dependency]?.optional === true;
      if (!runtime?.version) {
        // An optional peer may legitimately be absent; it stays unverified,
        // never pass, because we cannot see what the plugin would import.
        findings.push(optional
          ? { kind: "peer-optional-missing", dependency, range }
          : { kind: "dependency-missing", dependency, range });
        continue;
      }
      const satisfied = satisfiesRange(runtime.version, range);
      if (satisfied === false) {
        findings.push({ kind: "dependency-range", dependency, range, runtimeVersion: runtime.version });
      } else if (satisfied === null) {
        findings.push({ kind: "dependency-unparsable", dependency, range, runtimeVersion: runtime.version });
      }
    }
  }
  const scan = await scanPluginStaticImports(plugin.packageDir, manifest);
  if (scan.ok) {
    if (scan.filesScanned === 0) {
      findings.push({ kind: "scan-limited", reason: "plugin-compat-entry-bytes-unreadable" });
    }
    if (scan.truncated) {
      findings.push({ kind: "scan-limited", reason: "plugin-compat-scan-budget-exhausted" });
    }
    for (const missing of scan.missingReferences ?? []) {
      findings.push({ kind: "scan-limited", reason: `plugin-compat-static-module-missing:${missing.from}->${missing.file}` });
    }
    const runtimeCache = new Map();
    for (const item of scan.imports) {
      if (!item.specifier.startsWith(OFFICIAL_SCOPE)) continue;
      if (!runtimeCache.has(item.specifier)) {
        runtimeCache.set(item.specifier, await collectRuntimePackageExports(runtimeRoot, item.specifier));
      }
      const runtime = runtimeCache.get(item.specifier);
      if (!runtime) {
        findings.push({ kind: "import-package-missing", dependency: item.specifier, name: item.name });
      } else if (runtime.exports.includes(item.name)) {
        continue;
      } else if (runtime.inexact) {
        findings.push({ kind: "import-unverifiable", dependency: item.specifier, name: item.name });
      } else {
        findings.push({ kind: "import-missing", dependency: item.specifier, name: item.name });
      }
    }
    // require()/dynamic import() escape the static verdict by design; a
    // plugin relying on them must read "unverified", never "pass".
    if (scan.commonjsOrDynamic) {
      findings.push({ kind: "scan-limited", reason: "plugin-compat-nonstatic-module-loading" });
    }
  } else if (scan.reason) {
    findings.push({ kind: "scan-limited", reason: scan.reason });
  }
  const blocking = findings.filter((finding) => (
    finding.kind === "import-missing"
    || finding.kind === "import-package-missing"
    || finding.kind === "dependency-missing"
    || finding.kind === "dependency-range"
    || finding.kind === "engine-node"
  ));
  const unverifiable = findings.filter((finding) => (
    finding.kind === "import-unverifiable"
    || finding.kind === "dependency-unparsable"
    || finding.kind === "engine-node-unparsable"
    || finding.kind === "peer-optional-missing"
    || finding.kind === "scan-limited"
  ));
  const outcome = blocking.length > 0 ? "fail" : (unverifiable.length > 0 ? "unknown" : "pass");
  return {
    outcome,
    reason: blocking[0]
      ? `plugin-compat-${blocking[0].kind}`
      : (unverifiable[0] ? `plugin-compat-${unverifiable[0].kind}` : null),
    findings,
    digest,
    evidence: "static",
  };
}

/** Guard patch text: CLI-overlay entries that disable quarantined loaders.
 * Core/official entry ids (auth, approval, host bridge) can never appear
 * here; attempts are skipped and reported, never silently emitted. */
export function buildGuardPatch(quarantinedEntryIds, protectedEntryIds = new Set()) {
  const unique = [...new Set(quarantinedEntryIds)];
  const emitted = [];
  const skipped = [];
  for (const id of unique) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(id)) {
      skipped.push(id);
      continue;
    }
    if (protectedEntryIds.has(id)) {
      skipped.push(id);
      continue;
    }
    emitted.push(id);
  }
  emitted.sort();
  const text = emitted.length === 0 ? "" : `${emitted.map((id) => `- id: ${id}\n  disabled: true`).join("\n")}\n`;
  return { text, emitted, skipped };
}

function sanitizePluginRecord(record) {
  if (!isPlainObject(record)) return null;
  const entryId = typeof record.entryId === "string" && record.entryId.length <= 128 ? record.entryId : null;
  const packageName = typeof record.packageName === "string" && record.packageName.length <= 214 ? record.packageName : null;
  if (!entryId || !packageName) return null;
  const verdict = ["pass", "fail", "unknown", "environment-limited", "unchecked"].includes(record.outcome)
    ? record.outcome
    : "unknown";
  return {
    entryId,
    packageName,
    version: typeof record.version === "string" && record.version.length <= 64 ? record.version : null,
    digest: typeof record.digest === "string" && /^[0-9a-f]{64}$/u.test(record.digest) ? record.digest : null,
    outcome: verdict,
    reason: typeof record.reason === "string" && record.reason.length <= 128 ? record.reason : null,
    evidence: typeof record.evidence === "string" && record.evidence.length <= 64 ? record.evidence : null,
    resolved: record.resolved !== false,
    findings: Array.isArray(record.findings)
      ? record.findings.slice(0, 24).map((finding) => (
        isPlainObject(finding) && typeof finding.kind === "string" && finding.kind.length <= 48
          ? {
            kind: finding.kind,
            dependency: typeof finding.dependency === "string" ? finding.dependency.slice(0, 214) : undefined,
            name: typeof finding.name === "string" ? finding.name.slice(0, 128) : undefined,
            range: typeof finding.range === "string" ? finding.range.slice(0, 128) : undefined,
            reason: typeof finding.reason === "string" ? finding.reason.slice(0, 256) : undefined,
          }
          : null
      )).filter(Boolean)
      : [],
    quarantined: record.quarantined === true,
    quarantinedAt: typeof record.quarantinedAt === "string" && record.quarantinedAt.length <= 40 ? record.quarantinedAt : null,
    quarantineReason: typeof record.quarantineReason === "string" && record.quarantineReason.length <= 128
      ? record.quarantineReason
      : null,
  };
}

export async function readCompatState(stateRoot) {
  const path = join(stateRoot, PLUGIN_COMPAT_STATE_FILENAME);
  const bytes = await readFile(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    // Transient host-owned IO failures (AV locks, EBUSY) must not take the
    // wrapper down: recover to "everything unchecked" and let the next
    // check rebuild the record.
    return null;
  });
  if (!bytes) {
    return { version: PLUGIN_COMPAT_STATE_VERSION, checkerVersion: COMPAT_CHECKER_VERSION, plugins: [], updatedAt: null };
  }
  if (bytes.length > MAX_STATE_BYTES) {
    return { version: PLUGIN_COMPAT_STATE_VERSION, checkerVersion: COMPAT_CHECKER_VERSION, plugins: [], updatedAt: null, recovered: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    // A corrupt host-owned record must never wedge startup: recover to
    // "everything unchecked" and let the next check rebuild it.
    return { version: PLUGIN_COMPAT_STATE_VERSION, checkerVersion: COMPAT_CHECKER_VERSION, plugins: [], updatedAt: null, recovered: true };
  }
  const plugins = Array.isArray(parsed?.plugins)
    ? parsed.plugins.map(sanitizePluginRecord).filter(Boolean)
    : [];
  return {
    version: PLUGIN_COMPAT_STATE_VERSION,
    checkerVersion: Number.isInteger(parsed?.checkerVersion) ? parsed.checkerVersion : null,
    plugins,
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
    cacheKey: typeof parsed?.cacheKey === "string" && parsed.cacheKey.length === 64 ? parsed.cacheKey : null,
    runtimeDigest: typeof parsed?.runtimeDigest === "string" && parsed.runtimeDigest.length === 64
      ? parsed.runtimeDigest
      : null,
    recovered: parsed?.recovered === true ? true : undefined,
  };
}

/** Atomic, bounded, host-owned state write (temp file + rename). */
export async function writeCompatState(stateRoot, state) {
  const plugins = (Array.isArray(state?.plugins) ? state.plugins : [])
    .map(sanitizePluginRecord)
    .filter(Boolean)
    .slice(0, 64);
  const payload = {
    version: PLUGIN_COMPAT_STATE_VERSION,
    checkerVersion: COMPAT_CHECKER_VERSION,
    updatedAt: new Date().toISOString(),
    ...(typeof state?.cacheKey === "string" && /^[0-9a-f]{64}$/u.test(state.cacheKey)
      ? { cacheKey: state.cacheKey }
      : {}),
    ...(typeof state?.runtimeDigest === "string" && /^[0-9a-f]{64}$/u.test(state.runtimeDigest)
      ? { runtimeDigest: state.runtimeDigest }
      : {}),
    plugins,
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.length > MAX_STATE_BYTES) throw stateFailure("plugin-compat-state-too-large");
  await mkdir(stateRoot, { recursive: true });
  const target = join(stateRoot, PLUGIN_COMPAT_STATE_FILENAME);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return payload;
}

export async function writeGuardPatch(stateRoot, quarantinedEntryIds, protectedEntryIds = new Set()) {
  const { text, emitted, skipped } = buildGuardPatch(quarantinedEntryIds, protectedEntryIds);
  const target = join(stateRoot, PLUGIN_COMPAT_GUARD_FILENAME);
  if (text === "") {
    await rm(target, { force: true });
    return { guardPath: null, entryIds: emitted, skippedEntryIds: skipped };
  }
  await mkdir(stateRoot, { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, target);
  return { guardPath: target, entryIds: emitted, skippedEntryIds: skipped };
}

/** Guard set = quarantined records that are still part of the live effective
 * composition. A record stays relevant when either its package is loaded
 * (bundle list or patch-level mount) or its entry id is currently mounted —
 * a bundle that inserts ANOTHER package's loader keeps that record live. */
export function projectQuarantineSet(state, livePlugins) {
  const livePackages = new Set(livePlugins.map((plugin) => plugin.packageName));
  const liveEntryIds = new Set(livePlugins.map((plugin) => plugin.entryId).filter((id) => id != null));
  return state.plugins
    .filter((plugin) => plugin.quarantined)
    .filter((plugin) => livePackages.has(plugin.packageName) || liveEntryIds.has(plugin.entryId))
    .filter((plugin) => plugin.resolved !== false)
    .map((plugin) => plugin.entryId);
}

/**
 * Exact composition cache key: runtime digest, per-plugin code digests, the
 * manifest/dependency layer, guard content, and checker generation. A mere
 * same-version source edit changes the plugin digest and invalidates it.
 */
export function computeCompositionCacheKey({ runtimeDigest, plugins, manifestText, guardEntryIds }) {
  const pluginParts = [...plugins]
    .sort((a, b) => `${a.packageName}@${a.entryId}`.localeCompare(`${b.packageName}@${b.entryId}`))
    .map((plugin) => `${plugin.packageName}|${plugin.entryId}|${plugin.version ?? "?"}|${plugin.digest ?? "?"}`);
  return digestOf(Buffer.from([
    "luckyray-plugin-compat-cache-v1",
    COMPAT_CHECKER_VERSION,
    runtimeDigest ?? "?",
    digestOf(Buffer.from(manifestText ?? "", "utf8")),
    [...new Set(guardEntryIds)].sort().join(","),
    pluginParts.join(";"),
  ].join("\n"), "utf8"));
}
