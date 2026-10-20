import { useEffect, useRef, useState } from "react";
import { CanvasCreativeDialog } from "./CanvasCreativeDialog";
import { CanvasImageCropOverlay } from "./CanvasImageCropOverlay";
import { moveCropRect, resizeCropRect, type CropRect } from "../../core/canvas/imageCropGeometry";
import {
  centeredCrop,
  rotateImageEdit,
  IMAGE_EDIT_LIMITS,
  renderImageEdit,
  canvasPngBlob,
  type ImageEdit,
} from "../../core/canvas/imageEditing";
import {
  readMediaBytes,
  type DeliveryItem,
} from "../../core/canvas/mediaDelivery";
const fullCrop = { x: 0, y: 0, width: 1, height: 1 };
const cropAspectOptions = [["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9], ["9:16", 9 / 16]] as const;
function cropPercent(value: number) {
  const percent = value * 100;
  // Keep ordinary percentages quiet, but never display a nonzero source pixel as 0%.
  const edgeDistance = Math.min(percent, 100 - percent);
  const precision = edgeDistance > 0 && edgeDistance < 0.01 ? Math.min(8, Math.ceil(-Math.log10(edgeDistance)) + 2) : 2;
  return Number(percent.toFixed(precision));
}
function DimensionInput({
  label,
  value,
  onValue,
}: {
  label: string;
  value: number;
  onValue: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      aria-label={label}
      type="number"
      min="1"
      max="8192"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const number = Number(draft);
        if (
          draft !== "" &&
          Number.isInteger(number) &&
          number > 0 &&
          number <= 8192
        )
          onValue(number);
        else setDraft(String(value));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function CanvasImageTools({
  item,
  onClose,
  onSave,
  english = false,
}: {
  item?: DeliveryItem;
  onClose: () => void;
  onSave: (item: DeliveryItem, blob: Blob, edit: ImageEdit) => Promise<string>;
  english?: boolean;
}) {
  const image = useRef<HTMLImageElement | null>(null),
    outputScale = useRef(1),
    mounted = useRef(true),
    saving = useRef(false),
    sourceEpoch = useRef(0);
  const [edit, setEdit] = useState<ImageEdit>({
      turns: 0,
      flipX: false,
      flipY: false,
      crop: fullCrop,
      width: 1,
      height: 1,
    }),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [lock, setLock] = useState(true),
    [cropAspect, setCropAspect] = useState<number | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const epoch = ++sourceEpoch.current;
    image.current = null;
    setCropAspect(undefined);
    saving.current = false;
    setBusy(false);
    setLoaded(false);
    setNotice("");
    setLoading(!!item);
    if (!item) return;
    let cancelled = false,
      url = "";
    const controller = new AbortController();
    void (async () => {
      try {
        const bytes = await readMediaBytes(
          item.source,
          controller.signal,
          64 * 1024 * 1024,
        );
        if (cancelled || epoch !== sourceEpoch.current) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const next = new Image();
        next.src = url;
        await next.decode();
        if (cancelled || epoch !== sourceEpoch.current) return;
        if (next.naturalWidth * next.naturalHeight > 64_000_000)
          throw Error("image-too-large");
        image.current = next;
        const factor = Math.min(
          1,
          4096 / Math.max(next.naturalWidth, next.naturalHeight),
        );
        outputScale.current = factor;
        setEdit({
          turns: 0,
          flipX: false,
          flipY: false,
          crop: fullCrop,
          width: Math.max(1, Math.round(next.naturalWidth * factor)),
          height: Math.max(1, Math.round(next.naturalHeight * factor)),
        });
        setLoaded(true);
      } catch {
        if (!cancelled && epoch === sourceEpoch.current)
          setNotice(
            english
              ? "Unable to read this original image."
              : "暂时无法读取这张原图，请检查素材是否可用。",
          );
      } finally {
        if (!cancelled && epoch === sourceEpoch.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      sourceEpoch.current++;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      image.current = null;
    };
  }, [item?.source, item?.id, item?.nodeId, english, retry]);
  const sourceSize = image.current ? {
    width: edit.turns % 2 ? image.current.naturalHeight : image.current.naturalWidth,
    height: edit.turns % 2 ? image.current.naturalWidth : image.current.naturalHeight,
  } : null;
  const updateCrop = (crop: CropRect) => {
    if (saving.current || !sourceSize) return;
    setEdit(current => {
      if (!lock || (current.crop.width === crop.width && current.crop.height === crop.height)) return { ...current, crop };
      const sourceWidth = sourceSize.width * crop.width, sourceHeight = sourceSize.height * crop.height;
      // A user-selected output scale survives crop changes. Never derive this from
      // the downsampled preview, or feed rounded output sizes back into the scale.
      const factor = Math.min(outputScale.current, IMAGE_EDIT_LIMITS.side / sourceWidth, IMAGE_EDIT_LIMITS.side / sourceHeight,
        Math.sqrt(IMAGE_EDIT_LIMITS.outputPixels / (sourceWidth * sourceHeight)));
      let width = Math.max(1, Math.min(IMAGE_EDIT_LIMITS.side, Math.round(sourceWidth * factor)));
      let height = Math.max(1, Math.min(IMAGE_EDIT_LIMITS.side, Math.round(sourceHeight * factor)));
      if (width * height > IMAGE_EDIT_LIMITS.outputPixels) {
        if (width >= height) width = Math.floor(IMAGE_EDIT_LIMITS.outputPixels / height);
        else height = Math.floor(IMAGE_EDIT_LIMITS.outputPixels / width);
      }
      return { ...current, crop, width, height };
    });
  };
  const chooseCropAspect = (ratio?: number) => {
    if (!sourceSize || saving.current) return;
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio < 1 / sourceSize.height || ratio > sourceSize.width)) {
      setNotice(english ? "This ratio cannot fit at least one source pixel on each side." : "这个比例无法在原图内保留至少 1 × 1 像素，请选择其他比例。");
      return;
    }
    setCropAspect(ratio);
    if (ratio) updateCrop(centeredCrop(sourceSize.width, sourceSize.height, ratio));
    setNotice("");
  };
  const resetCrop = () => {
    if (saving.current) return;
    setCropAspect(undefined);
    updateCrop(fullCrop);
  };
  const changeCropField = (key: keyof CropRect, value: number) => {
    if (!sourceSize || !Number.isFinite(value)) return;
    try {
      const next = key === "x" || key === "y"
        ? moveCropRect(edit.crop, { x: key === "x" ? value - edit.crop.x : 0, y: key === "y" ? value - edit.crop.y : 0 }, sourceSize)
        : resizeCropRect(edit.crop, key === "width" ? "e" : "s", { x: key === "width" ? value - edit.crop.width : 0, y: key === "height" ? value - edit.crop.height : 0 }, sourceSize, cropAspect);
      updateCrop(next);
      setNotice("");
    } catch {
      setNotice(english ? "That crop does not fit the original image at this ratio." : "当前比例下，这个裁剪范围无法容纳在原图中。");
    }
  };
  const save = async () => {
    if (!item || !loaded || !image.current || saving.current) return;
    const epoch = sourceEpoch.current;
    const current = () => mounted.current && epoch === sourceEpoch.current;
    saving.current = true;
    setBusy(true);
    setNotice("");
    try {
      const output = renderImageEdit(
        image.current,
        image.current.naturalWidth,
        image.current.naturalHeight,
        edit,
      );
      const blob = await canvasPngBlob(output);
      // Encoding is async. Navigation or a different selection invalidates this save.
      if (!current()) return;
      const result = await onSave(item, blob, edit);
      if (current()) setNotice(result);
    } catch {
      if (current())
        setNotice(
          english
            ? "The copy could not be completed. Original unchanged."
            : "副本未能完成，原图未改变。",
        );
    } finally {
      if (current()) {
        saving.current = false;
        setBusy(false);
      }
    }
  };
  const close = () => {
    if (!saving.current) onClose();
  };
  return (
    <CanvasCreativeDialog
      className="canvas-image-tools-dialog"
      title={english ? "Image tools" : "图片精修"}
      subtitle={english ? "Local adjustments · original unchanged" : "本地调整 · 始终保留原图"}
      onClose={close}
      english={english}
    >
      {!item ? (
        <div className="canvas-creative-empty">
          {english
            ? "Select one image or image result on the canvas first."
            : "先回画布选中一张图片或图片生成结果。"}
        </div>
      ) : (
        <div className="canvas-image-tools-layout" aria-busy={busy || loading}>
          <div className="canvas-image-tools-preview">
            {loaded && image.current && sourceSize ? <CanvasImageCropOverlay
              source={image.current} sourceSize={sourceSize} turns={edit.turns} flipX={edit.flipX} flipY={edit.flipY}
              crop={edit.crop} aspectRatio={cropAspect} sessionKey={`${sourceEpoch.current}:${edit.turns}:${edit.flipX}:${edit.flipY}`}
              disabled={busy} english={english} onChange={updateCrop}
            /> : null}
            {loading ? <span role="status">{english ? "Reading original…" : "正在读取原图…"}</span> : !loaded ? <div>
              <span>{english ? "Original image unavailable" : "原图暂时不可用"}</span>
              <button type="button" onClick={() => setRetry(value => value + 1)}>{english ? "Retry reading original" : "重新读取原图"}</button>
            </div> : null}
          </div>
          <fieldset disabled={!loaded || busy}>
            <legend>{item.label}</legend>
            <div className="canvas-image-transform-buttons">
              <button
                type="button"
                onClick={() => {
                  if (saving.current) return;
                  setEdit(rotateImageEdit(edit));
                  if (cropAspect) setCropAspect(1 / cropAspect);
                }}
              >
                {english ? "Rotate 90°" : "旋转 90°"}
              </button>
              <button
                type="button"
                aria-pressed={edit.flipX}
                onClick={() => { if (!saving.current) setEdit({ ...edit, flipX: !edit.flipX }); }}
              >
                {english ? "Flip horizontally" : "水平翻转"}
              </button>
              <button
                type="button"
                aria-pressed={edit.flipY}
                onClick={() => { if (!saving.current) setEdit({ ...edit, flipY: !edit.flipY }); }}
              >
                {english ? "Flip vertically" : "垂直翻转"}
              </button>
            </div>
            <div className="canvas-image-crop-heading">
              <strong>{english ? "Crop" : "裁剪"}</strong>
              <button type="button" onClick={resetCrop}>{english ? "Reset crop" : "重置裁剪"}</button>
            </div>
            <label>
              {english ? "Aspect ratio" : "裁剪比例"}
              <select aria-label={english ? "Crop aspect ratio" : "裁剪比例"} value={cropAspect === undefined ? "free" : String(cropAspect)}
                onChange={event => chooseCropAspect(event.target.value === "free" ? undefined : Number(event.target.value))}>
                <option value="free">{english ? "Free" : "自由"}</option>
                {cropAspectOptions.map(([name, ratio]) => <option key={name} value={String(ratio)}
                  disabled={!!sourceSize && (ratio < 1 / sourceSize.height || ratio > sourceSize.width)}>{name}</option>)}
              </select>
            </label>
            <div className="canvas-image-crop-fields">
              {(["x", "y", "width", "height"] as const).map((key, index) => (
                <label key={key}>
                  {(english ? ["Left", "Top", "Width", "Height"] : ["左侧", "顶部", "宽度", "高度"])[index]} %
                  <input aria-label={`${key}-crop`} type="number"
                    min={sourceSize && (key === "width" || key === "height") ? 100 / sourceSize[key] : 0} max="100" step="any"
                    value={cropPercent(edit.crop[key])}
                    onChange={event => {
                      if (!event.target.value) return;
                      const value = Number(event.target.value) / 100;
                      if (value >= 0 && value <= 1 && ((key === "x" || key === "y") || value > 0)) changeCropField(key, value);
                    }} />
                </label>
              ))}
            </div>
            <strong>{english ? "Output size · PNG" : "输出尺寸 · PNG"}</strong>
            <small>
              {image.current
                ? `${image.current.naturalWidth} × ${image.current.naturalHeight} ${english ? "original" : "原图"} · ${edit.width} × ${edit.height} ${english ? "output" : "输出"}`
                : ""}
            </small>
            <label>
              {english ? "Width" : "宽度"}
              <DimensionInput
                label="output-width"
                value={edit.width}
                onValue={(value) => {
                  if (saving.current) return;
                  if (sourceSize) outputScale.current = value / (sourceSize.width * edit.crop.width);
                  setEdit({
                    ...edit,
                    width: value,
                    ...(lock
                      ? {
                          height: Math.max(
                            1,
                            Math.round((value * edit.height) / edit.width),
                          ),
                        }
                      : {}),
                  });
                }}
              />
            </label>
            <label>
              {english ? "Height" : "高度"}
              <DimensionInput
                label="output-height"
                value={edit.height}
                onValue={(value) => {
                  if (saving.current) return;
                  if (sourceSize) outputScale.current = value / (sourceSize.height * edit.crop.height);
                  setEdit({
                    ...edit,
                    height: value,
                    ...(lock
                      ? {
                          width: Math.max(
                            1,
                            Math.round((value * edit.width) / edit.height),
                          ),
                        }
                      : {}),
                  });
                }}
              />
            </label>
            <label className="canvas-image-lock">
              <input
                type="checkbox"
                checked={lock}
                onChange={(e) => {
                  if (saving.current) return;
                  if (e.target.checked && sourceSize) outputScale.current = edit.width / (sourceSize.width * edit.crop.width);
                  setLock(e.target.checked);
                }}
              />
              {english ? "Keep output proportions" : "锁定输出比例"}
            </label>
            <p>
              {english
                ? "Saves a new PNG and imports a copy through the material library. Original stays unchanged. Output is limited to 8192 px per side and 32 megapixels."
                : "另存 PNG，并经素材库导入副本后加入画布；原图保留。单边最多 8192 像素，总计不超过 3200 万像素。"}
            </p>
            <button
              type="button"
              className="is-primary"
              onClick={() => void save()}
            >
              {busy
                ? english
                  ? "Saving…"
                  : "正在保存…"
                : english
                  ? "Save copy to canvas"
                  : "保存副本到画布"}
            </button>
          </fieldset>
        </div>
      )}
      {notice ? (
        <p role="status" className="canvas-creative-notice">
          {notice}
        </p>
      ) : null}
    </CanvasCreativeDialog>
  );
}
