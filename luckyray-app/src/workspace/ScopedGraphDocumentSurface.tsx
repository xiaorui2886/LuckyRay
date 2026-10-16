import { useCallback, useLayoutEffect, useRef } from 'react';
import type { GraphViewPresentationController } from './graphViewPresentation';
import { GraphViewport } from '../features/graph/GraphPage';
import { isCurrentGraphDataProof, type GraphDataProof, type GraphRuntime } from '../features/graph/GraphRuntime';

export type ScopedGraphDocumentSurfaceProps = {
  viewId: string;
  runtime: GraphRuntime;
  presentation?: GraphViewPresentationController;
  visible: boolean;
  focused?: boolean;
  layoutRevision?: string;
  onFocus: (viewId: string) => void;
  onRevisionReady: (proof: GraphDataProof) => void;
  onRevisionInvalidated?: () => void;
};

/** Injected child host only. Keep this view in a stable keyed host slot; changing
 * visibility, geometry, or runtime must not replace its canvas or use Main state. */
export function ScopedGraphDocumentSurface({
  viewId, runtime, presentation, visible, focused = true, layoutRevision, onFocus, onRevisionReady, onRevisionInvalidated,
}: ScopedGraphDocumentSurfaceProps) {
  const current = useRef({ viewId, runtime, visible, onRevisionReady, onRevisionInvalidated });
  current.current = { viewId, runtime, visible, onRevisionReady, onRevisionInvalidated };
  const revisionReady = useCallback((proof: GraphDataProof) => {
    const live = current.current;
    if (live.viewId !== viewId || live.runtime !== runtime || !live.visible
      || !isCurrentGraphDataProof(runtime, proof)) return;
    live.onRevisionReady({ ...proof });
  }, [viewId, runtime]);

  const revisionInvalidated = useCallback(() => {
    const live = current.current;
    if (live.viewId === viewId && live.runtime === runtime) live.onRevisionInvalidated?.();
  }, [viewId, runtime]);
  useLayoutEffect(() => {
    // Capture this binding's callback for cleanup; a replacement belongs to a
    // different lease. Callback-only rerenders do not revoke a valid paint.
    const invalidate = current.current.onRevisionInvalidated;
    invalidate?.();
    return () => invalidate?.();
  }, [viewId, runtime, visible, layoutRevision]);

  if (runtime?.kind !== 'scoped' || runtime.allowWorker !== false) {
    return <div role="alert">Scoped graph runtime unavailable.</div>;
  }

  return <div data-scoped-graph-view={viewId} aria-hidden={!visible} inert={!visible}
    onFocusCapture={() => { if (visible) onFocus(viewId); }}
    style={{ display: 'flex', position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0,
      overflow: 'hidden', visibility: visible ? 'visible' : 'hidden', pointerEvents: visible ? 'auto' : 'none' }}>
    <GraphViewport key={viewId} paneId={viewId} runtime={runtime} visible={visible}
      active={visible && focused} presentation={presentation} layoutRevision={layoutRevision} onRevisionReady={revisionReady} onRevisionInvalidated={revisionInvalidated}
      primary headerInTitlebar persistView={false} canClose={false}
      onActivate={id => { if (visible && id === viewId) onFocus(viewId); }}
      onClose={() => false} />
  </div>;
}
