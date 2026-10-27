import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {CanvasAnchoredSurface} from "./CanvasAnchoredSurface";
import { CanvasComposerPopover } from "./CanvasComposerPopover";
import { CanvasImageCreativeMenu, CreativeActionIcon } from "./CanvasImageCreativeMenu";
import type { ImageCreativeRecipe } from "../../core/canvas/imageCreativeActions";
import { CanvasCreativeDialog } from "./CanvasCreativeDialog";
import {
  readMediaBytes,
  type DeliveryItem,
} from "../../core/canvas/mediaDelivery";
import {
  equalGrid,
  gridCells,
  GRID_LIMITS,
  moveGridLine,
  renderGridCell,
  type GridSpec,
  type GridOutput,
} from "../../core/canvas/imageGrid";
import "./canvasGridSplit.css";
export function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </svg>
  );
}
/** Only reveal actions once the selected image has actually decoded. */
export function CanvasImageToolbar({
  nodeId,
  stage,
  source,
  onSplit,
  onCompare,
  onCreativeRecipe,
  onInteract,
  english = false,
}: {
  nodeId: string;
  stage: RefObject<HTMLDivElement|null>;
  source: string;
  onSplit: () => void;
  onCompare?: () => void;
  onCreativeRecipe?: (recipe: ImageCreativeRecipe) => void;
  onInteract?: () => void;
  english?: boolean;
}) {
  const [creativeOpen, setCreativeOpen] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const creativeAnchor = useRef<HTMLButtonElement>(null);
  const creativePortal = useRef<HTMLDivElement>(null);
  useEffect(() => { setCreativeOpen(false); }, [source, nodeId]);
  useEffect(() => {
    if (!creativeOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!toolbar.current?.contains(target) && !creativePortal.current?.contains(target)) setCreativeOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      const target = event.target as Node;
      if (!toolbar.current?.contains(target) && !creativePortal.current?.contains(target)) return;
      event.preventDefault(); event.stopPropagation(); setCreativeOpen(false); creativeAnchor.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [creativeOpen]);
  const [decodedSource, setDecodedSource] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setDecodedSource(null);
    const image = new Image();
    image.src = source;
    void image
      .decode()
      .then(() => {
        if (active && image.naturalWidth > 0) setDecodedSource(source);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [source]);
  return decodedSource === source ? (
    <CanvasAnchoredSurface nodeId={nodeId} stage={stage} width={(onCompare ? 264 : 152) + (onCreativeRecipe ? 86 : 0)} preferred="top" avoidNodeHeader className="canvas-image-tools-surface">
      <div
        ref={toolbar}
        className="canvas-grid-toolbar nodrag nopan"
        role="toolbar"
        aria-label={english ? "Image tools" : "图片工具"}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {onCreativeRecipe && <button ref={creativeAnchor} type="button" aria-expanded={creativeOpen} aria-label={english ? 'Creative tools' : '创作工具'} onClick={() => { onInteract?.(); setCreativeOpen(v => !v); }}><CreativeActionIcon />{english ? 'Create' : '创作'}</button>}
        <button type="button" onClick={() => { onInteract?.(); onSplit(); }}>
          <GridIcon />
          {english ? "Split grid" : "宫格切分"}
        </button>
        {onCompare && (
          <button type="button" onClick={() => { onInteract?.(); onCompare(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M12 3v18M6 15l3-3 3 3M12 12l3-3 3 3" />
            </svg>
            {english ? "Compare" : "版本对比"}
          </button>
        )}
      </div>
      {creativeOpen && onCreativeRecipe && <CanvasComposerPopover enabled owner={`${nodeId}-creative-tools`} anchor={creativeAnchor} composer={toolbar} portal={creativePortal} width={340}>
        <CanvasImageCreativeMenu english={english} onSelect={recipe => { onInteract?.(); setCreativeOpen(false); onCreativeRecipe(recipe); }} />
      </CanvasComposerPopover>}
    </CanvasAnchoredSurface>
  ) : null;
}
export function CanvasGridSplit({
  item,
  onClose,
  onSplit,
  english = false,
}: {
  item: DeliveryItem;
  onClose: () => void;
  onSplit: (
    outputs: GridOutput[],
    spec: GridSpec,
    signal: AbortSignal,
  ) => Promise<void>;
  english?: boolean;
}) {
  const [spec, setSpec] = useState(() => equalGrid(3, 3)),
    [size, setSize] = useState({ width: 0, height: 0 }),
    [url, setUrl] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [excluded, setExcluded] = useState<number[]>([]),
    [custom, setCustom] = useState(false);
  const image = useRef<HTMLImageElement | null>(null),
    stage = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    saving = useRef(false),
    operation = useRef<AbortController | null>(null);
  const rows = spec.y.length - 1,
    columns = spec.x.length - 1;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let objectUrl = "";
    void (async () => {
      try {
        const bytes = await readMediaBytes(
          item.source,
          controller.signal,
          GRID_LIMITS.bytes,
        );
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const img = new Image();
        img.src = objectUrl;
        await img.decode();
        if (controller.signal.aborted) return;
        if (img.naturalWidth * img.naturalHeight > GRID_LIMITS.pixels)
          throw Error();
        image.current = img;
        setSize({ width: img.naturalWidth, height: img.naturalHeight });
        setUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted)
          setNotice(
            english
              ? "Unable to load the original image (maximum 64 MP / 64 MB)."
              : "无法读取原图，请检查文件是否可用（上限 6400 万像素 / 64 MB）。",
          );
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
      operation.current?.abort();
      image.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.source, english]);
  const cells = useMemo(() => {
    try {
      return gridCells(size.width, size.height, spec);
    } catch {
      return [];
    }
  }, [size, spec]);
  const picked = cells.filter((c) => !excluded.includes(c.index));
  const reset = (r: number, c: number) => {
    try {
      setSpec(equalGrid(r, c));
      setExcluded([]);
      setNotice("");
    } catch {}
  };
  const close = () => {
    operation.current?.abort();
    onClose();
  };
  const split = async () => {
    if (saving.current || !image.current || !picked.length) return;
    saving.current = true;
    setBusy(true);
    setNotice("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      const outputs: GridOutput[] = [];
      let bytes = 0;
      for (const cell of picked) {
        if (controller.signal.aborted) throw Error("cancelled");
        const canvas = renderGridCell(image.current, cell);
        const png = canvas.toDataURL("image/png");
        canvas.width = canvas.height = 1;
        bytes += png.length * 0.75;
        if (bytes > GRID_LIMITS.bytes) throw Error("output-too-large");
        outputs.push({ cell, png });
        await new Promise((r) => setTimeout(r, 0));
      }
      await onSplit(outputs, spec, controller.signal);
      if (alive.current && !controller.signal.aborted) onClose();
    } catch {
      if (alive.current && !controller.signal.aborted)
        setNotice(
          english
            ? "Split failed. No cards were added. Check the source and try again."
            : "切分未完成，未添加任何卡片。请检查原图和保存空间后重试。",
        );
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const line = (axis: "x" | "y", value: number, index: number) => {
    const pixels = axis === "x" ? size.width : size.height;
    return (
      <div
        key={axis + index}
        className={"canvas-grid-line is-" + axis + " nodrag nopan"}
        role="slider"
        tabIndex={busy ? -1 : 0}
        aria-label={
          english
            ? `${axis === "x" ? "Column" : "Row"} boundary ${index}`
            : `${axis === "x" ? "列" : "行"}分割线 ${index}`
        }
        aria-orientation={axis === "x" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(spec[axis][index - 1] * pixels) + 1}
        aria-valuemax={Math.round(spec[axis][index + 1] * pixels) - 1}
        aria-valuenow={Math.round(value * pixels)}
        aria-disabled={busy}
        style={
          axis === "x"
            ? { left: value * 100 + "%" }
            : { top: value * 100 + "%" }
        }
        onPointerDown={(e) => {
          if (busy) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (busy || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const rect = stage.current?.getBoundingClientRect();
          if (!rect) return;
          const v =
            axis === "x"
              ? (e.clientX - rect.left) / rect.width
              : (e.clientY - rect.top) / rect.height;
          setSpec((s) => moveGridLine(s, axis, index, v, pixels));
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (busy) return;
          const delta = ["ArrowRight", "ArrowDown"].includes(e.key)
            ? 1
            : ["ArrowLeft", "ArrowUp"].includes(e.key)
              ? -1
              : 0;
          if (delta) {
            e.preventDefault();
            setSpec((s) =>
              moveGridLine(
                s,
                axis,
                index,
                s[axis][index] + (delta * (e.shiftKey ? 10 : 1)) / pixels,
                pixels,
              ),
            );
          }
        }}
      >
        <span />
      </div>
    );
  };
  return (
    <CanvasCreativeDialog
      title={english ? "Split image grid" : "宫格切分"}
      onClose={close}
      english={english}
      className="canvas-grid-dialog"
    >
      <div
        className="canvas-grid-options"
        role="group"
        aria-label={english ? "Grid layout" : "宫格布局"}
      >
        {[2, 3, 4, 5].map((n) => (
          <button
            key={n}
            disabled={busy}
            aria-pressed={!custom && rows === n && columns === n}
            onClick={() => {
              setCustom(false);
              reset(n, n);
            }}
          >
            {n} × {n}
            <small>
              {n * n}
              {english ? " tiles" : " 格"}
            </small>
          </button>
        ))}
        <button
          disabled={busy}
          aria-pressed={custom}
          onClick={() => setCustom((v) => !v)}
        >
          {english ? "Custom" : "自定义"}
        </button>
      </div>
      {custom ? (
        <div className="canvas-grid-custom">
          {(["rows", "columns"] as const).map((axis) => (
            <label key={axis}>
              {english ? axis : axis === "rows" ? "行" : "列"}
              <select
                disabled={busy}
                value={axis === "rows" ? rows : columns}
                onChange={(e) =>
                  reset(
                    axis === "rows" ? Number(e.target.value) : rows,
                    axis === "columns" ? Number(e.target.value) : columns,
                  )
                }
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option
                    key={n}
                    value={n}
                    disabled={
                      n === 1 && (axis === "rows" ? columns : rows) === 1
                    }
                  >
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      <div className="canvas-grid-preview-space">
        {url ? (
          <div
            ref={stage}
            className="canvas-grid-preview"
            style={{
              aspectRatio: String(size.width / size.height),
              width: `min(100cqw, calc(100cqh * ${size.width / size.height}))`,
              height: "auto",
            }}
          >
            <img
              src={url}
              alt={
                english ? "Original image with grid preview" : "原图切分预览"
              }
              draggable={false}
            />
            {cells.map((cell) => (
              <button
                key={cell.index}
                disabled={busy}
                className="canvas-grid-cell"
                aria-label={
                  english
                    ? `Tile ${cell.row + 1}-${cell.column + 1}`
                    : `第 ${cell.row + 1} 行第 ${cell.column + 1} 格`
                }
                aria-pressed={!excluded.includes(cell.index)}
                style={{
                  left: (cell.x / size.width) * 100 + "%",
                  top: (cell.y / size.height) * 100 + "%",
                  width: (cell.width / size.width) * 100 + "%",
                  height: (cell.height / size.height) * 100 + "%",
                }}
                onClick={() =>
                  setExcluded((old) =>
                    old.includes(cell.index)
                      ? old.filter((n) => n !== cell.index)
                      : [...old, cell.index],
                  )
                }
              >
                <span>
                  {cell.row + 1}–{cell.column + 1}
                </span>
              </button>
            ))}
            {spec.x.slice(1, -1).map((v, i) => line("x", v, i + 1))}
            {spec.y.slice(1, -1).map((v, i) => line("y", v, i + 1))}
          </div>
        ) : (
          <p>
            {notice || (english ? "Loading original image…" : "正在读取原图…")}
          </p>
        )}
      </div>
      <div className="canvas-grid-selection">
        <span>
          {english ? `${picked.length} selected` : `已选 ${picked.length} 格`}
        </span>
        <button
          disabled={busy || !cells.length}
          onClick={() => setExcluded([])}
        >
          {english ? "Select all" : "全选"}
        </button>
        <button
          disabled={busy || !cells.length}
          onClick={() => setExcluded(cells.map((c) => c.index))}
        >
          {english ? "Clear" : "全不选"}
        </button>
        <button disabled={busy} onClick={() => reset(rows, columns)}>
          {english ? "Reset divisions" : "重置均分"}
        </button>
      </div>
      {notice ? (
        <p className="canvas-creative-notice" role="alert">
          {notice}
        </p>
      ) : null}
      <footer className="canvas-grid-footer">
        <div>
          <strong>
            {size.width ? `${size.width} × ${size.height} px` : ""}
          </strong>
          <small>
            {english
              ? "Drag lines to adjust · Original kept · No AI credits"
              : "拖动分割线可微调 · 保留原图 · 不消耗模型额度"}
          </small>
          {size.width && !cells.length ? (
            <small role="alert">
              {english
                ? "Too many cells for this image."
                : "原图尺寸太小，请减少行列数。"}
            </small>
          ) : null}
        </div>
        <button onClick={close}>{english ? "Cancel" : "取消"}</button>
        <button
          className="is-primary"
          disabled={busy || !picked.length}
          onClick={() => void split()}
        >
          {busy
            ? english
              ? "Splitting…"
              : "正在切分…"
            : english
              ? `Create ${picked.length} images`
              : `切分为 ${picked.length} 张`}
        </button>
      </footer>
    </CanvasCreativeDialog>
  );
}
