export type ClipboardImageSource = {
  value: string;
  origin: "html" | "uri-list" | "text";
};

const IMAGE_URL_PATTERN = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#]\S*)?$/i;
const DATA_IMAGE_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

function normalizeImageSource(value: string | null | undefined, requireImageUrl = false): string {
  const trimmed = (value || "").trim().replace(/^["']|["']$/g, "").replace(/&amp;/g, "&");
  if (!trimmed) return "";
  if (DATA_IMAGE_PATTERN.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return "";
  if (requireImageUrl && !IMAGE_URL_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function firstSrcsetCandidate(srcset: string | null | undefined) {
  const first = (srcset || "").split(",").map((part) => part.trim()).find(Boolean) || "";
  return first.split(/\s+/)[0] || "";
}

function extractImageSourceFromHtml(html: string) {
  if (!html.trim()) return "";
  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    const image = document.querySelector("img");
    const src = normalizeImageSource(
      image?.getAttribute("src")
        || image?.getAttribute("data-src")
        || image?.getAttribute("data-original")
        || firstSrcsetCandidate(image?.getAttribute("srcset")),
    );
    if (src) return src;
    const meta = document.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]');
    return normalizeImageSource(meta?.content);
  } catch {
    const match = /<img\b[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/i.exec(html);
    return normalizeImageSource(match?.[1]);
  }
}

function firstUriListSource(value: string) {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#"));
  return normalizeImageSource(line, true);
}

export function extractClipboardImageSource(data: DataTransfer | null): ClipboardImageSource | null {
  if (!data) return null;
  const html = data.getData("text/html");
  const htmlSource = extractImageSourceFromHtml(html);
  if (htmlSource) return { value: htmlSource, origin: "html" };

  const uriList = firstUriListSource(data.getData("text/uri-list"));
  if (uriList) return { value: uriList, origin: "uri-list" };

  const textSource = normalizeImageSource(data.getData("text/plain"), true);
  if (textSource) return { value: textSource, origin: "text" };

  return null;
}

export async function clipboardDataUrlToImageFile(dataUrl: string) {
  const mime = /^data:([^;,]+)/i.exec(dataUrl)?.[1] || "image/png";
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const extension = mime.includes("jpeg") ? "jpg" : (mime.split("/")[1] || "png").replace(/[^a-z0-9]+/gi, "") || "png";
  return new File([blob], `clipboard-image-${Date.now()}.${extension}`, { type: blob.type || mime });
}

export function isClipboardDataImageSource(source: ClipboardImageSource | null | undefined) {
  return DATA_IMAGE_PATTERN.test(source?.value || "");
}
