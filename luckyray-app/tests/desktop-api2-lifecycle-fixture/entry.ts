// Runs only in the fresh, fixture-only Tauri profile. No user plugin or data is opened.
import { invoke } from '@tauri-apps/api/core';

declare global { interface Window { __lifecycleFixture: { executable: string; cwd: string } } }
const config = window.__lifecycleFixture;
const controlId = 'test.lifecycle-control';
const caseId = 'test.lifecycle-case';
type State = { revision: number; packages: Array<{ package: {manifest: {id: string; version: string}}; enabled: boolean; grants?: string[]; digest: string; epoch: number; data?: {settings?: {marker?: string}} }> };

const manage = (request: object) => invoke<State>('manage_extension_packages', { request: JSON.stringify(request) });
const native = <T>(lease: string, op: string, input: object = {}) => invoke<T>('desktop_extension_runtime', { request: JSON.stringify({op, lease, ...input}) });
const report = (name: string, value: object) => invoke<string>('extension_fixture_report', { name, report: value });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const entry = (state: State, id: string) => {
  const item = state.packages.find(p => p.package.manifest.id === id);
  if (!item) throw Error(`missing fixture package ${id}`);
  return item;
};
const pkg = (id: string, version: string) => ({
  manifest: {schemaVersion:2, apiVersion:2, type:'desktop', entry:'main.js', id, name:`Synthetic ${id}`, version,
    minHostVersion:'1.9.8', requiredModules:['process'], optionalModules:[]},
  resource: {code:'export function activate(api) {}', css:'', assets:{}, dataVersion:1, contributions:[]},
});
const open = (state: State, id: string) => {
  const item = entry(state, id);
  return native<string>('', 'open', {id, digest:item.digest, epoch:item.epoch});
};
async function waitForAck(control: string, name: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await native(control, 'readFile', {path:`${config.cwd}\\${name}.ack`}); return; } catch { await sleep(50); }
  }
  throw Error(`fixture acknowledgement timed out: ${name}`);
}
async function startChild(lease: string, stage: string, control: string) {
  const handle = await native<string>(lease, 'spawn', {executable:config.executable, cwd:config.cwd, args:['wait']});
  let stdout = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await native<{events:Array<{stream:string;base64:string}>;settled:boolean}>(lease, 'poll', {handle});
    for (const event of result.events) if (event.stream === 'stdout') stdout += atob(event.base64);
    const match = stdout.match(/fixture-ready:(\d+)/);
    if (match) {
      await report(`${stage}-started`, {pid:Number(match[1]), running:true});
      await waitForAck(control, `${stage}-started`);
      return;
    }
    if (result.settled) throw Error(`fixture child ended before ${stage}`);
    await sleep(30);
  }
  throw Error(`fixture child did not start for ${stage}`);
}

async function run() {
  let state = await manage({op:'list'});
  if (state.packages.length !== 0) throw Error('fixture registry was not empty');
  for (const id of [controlId, caseId]) {
    state = await manage({op:'install', package:pkg(id,'1.0.0'), expectedRevision:state.revision});
    state = await manage({op:'grant', id, grants:['desktop.fullTrust'], expectedRevision:state.revision});
    state = await manage({op:'enable', id, expectedRevision:state.revision});
  }
  state = await manage({op:'data', id:caseId, data:{schemaVersion:1, revision:1, settings:{marker:'synthetic-only'}, cache:{}}, expectedRevision:state.revision});
  const control = await open(state, controlId);

  let running = await open(state, caseId);
  await startChild(running, 'disable', control);
  state = await manage({op:'disable', id:caseId, expectedRevision:state.revision});
  if (entry(state, caseId).enabled) throw Error('fixture disable did not persist');
  await report('disable-done', {enabled:false});
  await waitForAck(control, 'disable-done');

  state = await manage({op:'enable', id:caseId, expectedRevision:state.revision});
  running = await open(state, caseId);
  await startChild(running, 'update', control);
  state = await manage({op:'update', package:pkg(caseId,'1.0.1'), publisherApproved:true, expectedRevision:state.revision});
  const updated = entry(state, caseId);
  if (updated.enabled || (updated.grants?.length ?? 0) !== 0 || updated.data?.settings?.marker !== 'synthetic-only')
    throw Error('fixture update did not disable, revoke and preserve synthetic data');
  await report('update-done', {enabled:false, grants:0, dataPreserved:true});
  await waitForAck(control, 'update-done');

  state = await manage({op:'grant', id:caseId, grants:['desktop.fullTrust'], expectedRevision:state.revision});
  state = await manage({op:'enable', id:caseId, expectedRevision:state.revision});
  running = await open(state, caseId);
  await startChild(running, 'exit', control);
  await report('exit-requested', {running:true});
  // Fixture-only command invokes the actual Tauri application exit path.
  await invoke('extension_fixture_done', {report:{ok:true, scope:'isolated-synthetic-process-lifecycle'}});
}

void run().catch(async error => {
  const message = String(error);
  await report('fixture-error', {message}).catch(() => {});
  await invoke('extension_fixture_done', {report:{ok:false, message}}).catch(() => {});
});
