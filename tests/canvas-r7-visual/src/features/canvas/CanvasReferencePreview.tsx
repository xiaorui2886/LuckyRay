import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export function referencePreviewUrl(value: string | null | undefined): string {
  if (!value) return "";
  return /^(https?:|asset:|blob:|data:)/i.test(value) ? value : convertFileSrc(value);
}

/** Try the thumbnail, then the original once. Stable failures never reload in a loop. */
export function CanvasReferencePreview({ thumbnail, original, label, unavailable }: {
  thumbnail?: string | null; original?: string | null; label: string; unavailable: string;
}) {
  const urls = [...new Set([thumbnail, original].map(referencePreviewUrl).filter(Boolean))];
  return <ReferenceImage key={JSON.stringify(urls)} urls={urls} label={label} unavailable={unavailable} />;
}

function ReferenceImage({ urls, label, unavailable }: { urls: string[]; label: string; unavailable: string }) {
  const [index, setIndex] = useState(0);
  return index < urls.length
    ? <img src={urls[index]} alt={label} draggable={false} decoding="async" onError={() => setIndex(current => current + 1)} />
    : <span className="canvas-reference-unavailable" role="status" title={`${label}: ${unavailable}`}>{unavailable}</span>;
}
