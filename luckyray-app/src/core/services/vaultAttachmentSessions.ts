import type {
  AttachmentOperationPlan,
  AttachmentOperationResult,
} from "./vaultAttachments";
export type AttachmentDraftSession = {
  vaultId: string;
  source: object;
  save: (paths: string[]) => Promise<void>;
  dirty: (paths: string[]) => boolean;
  refresh: (paths: string[]) => Promise<void>;
};
let session: AttachmentDraftSession | null = null;
export function registerAttachmentDraftSession(next: AttachmentDraftSession) {
  session = next;
  return () => {
    if (session === next) session = null;
  };
}
export function requireAttachmentDraftSession(vaultId: string, source: object) {
  if (!session || session.vaultId !== vaultId || session.source !== source)
    throw new Error("请在原知识库的笔记页继续操作");
  return session;
}
export type AttachmentRelinkRequest = {
  kind?: "relink" | "move";
  vaultId: string;
  source: object;
  assetId: string;
  newPath: string;
  paths: string[];
  otherVaultCount: number;
};
let pending: AttachmentRelinkRequest | null = null;
const listeners = new Set<() => void>();
export const readAttachmentRelinkRequest = () => pending;
export const subscribeAttachmentRelinkRequest = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function requestAttachmentRelink(
  request: AttachmentRelinkRequest | null,
) {
  pending = request;
  listeners.forEach((listener) => listener());
}
/** UI callbacks only. Disk Markdown and native revision checks remain authoritative. */
export function createAttachmentRelinkController(
  request: AttachmentRelinkRequest,
  port: {
    current: () => object | null;
    capture: () => Promise<number>;
    preview: () => Promise<AttachmentOperationPlan>;
    execute: (
      epoch: number,
      plan: AttachmentOperationPlan,
    ) => Promise<AttachmentOperationResult>;
  },
) {
  let phase:
    "idle" | "planning" | "review" | "running" | "finished" | "cancelled" =
    "idle";
  let plan: AttachmentOperationPlan | null = null;
  let epoch = 0;
  const requireCurrent = () => {
    if (port.current() !== request.source)
      throw new Error("知识库已切换，本次恢复已暂停");
    return requireAttachmentDraftSession(request.vaultId, request.source);
  };
  return {
    get phase() {
      return phase;
    },
    cancel() {
      if (phase !== "running") phase = "cancelled";
    },
    async prepare() {
      if (phase !== "idle") throw new Error("恢复操作已开始");
      phase = "planning";
      const draft = requireCurrent();
      await draft.save(request.paths);
      requireCurrent();
      if (phase === ("cancelled" as string)) return null;
      epoch = await port.capture();
      requireCurrent();
      plan = await port.preview();
      const current = requireCurrent();
      if (phase === ("cancelled" as string)) return null;
      if (current.dirty(request.paths))
        throw new Error("笔记在检查期间发生变化，请重新检查");
      phase = "review";
      return plan;
    },
    async confirm() {
      if (phase !== "review" || !plan) throw new Error("请先检查引用范围");
      const draft = requireCurrent();
      if (draft.dirty(request.paths))
        throw new Error("笔记有新修改，请取消后重新检查");
      phase = "running";
      const result = await port.execute(epoch, plan);
      const current = requireCurrent();
      await current.refresh(request.paths);
      requireCurrent();
      phase = "finished";
      return result;
    },
  };
}
