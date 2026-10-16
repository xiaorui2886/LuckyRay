import { attachmentErrorMessage } from "../../core/services/vaultAttachmentErrors";
import { discoverAttachmentMoves, type DiscoveredAttachmentMove } from "../../core/services/vaultAttachments";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { requestAttachmentRelink } from "../../core/services/vaultAttachmentSessions";
import { selectMaterialRelocationPath } from "../../core/services/materials";
import { useEffect, useState } from "react";
import {
  getMaterialAttachmentDetails,
  promoteMaterialAttachment,
  type MaterialAttachmentDetails,
  type MaterialAsset,
} from "../../core/services/materials";
import { knowledgeDocumentNoteId } from "../../core/services/knowledge";
import { focusEntity } from "../../core/services/context";
import { readKnownNotesVaults } from "../notes/knownVaults";

export function MaterialAttachmentSection({
  assetId,
  storageMode,
  onUpdated,
}: {
  assetId: string;
  storageMode?: string | null;
  onUpdated: (asset: MaterialAsset) => void;
}) {
  const [details, setDetails] = useState<MaterialAttachmentDetails | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [destination, setDestination] = useState("");
  const [discoveredMove, setDiscoveredMove] = useState<DiscoveredAttachmentMove | null>(null);
  useEffect(() => {
    const refresh = () => setReload((value) => value + 1);
    const events = [
      "luckyray:note-external-updated",
      "luckyray:notes-vault-index-changed",
      "luckyray:knowledge-source-changed",
    ];
    events.forEach((event) => window.addEventListener(event, refresh));
    return () =>
      events.forEach((event) => window.removeEventListener(event, refresh));
  }, []);
  useEffect(() => {
    let current = true;
    setDetails(null);
    setError("");
    void getMaterialAttachmentDetails(assetId)
      .then((value) => {
        if (current) setDetails(value);
      })
      .catch((cause) => {
        if (current) setError(attachmentErrorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [assetId, reload]);
  useEffect(() => {
    let current = true;
    const source = readActiveKnowledgeWriteSource();
    setDiscoveredMove(null);
    if (source?.vaultId) void discoverAttachmentMoves(source.vaultId).then(moves => {
      if (!current || source !== readActiveKnowledgeWriteSource()) return;
      const candidates = moves.filter(move => move.assetId === assetId);
      if (candidates.length === 1) setDiscoveredMove(candidates[0]);
    }).catch(() => { /* A missing suggestion never replaces manual recovery or guesses a target. */ });
    return () => { current = false; };
  }, [assetId, reload]);
  const promote = async () => {
    setBusy(true);
    setError("");
    try {
      const updated = await promoteMaterialAttachment(assetId);
      onUpdated(updated);
      setDetails((previous) =>
        previous ? { ...previous, ordinary: true } : previous,
      );
    } catch (cause) {
      setError(attachmentErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const relink = async (kind: "relink" | "move" = "relink", knownPath?: string) => {
    if (
      kind === "move" &&
      storageMode !== "managed" &&
      storageMode !== "source"
    ) {
      setError("链接引用不移动源文件");
      return;
    }
    const source = readActiveKnowledgeWriteSource();
    if (!source || !details) {
      setError("请先打开需要恢复引用的知识库");
      return;
    }
    const paths = [
      ...new Set(
        details.references
          .filter((reference) => reference.vaultId === source.vaultId)
          .map((reference) => reference.notePath),
      ),
    ];
    if (!paths.length && kind === "relink") {
      setError("请先打开引用列表中的对应知识库，再恢复附件位置");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const newPath =
        kind === "move"
          ? destination.trim()
          : knownPath || await selectMaterialRelocationPath();
      if (!newPath) return;
      if (source !== readActiveKnowledgeWriteSource())
        throw new Error("知识库已切换，请重试");
      requestAttachmentRelink({
        kind,
        vaultId: source.vaultId!,
        source,
        assetId,
        newPath,
        paths,
        otherVaultCount: new Set(
          details.references
            .filter((reference) => reference.vaultId !== source.vaultId)
            .map((reference) => reference.vaultId),
        ).size,
      });
      window.location.hash = "#notes";
    } catch (cause) {
      setError(attachmentErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const vaults = readKnownNotesVaults();
  const normalizedPath =
    details?.absolutePath
      ?.replace(/\\/g, "/")
      .replace(/^\/\/\?\//, "")
      .toLocaleLowerCase() || "";
  const withinVault = vaults.some((vault) =>
    normalizedPath.startsWith(
      vault.rootPath
        .replace(/\\/g, "/")
        .replace(/^\/\/\?\//, "")
        .replace(/\/$/, "")
        .toLocaleLowerCase() + "/",
    ),
  );
  // Ordinary materials need not have a material_note_identity row: this
  // endpoint reports only registered note-attachment locations, not the
  // catalog's preview/source path. A null path is not an external location.
  const hasRegisteredPath = Boolean(details?.absolutePath?.trim());
  return (
    <section
      className="detail-section inspector-section-react material-attachment-details"
      aria-label="笔记引用"
    >
      <div className="detail-section-title">
        {details ? `被 ${details.referenceCount} 篇笔记引用` : "笔记引用"}
      </div>
      {error ? (
        <div className="material-attachment-error" role="alert">
          <span>引用信息读取未完成：{error}</span>
          <button onClick={() => setReload((value) => value + 1)}>重试</button>
        </div>
      ) : !details ? (
        <div className="detail-linked-empty-react" role="status">
          正在读取引用…
        </div>
      ) : (
        <>
          {hasRegisteredPath ? (
            <div className="material-attachment-location">
              <span>{withinVault ? "知识库内" : "外部位置"}</span>
              <code title={details.absolutePath || undefined}>{details.absolutePath}</code>
            </div>
          ) : !details.ordinary ? (
            <p className="detail-linked-empty-react">笔记附件位置尚未登记；无法仅凭此判断文件是否丢失。</p>
          ) : null}
          {discoveredMove && <div className="material-attachment-promote"><p>找到原附件的新位置：<span className="attachment-export-path">{discoveredMove.newPath}</span></p><button disabled={busy} onClick={() => void relink("relink", discoveredMove.newPath)}>预览更新引用</button></div>}
          {details.referenceCount > 0 && (
            <button disabled={busy} onClick={() => void relink()}>
              恢复附件位置
            </button>
          )}
          {hasRegisteredPath && (storageMode === "managed" || storageMode === "source") && (
            <details className="material-attachment-reference-list material-attachment-move">
              <summary>移动或重命名文件</summary>
              <p>
                同时检查已登记笔记的引用。目标须为完整文件路径，现有文件不会被覆盖。
              </p>
              <label>
                新文件路径
                <input
                  aria-label="新文件路径"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder={details.absolutePath || "C:/附件/新名称.png"}
                />
              </label>
              <button
                disabled={busy || !destination.trim()}
                onClick={() => void relink("move")}
              >
                检查移动与引用范围
              </button>
            </details>
          )}
          {!details.ordinary && (
            <div className="material-attachment-promote">
              <p>笔记专属附件。加入素材库后会出现在全部素材中，原图不复制。</p>
              <button disabled={busy} onClick={() => void promote()}>
                {busy ? "正在加入…" : "加入素材库"}
              </button>
            </div>
          )}
          {details.references.length > 0 ? (
            <details className="material-attachment-reference-list">
              <summary>查看引用笔记</summary>
              <div className="detail-linked-list-react">
                {details.references.map((reference) => (
                  <button
                    className="detail-linked-note-react"
                    key={`${reference.vaultId}:${reference.notePath}`}
                    disabled={!vaults.some(vault => vault.id === reference.vaultId)}
                    title={!vaults.some(vault => vault.id === reference.vaultId) ? "此知识库位置尚未登记，请先打开该知识库" : undefined}
                    onClick={() => {
                      focusEntity(
                        "note",
                        knowledgeDocumentNoteId({
                          vaultId: reference.vaultId,
                          relativePath: reference.notePath,
                        }),
                        { source: "material-attachment" },
                      );
                      window.location.hash = "#notes";
                    }}
                  >
                    <span className="detail-linked-note-title-react">
                      {reference.notePath}
                    </span>
                    <span className="detail-linked-note-meta-react">
                      {vaults.find((vault) => vault.id === reference.vaultId)
                        ?.name || `请先打开知识库 · ${reference.vaultId}`}
                    </span>
                  </button>
                ))}
              </div>
            </details>
          ) : (
            <p className="detail-linked-empty-react">
              {details.ordinary ? "暂无已登记笔记引用；素材仍保留。" : "暂无已登记笔记引用，附件仍保留。"}
            </p>
          )}
          <p className="material-attachment-footnote">
            仅统计已登记知识库。移除引用不会删除原文件。
          </p>
        </>
      )}
    </section>
  );
}
