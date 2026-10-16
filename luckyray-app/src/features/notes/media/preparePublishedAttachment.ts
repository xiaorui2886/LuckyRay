import { convertFileSrc } from "@tauri-apps/api/core";
import { standardMarkdownReferences } from "../../../core/markdown/realVaultEmbeds";
import { resolveVaultAttachment, type AttachmentContext, type AttachmentPublication } from "../../../core/services/vaultAttachments";
import type { LiveAsset } from "../editor/types";
import type { PreparedAttachment } from "../editor/preparedAttachment";
import { warmRecentImage } from "./noteImageResources";
import { resolveMaterialPreviewTarget } from "../../../core/services/materialCatalog";

/** Resolve the exact published link before the editor can display it. This
 * uses the normal native authority and does not wait for the saved-note index. */
export async function preparePublishedAttachment(context: AttachmentContext, result: AttachmentPublication, material: LiveAsset): Promise<PreparedAttachment> {
  const wiki = /^!\[\[([^\]]+)\]\]$/.exec(result.markdown);
  const target = wiki?.[1] || standardMarkdownReferences(result.markdown)[0]?.target;
  if (!target) throw new Error("发布的附件链接无法识别");
  const resolved = await resolveVaultAttachment(context.documentRef, target, Boolean(wiki));
  if (resolved.status !== "resolved" || !resolved.absolutePath) throw new Error(`附件发布后无法读取：${resolved.status}`);
  const url = `${convertFileSrc(resolved.absolutePath)}?vault=${encodeURIComponent(context.documentRef.vaultId)}&v=${encodeURIComponent(resolved.version || "")}`;
  const id = resolved.materialAssetId || `real-vault-asset:${resolved.relativePath || resolved.absolutePath}`;
  const preview = resolveMaterialPreviewTarget(material);
  // A first-time paste has no catalog thumbnail. Its published original must
  // finish decoding before committing the editor transaction too, otherwise
  // a short loading line later expands into a tall picture below the caret.
  // These are detached leases, never nodes taken from an existing card.
  await Promise.all([
    ...(material.kind === "image" ? [warmRecentImage(url)] : []),
    ...(preview?.kind === "image" ? [warmRecentImage(preview.url)] : []),
  ]);
  return {
    markdown: result.markdown,
    resolution: resolved, target, wiki: Boolean(wiki),
    asset: { ...material, id, previewUrl: url, libraryPath: resolved.absolutePath },
    embed: { targetName: wiki ? target : `md:${target}`, assetId: id, isMissing: 0, resolutionStatus: "resolved" },
  };
}
