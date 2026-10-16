/** Child attachment results are opaque capabilities, never filesystem paths. */
export type ChildAttachmentResolution = {
  status: string;
  token: string;
  version: string;
  mediaKind: 'image' | 'audio' | 'video';
  expiresInMs: number;
};
export function childAttachmentMedia(
  resolved: ChildAttachmentResolution,
  convertToken: (token: string, protocol: string) => string,
): { source: string; kind: 'image' | 'audio' | 'video' } {
  if (resolved.status !== 'resolved' || !/^[a-f0-9]{64}$/.test(resolved.token)
    || !['image', 'audio', 'video'].includes(resolved.mediaKind)) {
    throw new Error('workspace-attachment-invalid-capability');
  }
  return { source: convertToken(resolved.token, 'workspace-attachment'), kind: resolved.mediaKind };
}
export function attachmentPreviewError(error: unknown): string {
  if (String(error).includes('workspace-attachment-main-grant-required')) return '此附件尚未授权给这个窗口，请在主窗口重新打开笔记后预览。';
  return String(error).includes('workspace-attachment-save-reference-first')
    ? '新插入的附件引用需要先保存，才能在此窗口预览。'
    : '部分附件暂不可用，请保存笔记后重试。';
}
