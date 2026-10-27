import { useEffect, useRef, useState } from "react";
import { CanvasCreativeDialog } from "./CanvasCreativeDialog";
import {
  prepareMediaDelivery,
  type DeliveryItem,
  DELIVERY_LIMITS,
} from "../../core/canvas/mediaDelivery";
export function CanvasDeliveryPanel({
  items,
  onSave,
  onClose,
  english = false,
}: {
  items: DeliveryItem[];
  onSave: (bytes: Uint8Array) => Promise<boolean>;
  onClose: () => void;
  english?: boolean;
}) {
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    saving = useRef(false),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(0),
    [notice, setNotice] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const run = async () => {
    if (controller.current) return;
    controller.current = new AbortController();
    setBusy(true);
    setDone(0);
    setNotice("");
    try {
      const bytes = await prepareMediaDelivery(
        items,
        controller.current.signal,
        (finished) => {
          if (mounted.current) setDone(finished);
        },
      );
      controller.current.signal.throwIfAborted();
      saving.current = true;
      const saved = await onSave(bytes);
      if (mounted.current)
        setNotice(
          saved
            ? english
              ? "ZIP saved. Original bytes preserved."
              : "ZIP 已保存，保留原始文件字节。"
            : english
              ? "Save cancelled."
              : "已取消保存。",
        );
    } catch (error) {
      if (mounted.current)
        setNotice(
          controller.current?.signal.aborted
            ? english
              ? "Cancelled."
              : "已取消。"
            : english
              ? "Export failed. No success is reported; check file availability or size limits."
              : "导出未完成，请检查素材可用性或大小限制。",
        );
    } finally {
      saving.current = false;
      controller.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <CanvasCreativeDialog
      compact
      title={english ? "Export results" : "成品导出"}
      subtitle={english ? `${items.length} selected · original files + manifest` : `已选 ${items.length} 项 · 原始文件与清单`}
      className="canvas-delivery-dialog"
      english={english}
      onClose={() => {
        if (saving.current) return;
        controller.current?.abort();
        onClose();
      }}
    >
      <p className="canvas-creative-hint">
        {english
          ? "Export selected image/video results as one ZIP, with readable filenames and a simple manifest. No model calls."
          : "将选中的图片／视频成品导出为一个 ZIP，保留原文件，附文件清单；不会调用模型。"}
      </p>
      <ul className="canvas-delivery-list">
        {items.map((item, index) => (
          <li key={item.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{item.label}</strong>
            <small>
              {item.kind === "image"
                ? english
                  ? "Image"
                  : "图片"
                : english
                  ? "Video"
                  : "视频"}
            </small>
          </li>
        ))}
      </ul>
      {!items.length ? (
        <p className="canvas-creative-empty">
          {english
            ? "Select finished media on the canvas first."
            : "先在画布选中需要导出的图片或视频成品。"}
        </p>
      ) : null}
      <p className="canvas-creative-hint">
        {english
          ? "Up to 50 files, 128 MiB each and 256 MiB total. A failed item stops the archive, with no silent omissions."
          : "最多 50 个文件，单个 128 MiB、合计 256 MiB。任一文件失败即停止，不会悄悄漏掉。"}
      </p>
      {busy && <div className="canvas-delivery-progress"><progress max={items.length || 1} value={done} aria-label={english ? "Preparing archive" : "正在准备文件"}/><span>{english ? `${done} of ${items.length} files ready` : `已准备 ${done} / ${items.length} 个文件`}</span></div>}
      <div className="canvas-delivery-actions">
        <button
          type="button"
          className="is-primary"
          disabled={
            busy || !items.length || items.length > DELIVERY_LIMITS.files
          }
          onClick={() => void run()}
        >
          {busy
            ? `${done}/${items.length}`
            : english
              ? "Export original files"
              : "导出原始文件"}
        </button>
        {busy && !saving.current ? (
          <button type="button" onClick={() => controller.current?.abort()}>
            {english ? "Cancel" : "取消"}
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="canvas-creative-notice">
          {notice}
        </p>
      ) : null}
    </CanvasCreativeDialog>
  );
}
