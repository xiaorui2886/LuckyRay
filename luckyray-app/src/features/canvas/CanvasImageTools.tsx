import { useEffect, useRef, useState } from "react";
import { CanvasCreativeDialog } from "./CanvasCreativeDialog";
import {
  centeredCrop,
  rotateImageEdit,
  imageEditWithCrop,
  renderImageEdit,
  canvasPngBlob,
  type ImageEdit,
} from "../../core/canvas/imageEditing";
import {
  readMediaBytes,
  type DeliveryItem,
} from "../../core/canvas/mediaDelivery";
const fullCrop = { x: 0, y: 0, width: 1, height: 1 };
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
    preview = useRef<HTMLDivElement>(null),
    mounted = useRef(true),
    saving = useRef(false);
  const [edit, setEdit] = useState<ImageEdit>({
      turns: 0,
      flipX: false,
      flipY: false,
      crop: fullCrop,
      width: 1,
      height: 1,
    }),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [lock, setLock] = useState(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!item) return;
    let cancelled = false,
      url = "";
    const controller = new AbortController();
    setLoaded(false);
    void (async () => {
      try {
        const bytes = await readMediaBytes(
          item.source,
          controller.signal,
          64 * 1024 * 1024,
        );
        url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const next = new Image();
        next.src = url;
        await next.decode();
        if (cancelled) return;
        if (next.naturalWidth * next.naturalHeight > 64_000_000)
          throw Error("image-too-large");
        image.current = next;
        const factor = Math.min(
          1,
          4096 / Math.max(next.naturalWidth, next.naturalHeight),
        );
        setEdit({
          turns: 0,
          flipX: false,
          flipY: false,
          crop: fullCrop,
          width: Math.round(next.naturalWidth * factor),
          height: Math.round(next.naturalHeight * factor),
        });
        setLoaded(true);
      } catch {
        if (!cancelled)
          setNotice(
            english
              ? "Unable to read this original image."
              : "暂时无法读取这张原图，请检查素材是否可用。",
          );
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      image.current = null;
    };
  }, [item?.source, english]);
  useEffect(() => {
    if (!loaded || !image.current || !preview.current) return;
    try {
      const ratio = edit.width / edit.height,
        factor = Math.min(1, 1000 / Math.max(edit.width, edit.height));
      const canvas = renderImageEdit(
        image.current,
        image.current.naturalWidth,
        image.current.naturalHeight,
        {
          ...edit,
          width: Math.max(1, Math.round(edit.width * factor)),
          height: Math.max(1, Math.round(edit.height * factor)),
        },
      );
      canvas.style.aspectRatio = String(ratio);
      canvas.setAttribute(
        "aria-label",
        english ? "Edited image preview" : "图片处理预览",
      );
      preview.current.replaceChildren(canvas);
      setNotice("");
    } catch {
      setNotice(
        english
          ? "Check crop and output dimensions."
          : "请检查裁剪范围和输出尺寸。",
      );
    }
  }, [edit, loaded, english]);
  const crop = (ratio?: number) => {
    const img = image.current;
    if (!img) return;
    const w = edit.turns % 2 ? img.naturalHeight : img.naturalWidth,
      h = edit.turns % 2 ? img.naturalWidth : img.naturalHeight,
      c = centeredCrop(w, h, ratio);
    const factor = Math.min(1, 4096 / Math.max(w * c.width, h * c.height));
    setEdit({
      ...edit,
      crop: c,
      width: Math.max(1, Math.round(w * c.width * factor)),
      height: Math.max(1, Math.round(h * c.height * factor)),
    });
  };
  const save = async () => {
    if (!item || !image.current || saving.current) return;
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
      const result = await onSave(item, await canvasPngBlob(output), edit);
      if (mounted.current) setNotice(result);
    } catch {
      if (mounted.current)
        setNotice(
          english
            ? "The copy could not be completed. Original unchanged."
            : "副本未能完成，原图未改变。",
        );
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const close = () => {
    if (!saving.current) onClose();
  };
  return (
    <CanvasCreativeDialog
      className="canvas-image-tools-dialog"
      title={english ? "Image tools" : "图片精修"}
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
        <div className="canvas-image-tools-layout">
          <div className="canvas-image-tools-preview" ref={preview}>
            {!loaded ? (english ? "Reading original…" : "正在读取原图…") : null}
          </div>
          <fieldset disabled={!loaded || busy}>
            <legend>{item.label}</legend>
            <div className="canvas-image-transform-buttons">
              <button
                type="button"
                onClick={() => setEdit(rotateImageEdit(edit))}
              >
                {english ? "Rotate 90°" : "旋转 90°"}
              </button>
              <button
                type="button"
                aria-pressed={edit.flipX}
                onClick={() => setEdit({ ...edit, flipX: !edit.flipX })}
              >
                {english ? "Flip horizontally" : "水平翻转"}
              </button>
              <button
                type="button"
                aria-pressed={edit.flipY}
                onClick={() => setEdit({ ...edit, flipY: !edit.flipY })}
              >
                {english ? "Flip vertically" : "垂直翻转"}
              </button>
            </div>
            <strong>{english ? "Crop" : "裁剪"}</strong>
            <div className="canvas-image-transform-buttons">
              {[
                ["原图", 0],
                ["1:1", 1],
                ["4:3", 4 / 3],
                ["3:4", 3 / 4],
                ["16:9", 16 / 9],
                ["9:16", 9 / 16],
              ].map(([name, ratio]) => (
                <button
                  type="button"
                  key={name}
                  onClick={() => crop(Number(ratio) || undefined)}
                >
                  {name === "原图" && english ? "Full image" : name}
                </button>
              ))}
            </div>
            {(["x", "y", "width", "height"] as const).map((key, index) => (
              <label key={key}>
                {
                  (english
                    ? ["Left", "Top", "Width", "Height"]
                    : ["左侧", "顶部", "宽度", "高度"])[index]
                }{" "}
                %
                <input
                  aria-label={`${key}-crop`}
                  type="number"
                  min={key === "width" || key === "height" ? 1 : 0}
                  max="100"
                  step="1"
                  value={Math.round(edit.crop[key] * 100)}
                  onChange={(event) => {
                    const value = Number(event.target.value) / 100;
                    const c = { ...edit.crop, [key]: value };
                    if (
                      value >= 0 &&
                      c.width > 0 &&
                      c.height > 0 &&
                      c.x + c.width <= 1.000001 &&
                      c.y + c.height <= 1.000001 &&
                      image.current
                    )
                      setEdit(
                        lock
                          ? imageEditWithCrop(
                              edit,
                              c,
                              image.current.naturalWidth,
                              image.current.naturalHeight,
                            )
                          : { ...edit, crop: c },
                      );
                  }}
                />
              </label>
            ))}
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
                onValue={(value) =>
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
                  })
                }
              />
            </label>
            <label>
              {english ? "Height" : "高度"}
              <DimensionInput
                label="output-height"
                value={edit.height}
                onValue={(value) =>
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
                  })
                }
              />
            </label>
            <label className="canvas-image-lock">
              <input
                type="checkbox"
                checked={lock}
                onChange={(e) => setLock(e.target.checked)}
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
