export type DeliveryItem = {
  id: string;
  nodeId?: string;
  label: string;
  kind: "image" | "video";
  source: string;
};
export const DELIVERY_LIMITS = {
  files: 50,
  eachBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
};
export function safeDeliveryName(
  label: string,
  index: number,
  extension: string,
) {
  const base =
    label
      .normalize("NFC")
      .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 70) || "result";
  return `${String(index + 1).padStart(3, "0")}-${base}.${extension}`;
}
export async function readMediaBytes(
  source: string,
  signal: AbortSignal,
  max = DELIVERY_LIMITS.eachBytes,
): Promise<Uint8Array> {
  const url = new URL(
    source,
    globalThis.location?.href || "https://invalid.test",
  );
  if (
    !["https:", "http:", "asset:", "data:", "blob:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("unsupported-media-source");
  if (url.protocol === "http:" && url.hostname !== "asset.localhost")
    throw Error("unsupported-media-source");
  const response = await fetch(source, { signal, credentials: "omit" });
  if (!response.ok) throw Error("media-read-failed");
  const length = Number(response.headers.get("content-length") || 0);
  if (length > max) {
    await response.body?.cancel();
    throw Error("media-too-large");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw Error("media-too-large");
    if (!bytes.length) throw Error("empty-media");
    return bytes;
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw Error("media-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw Error("empty-media");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function mediaExtension(bytes: Uint8Array, kind: "image" | "video") {
  const ascii = (at: number, n: number) =>
    String.fromCharCode(...bytes.slice(at, at + n));
  if (kind === "image") {
    if (bytes[0] === 137 && ascii(1, 3) === "PNG") return "png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
    if (ascii(0, 3) === "GIF") return "gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
    if (ascii(4, 4) === "ftyp" && /avif|avis/.test(ascii(8, 24))) return "avif";
  } else {
    if (ascii(4, 4) === "ftyp") return "mp4";
    if (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    )
      return "webm";
  }
  throw Error("unrecognized-media");
}
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
/** Classic stored ZIP: original bytes preserved; deterministic UTF-8 filenames. */
export function buildMediaZip(
  files: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  if (files.length > DELIVERY_LIMITS.files + 1) throw Error("too-many-files");
  const names = new Set<string>();
  const entries = files.map((file) => {
    if (
      !file.name ||
      file.name === "." ||
      file.name === ".." ||
      new TextEncoder().encode(file.name).length > 65535 ||
      /[\\/\u0000]/.test(file.name) ||
      names.has(file.name)
    )
      throw Error("invalid-entry-name");
    names.add(file.name);
    return {
      ...file,
      nameBytes: new TextEncoder().encode(file.name),
      crc: crc32(file.bytes),
    };
  });
  const rawSize = entries.reduce((sum, f) => sum + f.bytes.length, 0);
  if (rawSize > DELIVERY_LIMITS.totalBytes) throw Error("delivery-too-large");
  const localSize = entries.reduce(
      (sum, f) => sum + 30 + f.nameBytes.length + f.bytes.length,
      0,
    ),
    centralSize = entries.reduce((sum, f) => sum + 46 + f.nameBytes.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22),
    view = new DataView(output.buffer);
  let cursor = 0,
    central = localSize;
  const u16 = (at: number, value: number) => view.setUint16(at, value, true),
    u32 = (at: number, value: number) => view.setUint32(at, value, true);
  for (const file of entries) {
    const start = cursor;
    u32(cursor, 0x04034b50);
    u16(cursor + 4, 20);
    u16(cursor + 6, 0x800);
    u16(cursor + 12, 33);
    u32(cursor + 14, file.crc);
    u32(cursor + 18, file.bytes.length);
    u32(cursor + 22, file.bytes.length);
    u16(cursor + 26, file.nameBytes.length);
    output.set(file.nameBytes, cursor + 30);
    output.set(file.bytes, cursor + 30 + file.nameBytes.length);
    cursor += 30 + file.nameBytes.length + file.bytes.length;
    u32(central, 0x02014b50);
    u16(central + 4, 20);
    u16(central + 6, 20);
    u16(central + 8, 0x800);
    u16(central + 14, 33);
    u32(central + 16, file.crc);
    u32(central + 20, file.bytes.length);
    u32(central + 24, file.bytes.length);
    u16(central + 28, file.nameBytes.length);
    u32(central + 42, start);
    output.set(file.nameBytes, central + 46);
    central += 46 + file.nameBytes.length;
  }
  u32(central, 0x06054b50);
  u16(central + 8, entries.length);
  u16(central + 10, entries.length);
  u32(central + 12, centralSize);
  u32(central + 16, localSize);
  return output;
}
export async function prepareMediaDelivery(
  items: readonly DeliveryItem[],
  signal: AbortSignal,
  progress: (finished: number, total: number) => void,
) {
  if (!items.length || items.length > DELIVERY_LIMITS.files)
    throw Error("invalid-selection");
  const files: Array<{ name: string; bytes: Uint8Array }> = [],
    manifest: Array<{ file: string; label: string; kind: string }> = [];
  let total = 0;
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted();
    const bytes = await readMediaBytes(
      item.source,
      signal,
      Math.min(DELIVERY_LIMITS.eachBytes, DELIVERY_LIMITS.totalBytes - total),
    );
    total += bytes.length;
    const name = safeDeliveryName(
      item.label,
      index,
      mediaExtension(bytes, item.kind),
    );
    files.push({ name, bytes });
    manifest.push({ file: name, label: item.label, kind: item.kind });
    progress(index + 1, items.length);
  }
  signal.throwIfAborted();
  files.push({
    name: "manifest.json",
    bytes: new TextEncoder().encode(
      JSON.stringify({ version: 1, files: manifest }, null, 2),
    ),
  });
  return buildMediaZip(files);
}
