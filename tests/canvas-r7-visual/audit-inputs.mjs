import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const manifest=JSON.parse(fs.readFileSync('SOURCE-MANIFEST.json','utf8'));
assert.equal(manifest.scope,'synthetic-production-ui-only');
assert.equal(manifest.nativeOrProviderCalls,false);
const names=new Set();
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,/(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/,/https:\/\/github\.com\/xiaorui2886\/luckyray-app\//,/C:\\Users\\|\/home\/agent\/|\/workspace\//];
for(const row of manifest.files){
 assert.match(row.path,/^(src\/(?:features\/canvas|core\/(?:canvas|theme))\/[^/]+\.(?:ts|tsx|css)|tests\/canvas(?:(?:Agent|Creative|ImageCrop)R7|AgentResultR7d)Ui\.(?:fixture\.tsx|browser\.cjs))$/);
 assert.ok(!row.path.includes('..'));assert.ok(!names.has(row.path)); names.add(row.path);
 const content=fs.readFileSync(row.path);assert.equal(content.length,row.bytes);assert.equal(crypto.createHash('sha256').update(content).digest('hex'),row.sha256);
 for(const re of denied)assert.ok(!re.test(content.toString('utf8')),`disallowed content in ${row.path}`);
}
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const dir of ['src','tests']) for(const name of walk(dir))assert.ok(names.has(name.replaceAll(path.sep,'/')),`unmanifested file ${name}`);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
assert.deepEqual(pkg.dependencies,lock.packages[''].dependencies);
for(const [name,p] of Object.entries(lock.packages)){if(!name)continue;assert.ok(p.integrity,`missing integrity ${name}`);assert.ok(p.resolved.startsWith('https://registry.npmjs.org/'),`non-public-registry ${name}`);}
console.log(JSON.stringify({status:'PASS',sourceFiles:names.size,scope:manifest.scope}));

const hostManifest=JSON.parse(fs.readFileSync('HOST-MANIFEST.json','utf8'));assert.equal(hostManifest.scope,'synthetic-webview2-host-only');const hostNames=new Set();
for(const row of hostManifest.files){assert.ok(row.path.startsWith('webview2/')&&!row.path.includes('..'));assert.ok(!hostNames.has(row.path));hostNames.add(row.path);const content=fs.readFileSync(row.path);assert.equal(content.length,row.bytes);assert.equal(crypto.createHash('sha256').update(content).digest('hex'),row.sha256);for(const re of denied)assert.ok(!re.test(content.toString('utf8')),`disallowed host content ${row.path}`);}
for(const name of walk('webview2'))assert.ok(hostNames.has(name.replaceAll(path.sep,'/')),`unmanifested host file ${name}`);
console.log(JSON.stringify({status:'PASS',hostFiles:hostNames.size,scope:hostManifest.scope}));
