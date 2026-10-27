// Synthetic R5 UI fixture. No native bridge, no model calls and no media generation.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasAgentPanel } from '../src/features/canvas/CanvasAgentPanel';
import type { CanvasAgentSnapshot } from '../src/core/canvas/agent/types';
import '../src/core/theme/themeTokens.css';
const initial: CanvasAgentSnapshot = {
  canvasId: 'fixture', conversationId: 'current', sessionId: 'fixture-session', runId: 'fixture-run', status: 'completed',
  messages: [{ role: 'user', text: '把选中的产品参考整理成一组晨光主题分镜，保持画面风格一致。' }, { role: 'assistant', reasoningText: '合成公开模型输出，仅检查折叠展示，不代表实际调用模型。', text: '已整理成三个相互衔接的镜头：\n\n1. 清晨的第一束光落在桌面。\n2. 推近杯身，保留柔和的陶瓷质感。\n3. 镜头缓慢后退，留出干净的文字空间。\n\n画布中的节点已按阅读顺序排列，你可以继续调整构图或为本轮授权生成。' }],
  tools: [{ callId: 'read', name: 'canvas_read_context', status: 'completed', startedAt: 100, endedAt: 300, summary: '合成测试：读取了 3 个参考节点。' }, { callId: 'edit', name: 'canvas_apply_plan', status: 'completed', startedAt: 400, endedAt: 1400, summary: '合成测试：整理了 3 个分镜节点。' }],
  progress: [{ id: 'progress', summary: '正在统一三段分镜的光线、材质和镜头节奏。', createdAt: 500 }],
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<CanvasAgentSnapshot | null>(initial);
  const [busy, setBusy] = useState(false);
  return <main className="fixture-stage"><nav><button onClick={() => setSnapshot(null)}>欢迎页</button><button onClick={() => setSnapshot(initial)}>完整对话</button><button onClick={() => { setBusy(true); setSnapshot({ ...initial, status: 'running', messages: initial.messages.slice(0, 1), stream: { attemptId: 'stream', status: 'streaming', text: '正在将第一束晨光转化为画面，', reasoning: true, reasoningText: '合成公开推理片段，仅测试界面。' } }); }}>流式状态</button><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'}>切换主题</button></nav>
    <div className="fixture-art">晨光 · 产品分镜<br /><small>合成 UI 验证，没有模型调用</small></div>
    <CanvasAgentPanel canvasName="晨光产品分镜" snapshot={snapshot} contextChips={[]} execution={null} busy={busy} draftKey="r5-fixture" conversations={[{ conversationId: 'current', sessionId: 'fixture-session', title: '晨光产品分镜', updatedAt: 1792480000000, messageCount: 2 }, { conversationId: 'older', sessionId: 'fixture-older', title: '周末短片 · 视觉探索', updatedAt: 1792300000000, messageCount: 8 }]}
      onSend={async () => true} onCancel={async () => { setBusy(false); setSnapshot(current => current ? { ...current, status: 'cancelled' } : current); }} onApply={async () => true} onLocate={() => {}} onRemoveContext={() => {}} onClose={() => {}} onLoadConversations={async () => {}} onSelectConversation={async id => { setSnapshot({ ...initial, conversationId: id, sessionId: `fixture-${id}` }); return true; }} onNewConversation={async () => { setSnapshot({ ...initial, conversationId: 'new', messages: [], tools: [], progress: [], sessionId: null, runId: null, status: 'idle' }); return true; }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
