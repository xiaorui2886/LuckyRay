import "./imageViewer.css";

type ImageViewerInput = { src: string; alt: string };
let closeActiveViewer: (() => void) | undefined;

/** A note image modal. The disposer is safe to call when its editor widget dies. */
export function openImageViewer({ src, alt }: ImageViewerInput, opener?: HTMLElement): () => void {
  closeActiveViewer?.();
  const restoreFocus = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const dialog = document.createElement("dialog");
  dialog.className = "note-image-viewer";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", alt ? `图片查看：${alt}` : "图片查看");
  const toolbar = document.createElement("div");
  toolbar.className = "note-image-viewer-toolbar";
  const title = document.createElement("span");
  title.className = "note-image-viewer-title";
  title.textContent = alt || "图片";
  const fit = document.createElement("button");
  fit.type = "button";
  fit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
  fit.title = "适配图片";
  fit.setAttribute("aria-label", "恢复图片适配大小");
  const close = document.createElement("button");
  close.type = "button";
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  close.title = "关闭 (Esc)";
  close.setAttribute("aria-label", "关闭图片查看 (Escape)");
  toolbar.append(title, fit, close);
  const stage = document.createElement("div");
  stage.className = "note-image-viewer-stage";
  const img = document.createElement("img");
  img.alt = alt;
  img.draggable = false;
  const message = document.createElement("div");
  message.className = "note-image-viewer-status";
  message.setAttribute("role", "status");
  message.textContent = "正在加载图片…";
  const hint = document.createElement("div");
  hint.className = "note-image-viewer-hint";
  hint.textContent = "双击放大 · 放大后拖动 · 再次双击适配 · 点击空白或 Esc 返回";
  stage.append(img, message);
  dialog.append(toolbar, stage, hint);
  let zoom = 1, x = 0, y = 0, width = 0, height = 0;
  let loaded = false, disposed = false;
  let viewportWidth = 0, viewportHeight = 0;
  let drag: { id: number; x: number; y: number; originX: number; originY: number } | undefined;
  const render = () => {
    const boundX = Math.max(0, (width * zoom - stage.clientWidth) / 2);
    const boundY = Math.max(0, (height * zoom - stage.clientHeight) / 2);
    x = Math.max(-boundX, Math.min(boundX, x));
    y = Math.max(-boundY, Math.min(boundY, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    stage.dataset.zoomed = String(zoom > 1);
    fit.disabled = !loaded || zoom === 1;
  };
  const adapt = () => {
    if (!loaded) return;
    viewportWidth = stage.clientWidth; viewportHeight = stage.clientHeight;
    const ratio = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight, 1);
    width = img.naturalWidth * ratio;
    height = img.naturalHeight * ratio;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    zoom = 1; x = 0; y = 0;
    render();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    dialog.close();
    dialog.remove();
    if (closeActiveViewer === dispose) closeActiveViewer = undefined;
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  };
  const observer = new ResizeObserver(() => {
    if (stage.clientWidth !== viewportWidth || stage.clientHeight !== viewportHeight) adapt();
  });
  img.addEventListener("load", () => {
    if (disposed) return;
    loaded = true;
    message.hidden = true;
    img.hidden = false;
    adapt();
  });
  img.addEventListener("error", () => {
    loaded = false;
    img.hidden = true;
    message.hidden = false;
    message.textContent = "图片无法加载，文件可能已移动或暂时不可用。";
    fit.disabled = true;
  });
  img.hidden = true;
  fit.disabled = true;
  fit.addEventListener("click", adapt);
  close.addEventListener("click", dispose);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dispose(); });
  dialog.addEventListener("close", dispose);
  // Never dismiss a pan that starts on the image and ends over the backdrop.
  let blankPress: { x: number; y: number } | undefined;
  const isBlank = (target: EventTarget | null) => target === stage || target === dialog || target === hint;
  dialog.addEventListener("pointerdown", (event) => {
    blankPress = event.button === 0 && isBlank(event.target) ? { x: event.clientX, y: event.clientY } : undefined;
  }, true);
  dialog.addEventListener("pointermove", (event) => {
    if (blankPress && Math.hypot(event.clientX - blankPress.x, event.clientY - blankPress.y) > 4) blankPress = undefined;
  }, true);
  dialog.addEventListener("pointercancel", () => { blankPress = undefined; });
  dialog.addEventListener("click", (event) => {
    if (blankPress && isBlank(event.target)) dispose();
    blankPress = undefined;
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const buttons = [fit, close].filter(button => !button.disabled);
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  stage.addEventListener("dblclick", (event) => {
    if (!loaded) return;
    // Pointer capture routes a zoomed image's double-click to the stage.
    // Hit-test the displayed image rather than relying on the event target.
    const imageRect = img.getBoundingClientRect();
    if (event.clientX < imageRect.left || event.clientX > imageRect.right || event.clientY < imageRect.top || event.clientY > imageRect.bottom) return;
    if (zoom > 1) { adapt(); return; }
    const rect = stage.getBoundingClientRect();
    zoom = 2.5;
    x = (event.clientX - rect.left - rect.width / 2) * (1 - zoom);
    y = (event.clientY - rect.top - rect.height / 2) * (1 - zoom);
    render();
    event.preventDefault();
  });
  stage.addEventListener("pointerdown", (event) => {
    if (zoom === 1 || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: x, originY: y };
    stage.setPointerCapture(event.pointerId);
    stage.dataset.dragging = "true";
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    x = drag.originX + event.clientX - drag.x;
    y = drag.originY + event.clientY - drag.y;
    render();
  });
  const endDrag = () => { drag = undefined; stage.dataset.dragging = "false"; };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("lostpointercapture", endDrag);
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  observer.observe(stage);
  img.src = src;
  closeActiveViewer = dispose;
  return dispose;
}
