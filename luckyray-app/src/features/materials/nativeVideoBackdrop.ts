/** Only background paint is opened at the picture. HTML remains above native
 * video, with real alpha, shadows and rounded edges; no root/child clip-path. */
export function nativeVideoBackdrop(surface: HTMLElement) {
  type Saved = { value: string; priority: string; applied: string };
  const styles = new Map<HTMLElement | SVGElement, Map<string, Saved>>();
  const colors = new Map<HTMLElement, string>();
  const set = (element: HTMLElement | SVGElement, name: string, value: string) => {
    let row = styles.get(element);
    if (!row) { row = new Map(); styles.set(element, row); }
    let saved = row.get(name);
    if (!saved) { saved = { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name), applied: '' }; row.set(name, saved); }
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value, 'important');
    saved.applied = element.style.getPropertyValue(name);
  };
  const restore = () => {
    for (const [element, row] of styles) for (const [name, saved] of row) {
      // Do not erase an unrelated React update made since our last paint.
      if (element.style.getPropertyValue(name) !== saved.applied) continue;
      if (saved.value) element.style.setProperty(name, saved.value, saved.priority);
      else element.style.removeProperty(name);
    }
    styles.clear(); colors.clear();
  };
  const viewer = surface.closest('.material-film,.material-viewer-react');
  const canvas = surface.matches('[data-native-canvas-picture]') ? surface.closest<HTMLElement>('.react-flow') : null;
  const chain = new Set<HTMLElement>();
  const ancestors = (element: HTMLElement | null) => {
    for (let e = element; e; e = e.parentElement) chain.add(e);
  };
  ancestors(surface);
  if (viewer) {
    // Keep library layout/scroll/selection, but not its paint behind the portal.
    ancestors(document.getElementById('page-materials') ?? document.getElementById('root'));
    for (const content of document.querySelectorAll<HTMLElement>('#page-materials > .materials-layout[inert]')) set(content, 'opacity', '0');
  } else {
    const wrapper = surface.closest('.hover-video-wrap-react');
    for (const cover of wrapper?.querySelectorAll<HTMLElement>(':scope > img,:scope > .hover-video-fallback-react') ?? []) set(cover, 'opacity', '0');
    // The wrapper's fallback is a gradient (transparent background-color).
    // Its whole picture is supplied by native playback, not the static poster.
    if (wrapper instanceof HTMLElement) set(wrapper, 'background-image', 'none');
  }
  // Overlay controls/inspector descendants are deliberately NOT in this set.
  for (const element of chain) colors.set(element, getComputedStyle(element).backgroundColor);
  const update = () => {
    const picture = surface.getBoundingClientRect();
    const viewport = canvas?.getBoundingClientRect();
    const radius = canvas ? (parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0) * picture.width / Math.max(1, surface.offsetWidth) : 0;
    // Browser backdrop blur cannot sample a sibling native window. Keep its
    // picture out of floating panels rather than leaking a sharp frame through
    // unrelated history thumbnails. Inline playback controls remain translucent.
    const covers = canvas ? [...document.querySelectorAll<HTMLElement>('.canvas-generation-history-panel,.canvas-settings-dialog[open],.canvas-agent-panel,[role="dialog"],[role="menu"],[role="listbox"]')]
      .filter(element => !element.contains(surface) && getComputedStyle(element).visibility !== 'hidden')
      .map(element => element.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0 && box.left < picture.right && box.right > picture.left && box.top < picture.bottom && box.bottom > picture.top) : [];
    // Only the visible canvas picture is transparent. Panning across navigation
    // must not open a hole outside the canvas, or resize the original picture.
    const paint = (box: DOMRect, color: string, maskOnly = false) => {
      const w = Math.max(1, box.width), h = Math.max(1, box.height);
      const clip = viewport ? `<clipPath id="viewport"><rect x="${viewport.left-box.left}" y="${viewport.top-box.top}" width="${viewport.width}" height="${viewport.height}"/></clipPath>` : '';
      const covered = covers.map(cover => `<rect x="${cover.left-box.left}" y="${cover.top-box.top}" width="${cover.width}" height="${cover.height}" fill="white"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${clip}<mask id="picture" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/><rect x="${picture.left-box.left}" y="${picture.top-box.top}" width="${picture.width}" height="${picture.height}" rx="${radius}" fill="black" ${viewport ? 'clip-path="url(#viewport)"' : ''}/>${covered}</mask></defs><rect width="${w}" height="${h}" fill="${maskOnly ? 'white' : color}" mask="url(#picture)"/></svg>`;
      return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    };
    for (const [element, color] of colors) {
      if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue;
      const box = element.getBoundingClientRect();
      // Background only: unlike masking #root, children keep their own paint
      // and hit testing. Native and browser use the same measured rectangle.
      set(element, 'transition', 'none');
      set(element, 'background-color', 'transparent');
      set(element, 'background-image', paint(box, color));
      set(element, 'background-size', '100% 100%');
      set(element, 'background-origin', 'border-box');
      set(element, 'background-position', '0px 0px');
      set(element, 'background-repeat', 'no-repeat');
    }
    // React Flow draws its grid/edges in sibling SVGs beneath cards. Mask only
    // those paint layers, never the viewport, controls, nodes or their hit areas.
    for (const layer of canvas?.querySelectorAll<SVGElement>('svg.react-flow__background,svg.react-flow__edges') ?? []) {
      set(layer, 'mask-image', paint(layer.getBoundingClientRect(), 'white', true));
      set(layer, 'mask-size', '100% 100%');
      set(layer, 'mask-repeat', 'no-repeat');
      set(layer, 'mask-mode', 'alpha');
    }
  };
  update();
  return { update, dispose: restore };
}
