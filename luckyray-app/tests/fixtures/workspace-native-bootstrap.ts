import {invoke} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {createFixtureDiagnostics} from './workspace-native-diagnostics';

export const label = getCurrentWindow().label;
export const {report, stage} = createFixtureDiagnostics(label, invoke, crypto.randomUUID());
let failing = false;
export async function fail(error: unknown) {
  if (failing) return;
  failing = true;
  const message = String(error);
  document.getElementById('root')?.setAttribute('data-fixture-error', message);
  console.error('workspace fixture failed', message);
  try { await report({error: message}); }
  catch (reportError) {
    // A broken diagnostic route must not create another unhandled rejection.
    document.getElementById('root')?.setAttribute('data-fixture-report-error', String(reportError));
    console.error('workspace fixture error report failed', String(reportError));
  }
}
window.addEventListener('error', event => { void fail(event.error ?? event.message); });
window.addEventListener('unhandledrejection', event => { void fail(event.reason); });
// Dynamic import makes module/dependency failures visible before React mounts.
void stage('js-entry', {documentUrl: location.href})
  .then(() => import('./workspace-native'))
  .catch(fail);
