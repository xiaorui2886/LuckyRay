#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const [command, directory = "."] = process.argv.slice(2);
const root = path.resolve(directory);
const methods = ["materials.read", "materials.image", "materials.tags", "knowledge.read", "knowledge.create", "knowledge.insert", "canvas.read", "canvas.export"];
function build() {
 const config = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
 const source = fs.readFileSync(path.join(root, "main.js"), "utf8");
 new vm.Script(source, { filename: "main.js" }); // Parse only; never execute developer code.
 const { requiredPermissions = [], optionalPermissions = [], dataVersion = 1, contributions, ...identity } = config;
 const pkg = { manifest: { schemaVersion: 1, apiVersion: 1, type: "script", entry: "main.js", minHostVersion: "1.9.2", requiredModules: [], optionalModules: [], ...identity, schemaVersion: 1, apiVersion: 1, type: "script", entry: "main.js" }, resource: { code: source, requiredPermissions, optionalPermissions, dataVersion, contributions } };
 if (!/^[a-z][a-z0-9.-]{2,79}$/.test(pkg.manifest.id) || pkg.manifest.id.includes("..") || !/^\d+\.\d+\.\d+$/.test(pkg.manifest.version)) throw Error("Invalid package id/version");
 if (!Number.isInteger(dataVersion) || dataVersion < 1 || !Array.isArray(requiredPermissions) || !Array.isArray(optionalPermissions) || requiredPermissions.length+optionalPermissions.length>16) throw Error("Invalid permissions/dataVersion");
 if ([...requiredPermissions, ...optionalPermissions].some(p => !methods.includes(p))) throw Error("Unknown permission");
 if (!Array.isArray(contributions) || !contributions.length || contributions.length > 16) throw Error("Declare 1–16 contributions");
 const text = JSON.stringify(pkg, null, 2);
 if (Buffer.byteLength(text) > 131072 || Buffer.byteLength(source) > 120000) throw Error("Package exceeds V1 size budget");
 return { text, pkg };
}
function pack() { const {text,pkg}=build(); const output=path.join(root, `${pkg.manifest.id}.lrpack.json`); fs.writeFileSync(output,text+"\n"); console.log(output); }
if (command === "create") {
 if (fs.existsSync(root)) throw Error("Choose a new project directory");
 fs.mkdirSync(root, { recursive: true });
 fs.writeFileSync(path.join(root,"plugin.json"),JSON.stringify({id:"example.hello",name:"Hello plugin",version:"1.0.0",requiredModules:[],optionalModules:[],requiredPermissions:[],optionalPermissions:[],dataVersion:1,contributions:[{id:"hello",label:"Hello",kind:"panel"}]},null,2));
 fs.writeFileSync(path.join(root,"main.js"),'/// <reference path="./sdk.d.ts" />\nLuckyRay.register(async event => ({title:"Hello",text:"Your plugin is running in LuckyRay.",actions:[{id:"refresh",label:"Refresh"}]}));\n');
 fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"index.d.ts"),path.join(root,"sdk.d.ts"));
 console.log(`Created ${root}. Edit plugin.json/main.js, then lr-plugin pack ${root}`);
} else if (command === "check") { build(); console.log("Authoring checks passed; native installation remains the schema/compatibility authority."); }
else if (command === "pack") pack();
else if (command === "dev") { pack(); let pending; fs.watch(root,(_,file)=>{if(file!=="main.js"&&file!=="plugin.json")return;clearTimeout(pending);pending=setTimeout(()=>{try{pack();console.log("Select package in LuckyRay to reload. Bump version for changed installed content.");}catch(e){console.error(e.message);}},150);}); }
else { console.error("Usage: lr-plugin create <new-dir> | check <dir> | pack <dir> | dev <dir>"); process.exitCode=1; }
