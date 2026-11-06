import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {buildDesktopPackage,createDesktopProject} from '../plugin-sdk/desktop-pack.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-desktop-authoring-'));
test('desktop authoring packs real ESM, CSS and asset bytes without evaluating code',()=>{
 const project=path.join(root,'valid');createDesktopProject(project);const c=JSON.parse(fs.readFileSync(path.join(project,'plugin.json')));c.style='theme.css';c.assets={logo:{file:'logo.txt',mimeType:'text/plain'}};fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(c));fs.writeFileSync(path.join(project,'theme.css'),'.workbench { color: teal; }');fs.writeFileSync(path.join(project,'logo.txt'),'synthetic');fs.appendFileSync(path.join(project,'main.js'),'\nthrow Error("must not execute while packing");\n');
 const {pkg}=buildDesktopPackage(project);assert.equal(pkg.manifest.type,'desktop');assert.equal(pkg.manifest.apiVersion,2);assert.equal(pkg.resource.css,'.workbench { color: teal; }');assert.equal(Buffer.from(pkg.resource.assets.logo.base64,'base64').toString(),'synthetic');
});
test('authoring rejects escaping resources, symlinks and malformed module lists',()=>{
 const project=path.join(root,'reject');createDesktopProject(project);const c=JSON.parse(fs.readFileSync(path.join(project,'plugin.json')));c.entry='../outside.js';fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(c));assert.throws(()=>buildDesktopPackage(project),/resource path/);
 c.entry='main.js';c.requiredModules='workspace';fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(c));assert.throws(()=>buildDesktopPackage(project),/modules/);
 c.requiredModules=[];c.entry='alias.js';fs.symlinkSync(path.join(project,'main.js'),path.join(project,'alias.js'));fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(c));assert.throws(()=>buildDesktopPackage(project),/symlinks/);
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
