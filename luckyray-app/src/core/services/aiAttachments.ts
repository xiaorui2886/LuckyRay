export type AiAttachmentParseKind = "text" | "image" | "metadata" | "document" | "media";

export type AiAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  previewText?: string;
  dataUrl?: string;
  parseKind?: AiAttachmentParseKind;
  parseStatus?: "pending" | "parsed" | "error";
  parseError?: string;
  queuedAt?: number;
};

export type AssetAttachmentPayload = {
  id: string;
  name: string;
  kind?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  libraryPath?: string | null;
  thumbnailUrl?: string | null;
  description?: string | null;
};

export type AiUserContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

const TEXT_PREVIEW_LIMIT = 6000;
const SMALL_TEXT_LIMIT = 1024 * 1024;
const DOCUMENT_PARSE_LIMIT = 20 * 1024 * 1024;
const IMAGE_DATA_LIMIT = 6 * 1024 * 1024;

export function formatAiFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function assetToAiAttachment(asset: AssetAttachmentPayload): AiAttachment {
  const previewText = [
    `素材名称: ${asset.name}`,
    asset.kind ? `类型: ${asset.kind}` : "",
    asset.mimeType ? `MIME: ${asset.mimeType}` : "",
    asset.description ? `描述: ${asset.description}` : "",
    asset.libraryPath ? `本地路径: ${asset.libraryPath}` : "",
  ].filter(Boolean).join("\n");
  return {
    id: `asset-${asset.id}`,
    name: asset.name || "素材",
    type: asset.mimeType || asset.kind || "asset",
    size: asset.sizeBytes || 0,
    previewText,
    parseKind: "metadata",
    parseStatus: "parsed",
    queuedAt: Date.now(),
  };
}

function trimPreview(text: string): string {
  return normalizeText(text).slice(0, TEXT_PREVIEW_LIMIT);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  const textarea = typeof document !== "undefined" ? document.createElement("textarea") : null;
  if (textarea) {
    textarea.innerHTML = value;
    return textarea.value;
  }
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function decodeRtf(text: string): string {
  const withHex = text.replace(/\\'([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return trimPreview(withHex
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\tab/gi, "\t")
    .replace(/\\[a-z]+\d* ?/gi, "")
    .replace(/\\[^a-z0-9]/gi, "")
    .replace(/[{}]/g, " "));
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, code: string) => {
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code === "n") return "\n";
    if (code === "r") return "\r";
    if (code === "t") return "\t";
    if (code === "b") return "\b";
    if (code === "f") return "\f";
    return code;
  });
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  if (!clean || clean.length % 2 !== 0) return "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return new TextDecoder("latin1").decode(bytes);
}

async function extractPdfText(file: File): Promise<string> {
  const raw = new TextDecoder("latin1").decode(await file.arrayBuffer());
  const chunks: string[] = [];
  const textBlocks = raw.match(/BT[\s\S]*?ET/g) || [];
  for (const block of textBlocks.slice(0, 300)) {
    for (const match of block.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      chunks.push(decodePdfLiteral(match[0].replace(/^\(/, "").replace(/\)\s*Tj$/, "")));
    }
    for (const match of block.matchAll(/\[(.*?)\]\s*TJ/gs)) {
      for (const part of match[1].matchAll(/\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]+)>/g)) {
        chunks.push(part[1] ? decodePdfHex(part[1]) : decodePdfLiteral(part[0].slice(1, -1)));
      }
    }
    for (const match of block.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) {
      chunks.push(decodePdfHex(match[1]));
    }
  }
  return trimPreview(chunks.join(" "));
}

function readUint16(data: DataView, offset: number): number {
  return data.getUint16(offset, true);
}

function readUint32(data: DataView, offset: number): number {
  return data.getUint32(offset, true);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Decompression = (globalThis as any).DecompressionStream;
  if (!Decompression) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new Decompression("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

function findZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (readUint32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const total = readUint16(view, eocd + 10);
  const cdOffset = readUint32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < total && offset + 46 <= bytes.length; i += 1) {
    if (readUint32(view, offset) !== 0x02014b50) break;
    const method = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localOffset = readUint32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (local + 30 > bytes.length || readUint32(view, local) !== 0x04034b50) return null;
  const nameLength = readUint16(view, local + 26);
  const extraLength = readUint16(view, local + 28);
  const start = local + 30 + nameLength + extraLength;
  const compressed = bytes.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed);
  return null;
}

function xmlToText(xml: string): string {
  return decodeEntities(xml
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<a:p[^>]*>/g, "\n")
    .replace(/<row[^>]*>/g, "\n")
    .replace(/<c[^>]*>/g, "\t")
    .replace(/<[^>]+>/g, " "));
}

async function extractOfficeText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lower = file.name.toLowerCase();
  const entries = findZipEntries(bytes);
  const wanted = entries.filter((entry) => {
    if (lower.endsWith(".docx")) return /^word\/(document|header\d+|footer\d+)\.xml$/i.test(entry.name);
    if (lower.endsWith(".pptx")) return /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name) || entry.name === "ppt/notesSlides/notesSlide1.xml";
    if (lower.endsWith(".xlsx")) return entry.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name);
    return false;
  }).slice(0, 80);
  const chunks: string[] = [];
  for (const entry of wanted) {
    const data = await readZipEntry(bytes, entry);
    if (!data) continue;
    chunks.push(xmlToText(new TextDecoder().decode(data)));
  }
  return trimPreview(chunks.join("\n"));
}

function readMediaMetadata(file: File): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(`媒体文件: ${file.name}\n大小: ${formatAiFileSize(file.size)}`);
      return;
    }
    const isVideo = file.type.startsWith("video/");
    const element = document.createElement(isVideo ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(`媒体文件: ${file.name}\n大小: ${formatAiFileSize(file.size)}\n提示: 未能读取媒体时长，当前版本不会自动转写音视频正文。`);
    }, 3000);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const duration = Number.isFinite(element.duration) ? `${Math.round(element.duration)} 秒` : "未知";
      const video = element as HTMLVideoElement;
      cleanup();
      resolve([
        `媒体文件: ${file.name}`,
        `大小: ${formatAiFileSize(file.size)}`,
        `时长: ${duration}`,
        isVideo && video.videoWidth ? `分辨率: ${video.videoWidth} x ${video.videoHeight}` : "",
        "提示: 当前版本读取的是媒体元数据，不会自动转写音视频正文。",
      ].filter(Boolean).join("\n"));
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      cleanup();
      resolve(`媒体文件: ${file.name}\n大小: ${formatAiFileSize(file.size)}\n提示: 未能读取媒体元数据，当前版本不会自动转写音视频正文。`);
    };
    element.src = url;
  });
}

function isTextLike(file: File): boolean {
  return file.type.startsWith("text/")
    || /\.(md|txt|json|csv|log|xml|html|css|js|ts|tsx|jsx|yaml|yml)$/i.test(file.name);
}

function isOfficeZip(file: File): boolean {
  return /\.(docx|pptx|xlsx)$/i.test(file.name);
}

export async function fileToAiAttachment(file: File): Promise<AiAttachment> {
  let previewText = "";
  let dataUrl = "";
  let parseKind: AiAttachment["parseKind"] = "metadata";
  const lower = file.name.toLowerCase();

  if (isTextLike(file) && file.size <= SMALL_TEXT_LIMIT) {
    try {
      previewText = trimPreview(await file.text());
      parseKind = "text";
    } catch {}
  } else if (/\.rtf$/i.test(lower) && file.size <= SMALL_TEXT_LIMIT) {
    try {
      previewText = decodeRtf(await file.text());
      parseKind = "document";
    } catch {}
  } else if (/\.pdf$/i.test(lower) && file.size <= DOCUMENT_PARSE_LIMIT) {
    try {
      previewText = await extractPdfText(file);
      parseKind = previewText ? "document" : "metadata";
    } catch {}
  } else if (isOfficeZip(file) && file.size <= DOCUMENT_PARSE_LIMIT) {
    try {
      previewText = await extractOfficeText(file);
      parseKind = previewText ? "document" : "metadata";
    } catch {}
  } else if (file.type.startsWith("image/") && file.size <= IMAGE_DATA_LIMIT) {
    try {
      dataUrl = await readFileAsDataUrl(file);
      parseKind = "image";
    } catch {}
  } else if (file.type.startsWith("audio/") || file.type.startsWith("video/") || /\.(mp3|wav|ogg|flac|m4a|mp4|mov|webm|mkv)$/i.test(lower)) {
    try {
      previewText = await readMediaMetadata(file);
      parseKind = "media";
    } catch {}
  }

  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    type: file.type || "file",
    size: file.size,
    previewText,
    dataUrl,
    parseKind,
    parseStatus: "parsed",
    queuedAt: Date.now(),
  };
}

export async function filesToAiAttachments(files: FileList | File[]): Promise<AiAttachment[]> {
  const fileArray = Array.from(files);
  return Promise.all(fileArray.map(fileToAiAttachment));
}

export function buildAiUserContent(text: string, attachments: AiAttachment[], allowFiles: boolean): AiUserContent {
  const readableAttachments = allowFiles ? attachments : [];
  const attachmentText = readableAttachments
    .map((file) => {
      const status = file.parseStatus === "pending"
        ? "\n解析状态: 正在后台解析，当前只可使用文件元数据。"
        : file.parseStatus === "error"
          ? `\n解析状态: 解析失败${file.parseError ? ` - ${file.parseError}` : ""}。`
          : "";
      const body = file.previewText ? `\n预览内容:\n${file.previewText}` : file.dataUrl ? "\n图片内容: 已作为多模态图片发送" : "";
      return `文件: ${file.name}, 类型: ${file.type}, 大小: ${formatAiFileSize(file.size)}${status}${body}`;
    })
    .join("\n\n");
  const body = attachmentText ? `${text || "请分析这些附件。"}\n\n${attachmentText}` : text;
  const imageAttachments = readableAttachments.filter((file) => file.dataUrl);
  if (!imageAttachments.length) return body;
  return [
    { type: "text", text: body || "请分析这些图片附件。" },
    ...imageAttachments.map((file) => ({ type: "image_url" as const, image_url: { url: file.dataUrl || "" } })),
  ];
}
