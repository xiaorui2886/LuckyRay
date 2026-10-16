#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const [command, directory = ".", ...options] = process.argv.slice(2);
const root = path.resolve(directory);
const here = path.dirname(fileURLToPath(import.meta.url));
const permissions = ["materials.read", "materials.image", "materials.tags", "knowledge.read", "knowledge.create", "knowledge.insert", "canvas.read", "canvas.export"];
const keys = ["id", "name", "version", "minHostVersion", "requiredModules", "optionalModules", "requiredPermissions", "optionalPermissions", "dataVersion", "contributions"];
const version = value => typeof value === "string" && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(value);
const bytes = value => Buffer.byteLength(value, "utf8");
const text = (value, max, trim = false) => typeof value === "string" && bytes(value) <= max && (trim ? value.trim().length : value.length) > 0 && !/[\p{Cc}]/u.test(value);
const list = value => Array.isArray(value) && value.every(item => typeof item === "string");
const fail = code => { throw new Error(code); };

function build() {
  const config = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  if (!config || Array.isArray(config) || typeof config !== "object" || Object.keys(config).some(key => !keys.includes(key))) fail("extension-invalid-manifest-fields");
  const { id, name, version: packageVersion, minHostVersion = "1.9.2", requiredModules = [], optionalModules = [], requiredPermissions = [], optionalPermissions = [], dataVersion = 1, contributions } = config;
  if (typeof id !== "string" || !/^[a-z][a-z0-9.-]{2,79}$/.test(id) || id.includes("..")) fail("extension-invalid-id");
  if (!text(name, 160, true) || !version(packageVersion) || !version(minHostVersion)) fail("extension-invalid-manifest");
  if (!list(requiredModules) || !list(optionalModules) || requiredModules.length + optionalModules.length > 16 || [...requiredModules, ...optionalModules].some(module => !/^[a-z-]{1,40}$/.test(module))) fail("extension-invalid-modules");
  if (!list(requiredPermissions) || !list(optionalPermissions) || requiredPermissions.length + optionalPermissions.length > 16 || !Number.isInteger(dataVersion) || dataVersion < 1 || dataVersion > 0xffffffff) fail("extension-invalid-script");
  for (const permission of [...requiredPermissions, ...optionalPermissions]) {
    if (!permissions.includes(permission)) fail("extension-unsupported-permission");
    if (![...requiredModules, ...optionalModules].includes(permission.split(".")[0])) fail("extension-permission-module-required");
  }
  if (!Array.isArray(contributions) || !contributions.length || contributions.length > 16) fail("extension-invalid-contribution");
  const ids = new Set();
  for (const contribution of contributions) {
    if (!contribution || typeof contribution !== "object" || Array.isArray(contribution) || Object.keys(contribution).some(key => !["id", "label", "kind"].includes(key))
      || typeof contribution.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(contribution.id) || ids.has(contribution.id)
      || !text(contribution.label, 120) || !["command", "menu", "panel", "settings", "page"].includes(contribution.kind)) fail("extension-invalid-contribution");
    ids.add(contribution.id);
  }
  const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
  if (!source.length || bytes(source) > 120000) fail("extension-invalid-script");
  new vm.Script(source, { filename: "main.js" }); // Parse only; never evaluate developer code.
  const pkg = { manifest: { schemaVersion: 1, apiVersion: 1, type: "script", entry: "main.js", id, name, version: packageVersion, minHostVersion, requiredModules, optionalModules }, resource: { code: source, requiredPermissions, optionalPermissions, dataVersion, contributions } };
  const compact = JSON.stringify(pkg);
  const encoded = compact + "\n";
  if (bytes(encoded) > 131072) fail("extension-package-too-large");
  return { pkg, encoded };
}

function pack() {
  const { pkg, encoded } = build();
  const output = path.join(root, `${pkg.manifest.id}.lrpack.json`);
  fs.writeFileSync(output, encoded);
  console.log(output);
}

function create() {
  if (fs.existsSync(root)) fail("Choose a new project directory; existing directories are never overwritten");
  let template;
  if (options.length) {
    if (options.length !== 2 || options[0] !== "--template" || !["palette", "outline", "canvas-export", "material-manifest", "page-desk", "material-reader"].includes(options[1])) fail("Unknown template; use --template <shipped-example>");
    template = options[1];
  }
  const config = template ? fs.readFileSync(path.join(here, "examples", template, "plugin.json"), "utf8") : JSON.stringify({ id: "example.hello", name: "Hello plugin", version: "1.0.0", requiredModules: [], optionalModules: [], requiredPermissions: [], optionalPermissions: [], dataVersion: 1, contributions: [{ id: "hello", label: "Hello", kind: "panel" }] }, null, 2);
  const source = template ? fs.readFileSync(path.join(here, "examples", template, "main.js"), "utf8").replace(/^\/\/\/ <reference path=".*" \/>/m, '/// <reference path="./sdk.d.ts" />') : '/// <reference path="./sdk.d.ts" />\nLuckyRay.register(async event => ({title:"Hello",text:`LuckyRay API ${LuckyRay.apiVersion}; ${Object.keys(await LuckyRay.call("ui.theme")).length} theme tokens`,actions:[{id:"refresh",label:"Refresh"}]}));\n';
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), config);
  fs.writeFileSync(path.join(root, "main.js"), source);
  fs.copyFileSync(path.join(here, "index.d.ts"), path.join(root, "sdk.d.ts"));
  fs.writeFileSync(path.join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { checkJs: true, noEmit: true, strict: true, target: "ES2020", lib: ["ES2020"] }, files: ["main.js", "sdk.d.ts"] }, null, 2) + "\n");
  console.log(`Created ${root}. Edit plugin.json/main.js, then lr-plugin check ${root} and lr-plugin pack ${root}`);
}

try {
  if (command === "create") create();
  else {
    if (options.length) fail("Unexpected arguments");
    if (command === "check") { build(); console.log("Authoring checks passed; native installation remains schema, compatibility and permission authority."); }
    else if (command === "pack") pack();
    else if (command === "dev") {
      pack(); let pending;
      fs.watch(root, (_, file) => {
        if (file !== "main.js" && file !== "plugin.json") return;
        clearTimeout(pending);
        pending = setTimeout(() => { try { pack(); console.log("Install the package through LuckyRay. Changed installed content requires a higher version."); } catch (error) { console.error(error.message); } }, 150);
      });
    } else fail("Usage: lr-plugin create <new-dir> [--template <example>] | check <dir> | pack <dir> | dev <dir>");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
