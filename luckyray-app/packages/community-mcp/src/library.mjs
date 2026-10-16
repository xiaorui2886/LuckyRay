import {
  Materials,
  TOOLS as MATERIAL_TOOLS,
  validateImport,
} from "../../materials-mcp/src/materials.mjs";
import { MaterialError } from "../../materials-mcp/src/transport.mjs";
const fail = (code) => {
  throw new MaterialError(code);
};
function input(value, keys) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail("input-invalid");
}
export function fileInput(args) {
  input(args, ["url", "file", "fileName", "folderId", "newFolderName"]);
  const hasFile = args.file !== undefined;
  if (hasFile === (args.url !== undefined)) fail("file-source-required");
  if (hasFile) {
    input(args.file, ["download_url", "file_id", "mime_type", "file_name"]);
    if (
      typeof args.file.file_id !== "string" || !args.file.file_id ||
      args.file.file_id.length > 256 || /[\x00-\x1f\x7f]/.test(args.file.file_id) ||
      (args.file.mime_type !== undefined && (typeof args.file.mime_type !== "string" || args.file.mime_type.length > 256))
    ) fail("file-input-invalid");
  }
  // No new downloader: the official importer still validates the final URL,
  // redirects, size, MIME, filename and SHA-256. Never log signed file URLs.
  return validateImport({
    url: hasFile ? args.file.download_url : args.url,
    fileName: args.fileName ?? (hasFile ? args.file.file_name : undefined),
    ...(args.folderId === undefined ? {} : { folderId: args.folderId }),
    ...(args.newFolderName === undefined ? {} : { newFolderName: args.newFolderName }),
  });
}
export function markdownInput(args) {
  input(args, ["url", "file", "fileName", "requestId", "folder"]);
  const { url, fileName } = validateImport({
    ...fileInput({
      ...(args.file === undefined ? {} : { file: args.file }),
      ...(args.url === undefined ? {} : { url: args.url }),
      ...(args.fileName === undefined ? {} : { fileName: args.fileName }),
    }),
  });
  if (!/\.md$/i.test(fileName)) fail("markdown-file-required");
  if (
    typeof args.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(args.requestId)
  )
    fail("request-id-invalid");
  if (
    args.folder !== undefined &&
    (typeof args.folder !== "string" ||
      args.folder.length > 1024 ||
      args.folder.startsWith("/") ||
      args.folder.includes("\\") ||
      args.folder.split("/").some((p) => !p || p === "." || p === "..") ||
      /[:\x00-\x1f\x7f]/.test(args.folder))
  )
    fail("folder-invalid");
  return {
    url,
    fileName,
    requestId: args.requestId,
    ...(args.folder === undefined ? {} : { folder: args.folder }),
  };
}
export class LibraryTools {
  constructor(transport, onSuccess = () => {}) {
    this.transport = transport;
    this.materials = new Materials(transport);
    this.onSuccess = onSuccess;
  }
  async run(name, args = {}) {
    let result;
    if (name === "import_markdown") {
      result = await this.transport.call(
        "/api/v1/library-mcp/knowledge/import-markdown",
        markdownInput(args),
      );
      if (
        !result ||
        typeof result.noteId !== "string" ||
        !result.noteId ||
        !["imported", "duplicate"].includes(result.disposition) ||
        typeof result.vaultId !== "string" ||
        !Array.isArray(result.warnings) ||
        !/^[a-f0-9]{64}$/.test(result.contentSha256 ?? "")
      )
        fail("import-receipt-invalid");
    } else if (name === "import_file") {
      result = await this.materials.run(name, fileInput(args));
    } else if (name === "search_notes") {
      input(args, ["query", "limit"]);
      const query = args.query ?? "",
        limit = args.limit ?? 20;
      if (
        typeof query !== "string" ||
        query.length > 1000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        fail("input-invalid");
      result = await this.transport.call(
        "/api/v1/library-mcp/knowledge/search",
        { query, limit },
      );
      if (!Array.isArray(result?.notes)) fail("response-invalid");
    } else if (name === "get_note") {
      input(args, ["noteId"]);
      if (
        typeof args.noteId !== "string" ||
        !args.noteId ||
        args.noteId.length > 2048
      )
        fail("input-invalid");
      result = await this.transport.call("/api/v1/library-mcp/knowledge/read", {
        noteId: args.noteId,
      });
      if (result?.noteId !== args.noteId || typeof result.content !== "string")
        fail("response-invalid");
    } else result = await this.materials.run(name, args);
    await this.onSuccess(name);
    return result;
  }
}
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
// The four declared properties and two required fields follow ChatGPT's
// documented file parameter contract. Optional filename/MIME may be absent.
const fileSchema = schema({
  download_url: { type: "string" },
  file_id: { type: "string" },
  mime_type: { type: "string" },
  file_name: { type: "string" },
}, ["download_url", "file_id"]);
export const TOOLS = [
  ...MATERIAL_TOOLS.map((tool) => tool.name !== "import_file" ? tool : {
    ...tool,
    description: "Import a user-selected ChatGPT attachment OR one public HTTPS URL into the fixed authorized material library. Supply exactly one of file or url. Preserve the original filename; provide fileName if the attachment omits file_name. Uses the official importer and SHA-256 deduplication, returning confirmed assetId. ZIP stays one file. Never retry blindly after an unknown outcome.",
    inputSchema: schema({
      file: fileSchema,
      url: { type: "string", format: "uri" },
      fileName: { type: "string", maxLength: 120 },
      folderId: { type: "string" },
      newFolderName: { type: "string" },
    }),
    _meta: { "openai/fileParams": ["file"] },
  }),
  {
    name: "search_notes",
    description:
      "Search the explicitly authorized knowledge vault. UI vault changes never retarget this grant.",
    inputSchema: schema({
      query: { type: "string", maxLength: 1000 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "get_note",
    description:
      "Read a note from the authorized vault using its exact returned noteId.",
    inputSchema: schema({ noteId: { type: "string", maxLength: 2048 } }, [
      "noteId",
    ]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "import_markdown",
    description:
      "Import a user-selected ChatGPT Markdown attachment OR a public HTTPS .md URL as a new note in the fixed authorized vault. Supply exactly one of file or url. Preserve the original .md filename; provide fileName if file_name is absent. Keep one requestId for retries, including after a timeout. Never overwrite existing notes. Preserves UTF-8, frontmatter and code blocks. Linked attachments are not downloaded; check warnings. If outcome is unknown, search/read back rather than using a new requestId.",
    inputSchema: schema(
      {
        url: { type: "string", format: "uri" },
        file: fileSchema,
        fileName: { type: "string", maxLength: 120 },
        requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
        folder: { type: "string", maxLength: 1024 },
      },
      ["requestId"],
    ),
    _meta: { "openai/fileParams": ["file"] },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];
