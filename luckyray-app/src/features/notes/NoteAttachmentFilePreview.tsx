import { useState } from "react";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import { performMaterialExternalAction, type MaterialAsset } from "../../core/services/materials";
import { MaterialFilePreview } from "../materials/MaterialFilePreview";

/** The attachment belongs to this vault, not the ordinary library behind Notes. */
export function NoteAttachmentFilePreview({ asset, vaultId, onClose }: {
  asset: MaterialAsset; vaultId: string; onClose: () => void;
}) {
  const surface = useApplicationModalSurface<HTMLElement>(true, onClose);
  const [error, setError] = useState("");
  const openOriginal = async () => {
    setError("");
    try { await performMaterialExternalAction(asset.id, "open", null, vaultId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开原文件，请重试"); }
  };
  return <div className="editorial-dialog-backdrop note-attachment-preview-backdrop" onPointerDown={surface.onBackdropPointerDown}>
    <section ref={surface.surfaceRef} className="note-attachment-preview-dialog" role="dialog" aria-modal="true" aria-label="附件文件预览" tabIndex={-1} onKeyDown={surface.onSurfaceKeyDown}>
      <header><h2>文件预览</h2><button type="button" onClick={onClose} aria-label="关闭附件预览">×</button></header>
      <div className="note-attachment-preview-body"><MaterialFilePreview asset={asset} vaultId={vaultId} variant="detail" onOpen={() => void openOriginal()} /></div>
      {error && <p role="alert" className="note-attachment-preview-error">{error}</p>}
    </section>
  </div>;
}
