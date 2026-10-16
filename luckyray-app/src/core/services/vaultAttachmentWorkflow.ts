import { attachmentAccessMessage } from "./vaultAttachmentErrors";
import type { AttachmentOperationPlan, AttachmentOperationResult } from "./vaultAttachments";

export type ImportReceipt = { copiedCount: number; skippedCount?: number; failedCount?: number; conflictRenamedCount: number; errors: { sourcePath: string; code: string; message: string }[] };
export type AttachmentWorkflowState = {
  phase: "idle" | "planning" | "review" | "running" | "finished" | "failed" | "cancelled";
  title: string; plan: AttachmentOperationPlan | null; result: AttachmentOperationResult | null;
  error: string; cancelRequested: boolean; importReceipt: ImportReceipt | null;
};
export type AttachmentWorkflowPort = {
  capture: () => Promise<number>;
  collect: (paths: string[]) => Promise<AttachmentOperationPlan>;
  rename: (oldPath: string, newPath: string) => Promise<AttachmentOperationPlan>;
  execute: (epoch: number, plan: AttachmentOperationPlan, requestId: string) => Promise<AttachmentOperationResult>;
  recover: (epoch: number, id: string, rollback: boolean, requestId: string) => Promise<AttachmentOperationResult>;
  cancel: (requestId: string) => Promise<void>;
};
export const attachmentWorkflowBusy = (state: AttachmentWorkflowState) => state.phase === "planning" || state.phase === "running";
export const requiresAttachmentReview = (plan: AttachmentOperationPlan) => plan.issues.length > 0 || plan.files.length > 40 || plan.documentCount > 20 || plan.copyBytes + plan.backupBytes > 16 * 1048576;

/** One bounded, Vault-scoped operation. Subscription lifetime is deliberately
 * independent of operation lifetime: closing settings never cancels a write. */
export function createAttachmentWorkflow(port: AttachmentWorkflowPort) {
  let state: AttachmentWorkflowState = { phase: "idle", title: "", plan: null, result: null, error: "", cancelRequested: false, importReceipt: null };
  let epoch = 0;
  let activeRequestId: string | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AttachmentWorkflowState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const fail = (error: unknown) => update({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
  const execute = async () => {
    const plan = state.plan;
    if (!plan) return;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    update({ phase: "running" });
    try { const result = await port.execute(epoch, plan, requestId); update({ phase: "finished", result }); }
    catch (error) { fail(error); }
    finally { if (activeRequestId === requestId) activeRequestId = null; }
  };
  const prepare = async (title: string, makePlan: () => Promise<AttachmentOperationPlan>, alwaysReview: boolean) => {
    if (attachmentWorkflowBusy(state)) return;
    update({ phase: "planning", title, plan: null, result: null, error: "", cancelRequested: false });
    try {
      epoch = await port.capture();
      if (state.cancelRequested) { update({ phase: "cancelled" }); return; }
      const plan = await makePlan();
      update({ plan });
      if (state.cancelRequested) { update({ phase: "cancelled" }); return; }
      if (!plan.files.length) { update({ phase: "finished" }); return; }
      if (alwaysReview || requiresAttachmentReview(plan)) update({ phase: "review" });
      else await execute();
    } catch (error) { fail(error); }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    inspect: async (paths: string[]) => {
      if (attachmentWorkflowBusy(state) || !paths.length) return;
      update({ phase: "planning", title: "附件引用检查", plan: null, result: null, error: "", cancelRequested: false });
      try {
        const plan = await port.collect(paths);
        update({ phase: state.cancelRequested ? "cancelled" : "finished", plan });
      } catch (error) { fail(error); }
    },
    collect: (paths: string[]) => paths.length ? prepare("收集旧素材附件", () => port.collect(paths), false) : Promise.resolve(),
    rename: (oldPath: string, newPath: string) => prepare("移动或重命名附件", () => port.rename(oldPath, newPath), true),
    confirm: (hasUnsavedChanges: () => boolean = () => false) => {
      if (state.phase !== "review") return Promise.resolve();
      if (hasUnsavedChanges()) { update({ error: "请先保存正在编辑的笔记，再确认维护。" }); return Promise.resolve(); }
      update({ error: "" });
      return execute();
    },
    reset: () => { if (!attachmentWorkflowBusy(state)) update({ phase: "idle", title: "", plan: null, result: null, error: "", cancelRequested: false }); },
    stop: async () => {
      if (!attachmentWorkflowBusy(state) || state.cancelRequested) return;
      const requestId = activeRequestId;
      update({ cancelRequested: true });
      if (requestId) { try { await port.cancel(requestId); } catch (error) { if (activeRequestId === requestId) update({ error: `停止请求未送达：${String(error)}`, cancelRequested: false }); } }
    },
    recover: async (id: string, rollback: boolean) => {
      if (attachmentWorkflowBusy(state) || !id) return;
      update({ phase: "planning", title: rollback ? "回滚引用变更" : "继续附件操作", plan: null, result: null, error: "", cancelRequested: false });
      try {
        epoch = await port.capture();
        if (state.cancelRequested) { update({ phase: "cancelled" }); return; }
        const requestId = crypto.randomUUID();
        activeRequestId = requestId;
        update({ phase: "running" });
        try {
          const result = await port.recover(epoch, id, rollback, requestId);
          update({ phase: "finished", result });
        } finally { if (activeRequestId === requestId) activeRequestId = null; }
      } catch (error) { fail(error); }
    },
    recordImport: (receipt: ImportReceipt) => update({ importReceipt: receipt }),
    clearImport: () => update({ importReceipt: null }),
  };
}

export function attachmentIssueLabel(status: string) {
  const known: Record<string, string> = { missing: "找不到来源附件", ambiguous: "存在多个同名附件", "unsupported-reference-style-rewrite": "此引用格式暂不支持改写", "import-partial": "导入中断，可从操作记录恢复", "referenced-note-not-selected": "引用的笔记不在本次选择中", "material-source-unavailable": "素材记录存在，但来源文件不可用", "knowledge-attachment-read-failed": "无法读取来源附件", "knowledge-attachment-size-limit": "来源附件超出大小限制", "knowledge-path-reparse-forbidden": "来源路径不允许访问" };
  const attachmentManagement: Record<string, string> = {
    "other-vault-pending": "其他知识库仍有引用，请分别打开处理",
    "external-attachment-not-approved": "外部文件尚未连接，请定位并确认附件",
    "material-resolvable": "可从素材库定位，尚未转换为真实文件引用",
    "attachment-index-pending": "文件已处理，附件索引仍需刷新",
    "knowledge-revision-conflict": "笔记已变化，请重新检查",
    "knowledge-export-capacity": "导出超过单次容量限制，请缩小范围",
    "knowledge-export-write-failed": "导出目标无法写入",
    "knowledge-export-verification-failed": "导出文件校验未通过，请检查目标目录",
    "knowledge-export-destination-not-empty": "导出目标不是空文件夹",
    "knowledge-export-source-overlap": "导出目标不能与原知识库重叠",
  };
  return attachmentAccessMessage(status) || known[status] || attachmentManagement[status] || "此附件暂未处理，请检查文件位置后重试";
}
