import { useEffect, useRef, useState } from 'react';
import {useApplicationModalSurface} from '../app/applicationModalIsolation';
import {registerWorkspaceFlush} from './windowLifecycle';
import { listen } from '@tauri-apps/api/event';
import { focusEntity } from '../core/services/context';
import { knowledgeTagIdentity } from '../core/services/knowledge';
import { readActiveKnowledgeSource } from '../core/services/knowledgeSource';
import { materialLibrarySession } from '../core/services/materialLibraryContext';
import { openInLightSeek, waitForOpenInLightSeekIntent } from '../core/services/openInLightSeek';
import { materialNativeDetailViews } from '../features/materials/materialNativeDetailRegistry';
import { workspaceCommand, type NativeViewGrant } from './nativeClient';
import { GRAPH_MAIN_HANDLER_KINDS, validateGraphMainClaim, type GraphMainAction, type GraphMainClaim, type GraphMainCompletion, type GraphMainExecution } from './nativeGraphMainProtocol';

// Main has one broker lease. Serialize writes across effect generations, including
// cleanup: equal handler sets reuse a token, so a replacement must follow cleanup.
let leaseWrites: Promise<unknown> = Promise.resolve();
let retirementPending = true; // A fresh Main realm may inherit a live broker lease.
function writeLease<T>(write: () => Promise<T>): Promise<T> {
  const result = leaseWrites.then(write);
  leaseWrites = result.catch(() => {}); // A failed generation must not poison its successor.
  return result;
}

type Review = { kind: 'create' | 'screenshot'; claim: GraphMainClaim; finish: (choice: 'create' | 'copy' | 'save' | null) => void };
/** Main's authenticated queue consumer. Mounted once by the production host. */
export function WorkspaceGraphMainActions({ openDocument }: { openDocument: (view: NativeViewGrant) => Promise<void> }) {
  const [error, setError] = useState(''), [review, setReview] = useState<Review | null>(null);
  const [serviceErrors, setServiceErrors] = useState<Partial<Record<'register' | 'pending' | 'listen', string>>>({});
  const heldReview=useRef(review);heldReview.current=review;
  const modal=useApplicationModalSurface<HTMLElement>(!!review,()=>heldReview.current?.finish(null));
  const openDocumentRef = useRef(openDocument); openDocumentRef.current = openDocument;
  useEffect(() => {
    let active = true, running = false, stop: (() => void) | undefined, leaseToken = '', renewing = false;
    let pendingReview: Review['finish'] | null = null;
    const releaseFlush=registerWorkspaceFlush(async()=>!running&&!pendingReview);
    const alive = () => { if (!active) throw Error('workspace-graph-main-unmounted'); };
    const serviceStatus = (service: 'register' | 'pending' | 'listen', cause?: unknown) => {
      if (active) setServiceErrors(previous => ({ ...previous, [service]: cause === undefined ? '' : String(cause) }));
    };
    const command = async <T,>(op: string, request: Record<string, unknown> = {}) => {
      alive();
      const result = await workspaceCommand<T>({ op, leaseToken, ...request });
      alive(); // A response from a retired effect cannot trigger another effect or completion.
      return result;
    };
    const validate = async (claim: GraphMainClaim) => { alive(); await command('graphMainValidate', { id: claim.id, claimToken: claim.claimToken }); alive(); };
    const complete = (claim: GraphMainClaim, result: GraphMainCompletion) => command('graphMainComplete', { id: claim.id, claimToken: claim.claimToken, result });
    const execute = (claim: GraphMainClaim, input: unknown) => command<GraphMainExecution>('graphMainExecute', { id: claim.id, claimToken: claim.claimToken, input });
    const ask = (claim: GraphMainClaim, kind: Review['kind']) => new Promise<'create' | 'copy' | 'save' | null>(resolve => {
      const timer = setTimeout(() => finish(null), Math.min(claim.remainingMs, 180000));
      const finish: Review['finish'] = choice => { clearTimeout(timer); pendingReview = null; if (active) setReview(null); resolve(choice); };
      pendingReview = finish; setReview({ claim, kind, finish });
    });
    const openCatalog = async (claim: GraphMainClaim, action: Extract<GraphMainAction, { kind: 'openCatalogAsset' }>) => {
      const before = materialLibrarySession.capture();
      await validate(claim); alive();
      if (!materialLibrarySession.isCurrent(before)) throw Error('workspace-graph-material-navigation-superseded');
      if (before.libraryId !== action.libraryId) await materialLibrarySession.select(action.libraryId);
      alive();
      const selected = materialLibrarySession.capture();
      if (selected.libraryId !== action.libraryId || materialLibrarySession.getSnapshot().status !== 'ready') throw Error('workspace-graph-material-source-changed');
      window.location.hash = '#materials';
      const deadline = performance.now() + 7000;
      let adapter: ReturnType<typeof materialNativeDetailViews.get> | undefined;
      while (performance.now() < deadline) {
        alive(); if (!materialLibrarySession.isCurrent(selected)) throw Error('workspace-graph-material-navigation-superseded');
        try { const next = materialNativeDetailViews.get('main-materials'), binding = next.binding(); if (binding.libraryId === action.libraryId && binding.generation === selected.generation && binding.ready) { adapter = next; break; } } catch { /* Mount/data readiness only. No action has been issued. */ }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (!adapter) throw Error('workspace-graph-material-detail-not-ready');
      await validate(claim); alive();
      const ack = await adapter.openDetail({ libraryId: action.libraryId, asset: action.asset, assetRevision: action.assetRevision });
      if (!materialLibrarySession.isCurrent(selected) || ack.libraryId !== action.libraryId || ack.generation !== selected.generation
        || ack.assetId !== action.asset.id || ack.assetRevision !== action.assetRevision) throw Error('workspace-graph-material-detail-ack-mismatch');
      await validate(claim); alive();
    };
    const process = async (id: string) => {
      let claim: GraphMainClaim | undefined, finished = false;
      try {
        const source = readActiveKnowledgeSource();
        claim = await command<GraphMainClaim>('graphMainClaim', { id }); validateGraphMainClaim(claim); if (claim.id !== id) throw Error('workspace-graph-main-invalid-claim');
        await validate(claim); alive(); const action = claim.action;
        if (action.kind === 'screenshot') {
          const choice = await ask(claim, 'screenshot'); await validate(claim); alive();
          if (!choice) { await complete(claim, { kind: 'cancelled' }); finished = true; return; }
          if (choice === 'copy') {
            if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw Error('workspace-graph-clipboard-unavailable');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(action.bytes)], { type: 'image/png' }) })]);
            await validate(claim); alive(); await complete(claim, { kind: 'screenshot', result: 'copied' });
          } else if (choice === 'save') {
            const result = await execute(claim, { kind: 'saveScreenshot' }); alive();
            if (result.kind !== 'screenshot') throw Error('workspace-graph-screenshot-save-unconfirmed');
            await complete(claim, result.result === 'saved' ? { kind: 'screenshot', result: 'saved' } : { kind: 'cancelled' });
          } else throw Error('workspace-graph-screenshot-choice-invalid');
          finished = true; return;
        }
        if (action.kind === 'openCatalogAsset') await openCatalog(claim, action);
        else if (action.kind === 'composeAi') { const intent = openInLightSeek({ source: 'graph', text: action.text }); await waitForOpenInLightSeekIntent(intent.intentId); await validate(claim); alive(); }
        else if (action.kind === 'openTag') {
          if (!source || source !== readActiveKnowledgeSource() || source.vaultId !== action.vaultId) throw Error('workspace-graph-tag-main-source-mismatch');
          const tagId = knowledgeTagIdentity(action.vaultId, action.name);
          focusEntity('tag', tagId, { source: 'workspace-graph-action' }); window.location.hash = '#tags';
          const deadline = performance.now() + 7000; let painted = false;
          while (performance.now() < deadline) {
            alive(); if (source !== readActiveKnowledgeSource()) throw Error('workspace-graph-tag-main-source-changed');
            const element = document.querySelector<HTMLElement>('#page-tags[data-native-tag-ready="true"]');
            const rect = element?.getBoundingClientRect();
            if (element?.dataset.nativeTagId === tagId && rect && rect.width > 0 && rect.height > 0) {
              await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              if (source === readActiveKnowledgeSource() && element.isConnected && element.dataset.nativeTagId === tagId
                && element.dataset.nativeTagReady === 'true' && element.getBoundingClientRect().width > 0) { painted = true; break; }
            }
            await new Promise(resolve => setTimeout(resolve, 40));
          }
          if (!painted) throw Error('workspace-graph-tag-main-paint-unconfirmed');
          await validate(claim); alive();
        } else {
          if (action.kind === 'createMissing') { const answer = await ask(claim, 'create'); await validate(claim); alive(); if (answer !== 'create') { await complete(claim, { kind: 'cancelled' }); finished = true; return; } }
          const result = await execute(claim, { kind: 'perform', confirmed: action.kind === 'createMissing' }); alive();
          if (result.kind === 'openView') await openDocumentRef.current(result.view);
          else if (result.kind !== 'acknowledged' && result.kind !== 'openedInOrigin') throw Error('workspace-graph-native-execution-unconfirmed');
          await validate(claim); alive();
        }
        await complete(claim, { kind: 'acknowledged' }); finished = true;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
        if (active && claim && !finished) await complete(claim, { kind: 'failed', code: 'workspace-graph-main-failed' }).catch(() => {});
      }
    };
    const drain = async () => {
      if (!active || running || !leaseToken) return; running = true;
      try { const offers = await command<Array<{ id: string }>>('graphMainPending'); if (offers.length > 64) throw Error('workspace-graph-main-capacity'); serviceStatus('pending'); for (const offer of offers) { if (!active) break; await process(offer.id); } }
      catch (cause) { serviceStatus('pending', cause); } finally { running = false; }
    };
    const register = async () => {
      if (!active || renewing) return; renewing = true;
      try { const result = await writeLease(async () => {
        alive();
        // A rejected cleanup may have left the old token live. Do not adopt it.
        if (retirementPending) {
          await workspaceCommand({ op: 'graphMainRegister', kinds: [] });
          retirementPending = false;
          alive();
        }
        return workspaceCommand<{ leaseToken: string; expiresInMs: number }>({ op: 'graphMainRegister', kinds: [...GRAPH_MAIN_HANDLER_KINDS] });
      });
        if (!/^[a-f0-9]{64}$/.test(result.leaseToken) || !Number.isFinite(result.expiresInMs) || result.expiresInMs <= 0) throw Error('workspace-graph-main-lease-invalid');
        if (active) { leaseToken = result.leaseToken; serviceStatus('register'); void drain(); }
      } catch (cause) { serviceStatus('register', cause); } finally { renewing = false; }
    };
    void register(); void listen('luckyray:workspace-graph-action-available', () => void drain()).then(release => { if (active) { stop = release; serviceStatus('listen'); } else release(); }).catch(cause => { serviceStatus('listen', cause); });
    const renewal = setInterval(() => void register(), 10000), polling = setInterval(() => void drain(), 1500);
    return () => {
      active = false; releaseFlush(); stop?.(); clearInterval(renewal); clearInterval(polling); pendingReview?.(null);
      void writeLease(async () => {
        retirementPending = true;
        await workspaceCommand({ op: 'graphMainRegister', kinds: [] });
        retirementPending = false;
      }).catch(() => {});
    };
  }, []);
  const action = review?.claim.action;
  const displayedError = [error, ...Object.values(serviceErrors)].filter(Boolean).join('；');
  return <>{displayedError && <div role="alert" className="workspace-conflict">{displayedError}<button type="button" onClick={() => { setError(''); setServiceErrors({}); }}>关闭提示</button></div>}
    {review && <div className="modal-overlay-react" onPointerDown={modal.onBackdropPointerDown}><section ref={modal.surfaceRef} tabIndex={-1} onKeyDown={modal.onSurfaceKeyDown} role="dialog" aria-modal="true" aria-label={review.kind === 'screenshot' ? '导出图谱截图' : '创建笔记'} className="modal-box-react">
      <div className="modal-header-react"><strong>{review.kind === 'screenshot' ? '导出当前图谱截图' : '创建图谱中的缺失笔记'}</strong><button type="button" onClick={() => review.finish(null)}>取消</button></div>
      {action?.kind === 'createMissing' && <><p>在知识库 {action.vaultId} 中创建「{action.relativePath}」。已有文件不会被覆盖。</p><button type="button" onClick={() => review.finish('create')}>创建笔记</button></>}
      {review.kind === 'screenshot' && <><button type="button" onClick={() => review.finish('copy')}>复制图片</button><button type="button" onClick={() => review.finish('save')}>选择保存位置</button></>}
    </section></div>}
  </>;
}
