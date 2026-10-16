/** Presentation only. Never use this label to resolve, save or rewrite a link. */
export function readableAttachmentReference(target: string, resolvedName?: string | null) {
  let path = target.trim();
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = `${url.host ? `//${url.host}` : ""}${url.pathname}`;
      // URL.pathname starts with / before a Windows drive letter.
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch { /* A malformed target is still displayable without changing it. */ }
  }
  try { path = decodeURIComponent(path); } catch { /* Keep the exact undecodable text. */ }
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  const name = resolvedName?.trim() || parts[parts.length - 1] || target || "未命名附件";
  const directory = parts.slice(0, -1).join("/");
  return { name, directory };
}
