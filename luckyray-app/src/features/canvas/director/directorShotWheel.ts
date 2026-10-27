/** Keep native horizontal trackpad scrolling and browser pinch zoom untouched. */
export function scrollDirectorShots(element: HTMLElement, event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) > 0 || !event.deltaY) return;
  const max = element.scrollWidth - element.clientWidth;
  if (max <= 0) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
  const next = Math.max(0, Math.min(max, element.scrollLeft + delta));
  if (next === element.scrollLeft) return; // Let the enclosing panel handle boundary scrolling.
  element.scrollLeft = next;
  event.preventDefault(); event.stopPropagation();
}
