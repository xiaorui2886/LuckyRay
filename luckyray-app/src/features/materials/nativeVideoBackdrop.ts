/** Only background paint is opened at the picture. HTML remains above native
 * video, with real alpha, shadows and rounded edges; no root/child clip-path. */
export function nativeVideoBackdrop(surface: HTMLElement) {
  type Saved = { value: string; priority: string; applied: string };
  const styles = new Map<HTMLElement, Map<string, Saved>>();
  const colors = new Map<HTMLElement, string>();
  const set = (element: HTMLElement, name: string, value: string) => {
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
    for (const [element, color] of colors) {
      if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue;
      const box = element.getBoundingClientRect();
      const w = Math.max(1, box.width), h = Math.max(1, box.height);
      const x = picture.left - box.left, y = picture.top - box.top;
      // Background only: unlike masking #root, children keep their own paint
      // and hit testing. Native and browser use the same measured rectangle.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path fill="${color}" fill-rule="evenodd" d="M0 0H${w}V${h}H0Z M${x} ${y}h${picture.width}v${picture.height}h${-picture.width}Z"/></svg>`;
      set(element, 'transition', 'none');
      set(element, 'background-color', 'transparent');
      set(element, 'background-image', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
      set(element, 'background-size', '100% 100%');
      set(element, 'background-origin', 'border-box');
      set(element, 'background-position', '0px 0px');
      set(element, 'background-repeat', 'no-repeat');
    }
  };
  update();
  return { update, dispose: restore };
}
