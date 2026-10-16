function decodeFileUriPath(value: string) {
  const raw = value.trim();
  if (!raw || !raw.toLowerCase().startsWith("file:")) return raw;

  try {
    const url = new URL(raw);
    const host = decodeURIComponent(url.hostname || "");
    let path = decodeURIComponent(url.pathname || "");
    if (host && host.toLowerCase() !== "localhost") {
      return `\\\\${host}${path.replace(/\//g, "\\")}`;
    }
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    if (/^\/[a-zA-Z]\|/.test(path)) path = `${path[1]}:${path.slice(3)}`;
    return path.replace(/\//g, "\\");
  } catch {
    const fallback = raw.replace(/^file:\/*/i, "");
    try {
      return decodeURIComponent(fallback);
    } catch {
      return fallback;
    }
  }
}

export function normalizeDroppedLocalPath(value: string) {
  let path = decodeFileUriPath(value).trim().replace(/\//g, "\\");
  if (!path) return "";

  if (/^\\\\\?\\UNC\\/i.test(path)) {
    path = `\\\\${path.slice(8)}`;
  } else if (/^\\\\\?\\/i.test(path)) {
    path = path.slice(4);
  }

  if (path.startsWith("\\\\")) {
    path = `\\\\${path.slice(2).replace(/\\{2,}/g, "\\")}`;
  } else {
    path = path.replace(/\\{2,}/g, "\\");
  }

  if (/^[a-zA-Z]:\\+$/.test(path)) return `${path.slice(0, 2)}\\`;
  return path.replace(/\\+$/, "");
}

export function dedupeDroppedLocalPaths(values: Iterable<string | null | undefined>) {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const path = normalizeDroppedLocalPath(value || "");
    if (!path) continue;
    const key = path.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }

  return paths;
}
