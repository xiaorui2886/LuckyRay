import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REQUIRED = ['scopeIsolation','sameRelativePathDifferentVault','opaqueAttachmentRead','attachmentRangeRead','attachmentCrossWindowDenied','attachmentForgedScopeDenied','attachmentSelfExpansionDenied','attachmentStaleTokenDenied','attachmentRecoveryBaselinePreserved','childAssetCspBlocked','childNavigationPinned','childPopupDenied','scopedGlobalSwitchDenied','recoveredScopeKeepsCapturedIdentity','recoveryCannotRetargetRoot','productionLegacyCommandsDenied','guardedLegacyProbeNotExecuted','multiTabRetainedUndo','explicitViewScope','unboundDenied','crossWindowDragHandshake','dragTargetSplit','dragReplayDenied','writerCommitted','staleRejected','mainBindingIdentityDenied','dirtyCloseDenied','reopenedWindowKeepsLatestDocument','restoredStableWindowIdentity','closeFlushedDraft','allWindowQuitBarrier','cancelledQuitUnfreezes','mergeIntoMountedMain','mergeSourceClosedAfterAck','staleMergeDenied','complete'];
export const RUST_ASSERTIONS = ['scopeIsolation','sameRelativePathDifferentVault','scopedGlobalSwitchDenied','recoveredScopeKeepsCapturedIdentity','recoveryCannotRetargetRoot'];
export const MAIN_ASSERTIONS = ['guardedLegacyProbeNotExecuted','mainBindingIdentityDenied','closeFlushedDraft','allWindowQuitBarrier','cancelledQuitUnfreezes','mergeIntoMountedMain','mergeSourceClosedAfterAck','staleMergeDenied','complete'];
export function verifyFixtureResult(result, processExitCode) {
  if (processExitCode !== 0) throw Error(`fixture process exit ${processExitCode}`);
  if (result?.schemaVersion !== 2 || result.actualNative !== true || result.status !== 'passed' || result.complete !== true || result.exitCode !== 0) throw Error('fixture did not reach verified completion');
  const reports = result.reports;
  if (!Array.isArray(reports) || Object.hasOwn(result, 'error') || reports.some(entry => Object.hasOwn(entry?.report ?? {}, 'error'))) throw Error('fixture contains an error');
  if (!Array.isArray(result.missingAssertions) || result.missingAssertions.length) throw Error('fixture has missing assertions');
  for (const key of REQUIRED) {
    const present = reports.some(entry => {
      const owner = entry.window;
      const correct = RUST_ASSERTIONS.includes(key) ? owner === 'rust' : MAIN_ASSERTIONS.includes(key) ? owner === 'main' : typeof owner === 'string' && owner.startsWith('workspace-');
      return correct && entry.report?.[key] === true;
    });
    if (!present) throw Error(`fixture assertion missing or wrong source: ${key}`);
  }
  const readers = new Set(reports.filter(entry => entry.report?.listenersReady === true && typeof entry.window === 'string' && entry.window.startsWith('workspace-')).map(entry => entry.window));
  if (readers.size < 2) throw Error('fixture requires two distinct ready child reporters');
  for (const window of readers) {
    for (const key of ['editorMounted','productionLegacyCommandsDenied','opaqueAttachmentRead','attachmentRangeRead','attachmentForgedScopeDenied']) {
      if (!reports.some(entry => entry.window === window && entry.report?.[key] === true)) throw Error(`fixture child ${window} missing ${key}`);
    }
  }
  return {status: 'passed', childReporters: readers.size, assertions: REQUIRED.length};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || !/^-?\d+$/.test(process.argv[3])) throw Error('usage: node scripts/check-workspace-fixture-result.mjs <fresh-result.json> <actual-process-exit-code>');
    console.log(JSON.stringify(verifyFixtureResult(JSON.parse(readFileSync(process.argv[2], 'utf8')), Number(process.argv[3]))));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
