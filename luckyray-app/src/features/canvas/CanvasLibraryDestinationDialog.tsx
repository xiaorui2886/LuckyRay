import { useEffect, useId, useRef, useState } from 'react';
import { canvasFolderBreadcrumbs, canvasFolderChildren, type CanvasLibraryFolder, type CanvasLibraryFolderSnapshot, type CanvasLibraryDestination } from '../../core/canvas/libraryFolders';
import { validateCanvasMaterialNames } from '../../core/canvas/materialNaming';
import './canvasLibraryFolders.css';
import { CanvasDialogPortal } from './CanvasDialogScope';

export function CanvasLibraryFolderBrowser({ folders, currentFolderId, onNavigate, rootLabel, english = false }: {
  folders: readonly CanvasLibraryFolder[]; currentFolderId: string | null; onNavigate: (folderId: string | null) => void; rootLabel?: string; english?: boolean;
}) {
  const root = rootLabel || (english ? 'Library root' : '素材库根目录');
  const path = canvasFolderBreadcrumbs(folders, currentFolderId);
  const children = canvasFolderChildren(folders, currentFolderId);
  return <div className="canvas-library-folder-browser">
    <nav className="canvas-library-breadcrumbs" aria-label={english ? 'Folder path' : '文件夹路径'}>
      <button type="button" aria-current={currentFolderId === null ? 'location' : undefined} onClick={() => onNavigate(null)}>{root}</button>
      {path.map(folder => <span key={folder.id}><span aria-hidden="true">/</span><button type="button" aria-current={folder.id === currentFolderId ? 'location' : undefined} onClick={() => onNavigate(folder.id)}>{folder.name}</button></span>)}
    </nav>
    <div className="canvas-library-folder-list" aria-label={english ? 'Folders' : '文件夹'}>
      {currentFolderId !== null && <button className="canvas-library-folder-row canvas-library-folder-up" type="button" onClick={() => onNavigate(path[path.length - 1]?.parentId || null)}><span aria-hidden="true">↑</span><span>{english ? 'Parent folder' : '上一级'}</span></button>}
      {children.map(folder => <button className="canvas-library-folder-row" type="button" key={folder.id} onClick={() => onNavigate(folder.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" /></svg><span>{folder.name}</span><span aria-hidden="true">›</span></button>)}
      {!children.length && <p className="canvas-library-folder-empty">{english ? 'No subfolders' : '没有子文件夹'}</p>}
    </div>
  </div>;
}

export function CanvasLibraryDestinationDialog({ initialNames, snapshot, loading = false, error, english = false, onConfirm, onCancel, onRetry }: {
  initialNames: readonly string[]; snapshot: CanvasLibraryFolderSnapshot | null; loading?: boolean; error?: string | null; english?: boolean;
  onConfirm: (selection: CanvasLibraryDestination & { names: string[] }) => void; onCancel: () => void; onRetry?: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const dialog = useRef<HTMLFormElement>(null), backdropStart = useRef(false), submitted = useRef(false), titleId = useId(), hintId = useId();
  const namesError = validateCanvasMaterialNames(initialNames, initialNames.length);
  const validFolder = folderId === null || !!snapshot?.folders.some(folder => folder.id === folderId);
  const canSave = !!snapshot?.libraryId && !loading && !error && !namesError && validFolder;
  useEffect(() => { setFolderId(null); }, [snapshot?.libraryId]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const rootLabel = snapshot?.libraryName || (english ? 'Library root' : '素材库根目录');
  const current = canvasFolderBreadcrumbs(snapshot?.folders || [], folderId);
  return <CanvasDialogPortal layer={1600}><div className="canvas-modal-backdrop canvas-library-destination-backdrop nodrag nopan" role="presentation" onPointerDown={event => { backdropStart.current = event.target === event.currentTarget && event.button === 0; }} onClick={event => { if (backdropStart.current && event.target === event.currentTarget) onCancel(); backdropStart.current = false; }}>
    <form ref={dialog} className="canvas-modal canvas-library-destination-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (canSave && snapshot && !submitted.current) { submitted.current = true; onConfirm({ names: initialNames.map(name => name.trim()), folderId, libraryId: snapshot.libraryId }); } }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); onCancel(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []), first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="canvas-modal-header"><div className="canvas-modal-title" id={titleId}>{english ? 'Save to material library' : '保存到素材库'}</div></div>
      <div className="canvas-modal-body">
        <p className="canvas-modal-note" id={hintId}>{english ? 'Choose a folder. Names follow your canvas nodes.' : '选择保存文件夹，名称沿用画布节点名称。'}</p>
        <div className="canvas-library-name-summary" aria-label={english ? 'Material names' : '素材名称'}>{initialNames.map((name, index) => <span title={name} key={index}>{name}</span>)}</div>
        {loading ? <p className="canvas-modal-note" role="status">{english ? 'Loading folders…' : '正在加载文件夹…'}</p> : error ? <div role="alert" className="canvas-library-folder-error">{error}{onRetry && <button type="button" className="canvas-modal-button" onClick={onRetry}>{english ? 'Retry' : '重试'}</button>}</div> : snapshot ? <CanvasLibraryFolderBrowser folders={snapshot.folders} currentFolderId={folderId} onNavigate={setFolderId} rootLabel={rootLabel} english={english} /> : <p role="status" className="canvas-modal-note">{english ? 'Folder list is unavailable.' : '文件夹列表暂不可用。'}</p>}
        {namesError && <p role="alert" className="canvas-library-folder-error">{english ? 'Check the node names before saving.' : '请先检查节点名称。'}</p>}
        {!validFolder && <p role="alert" className="canvas-library-folder-error">{english ? 'This folder is no longer available. Choose another folder.' : '此文件夹已不可用，请重新选择。'}</p>}
        <p className="canvas-library-destination-path" aria-live="polite">{english ? 'Save in: ' : '保存位置：'}{[rootLabel, ...current.map(folder => folder.name)].join(' / ')}</p>
      </div>
      <div className="canvas-modal-actions"><button className="canvas-modal-button" type="button" onClick={onCancel}>{english ? 'Cancel' : '取消'}</button><button className="canvas-modal-button primary" type="submit" disabled={!canSave}>{english ? 'Save here' : '保存到此处'}</button></div>
    </form>
  </div></CanvasDialogPortal>;
}
