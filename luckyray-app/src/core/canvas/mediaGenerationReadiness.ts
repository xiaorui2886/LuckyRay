import type { CanvasMediaProfile } from '../services/canvasMediaProfiles';

/** UI preflight only: native submission still validates the pinned connection. */
export function mediaGenerationReadiness(
  kind: 'image' | 'video', profile: CanvasMediaProfile | null | undefined,
  model: string | undefined, english = false,
): { ready: boolean; message: string } {
  const blocked = (zh: string, en: string) => ({ ready: false, message: english ? en : zh });
  const protocol = kind === 'image' ? profile?.imageProtocol : profile?.videoProtocol;
  if (profile?.id === 'doubao-default' || protocol === 'doubao-image' || protocol === 'doubao-video') {
    return blocked('豆包连接器已移除。已有结果保留，此任务不会改发到其他服务。', 'The Doubao connector has been removed. Existing results are retained; this task will not be sent to another provider.');
  }
  if (!profile || !protocol || protocol === 'disabled') return blocked('请先配置可用的生成连接。', 'Configure an available generation connection first.');
  if (!profile.apiKeyConfigured) return blocked('请先配置这套画布连接的 Key。', "Configure this connection's key first.");
  if (!model?.trim()) return blocked('请先选择生成模型。', 'Select a generation model first.');
  return { ready: true, message: '' };
}
