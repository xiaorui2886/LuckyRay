type Icon = "back" | "play" | "pause" | "previous" | "next" | "mark" | "capture" | "range" | "volume" | "muted" | "list" | "full" | "info";
const paths: Record<Icon, string> = {
  back: "m14 5-7 7 7 7", play: "m8 5 11 7-11 7Z", pause: "M8 5v14M16 5v14",
  previous: "M6 5v14m12-14-9 7 9 7Z", next: "M18 5v14M6 5l9 7-9 7Z",
  mark: "M6 21V3h13l-3 4 3 4H6", capture: "M4 7h4l2-3h4l2 3h4v13H4ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  range: "M8 4H4v16h4m8-16h4v16h-4M8 12h8", volume: "M4 9v6h4l5 4V5L8 9Zm12-1a6 6 0 0 1 0 8",
  muted: "M4 9v6h4l5 4V5L8 9Zm12 1 5 5m0-5-5 5", list: "M8 6h12M8 12h12M8 18h12M4 6h.1M4 12h.1M4 18h.1",
  full: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", info: "M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
};
export function FilmIcon({ name }: { name: Icon }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
