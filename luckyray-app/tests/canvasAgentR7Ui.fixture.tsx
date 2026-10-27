import {CanvasMotionProvider} from '../src/features/canvas/CanvasMotionContext';
// Synthetic presentation fixtures only: no native bridge, model request or media job.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasAgentPanel } from '../src/features/canvas/CanvasAgentPanel';
import type { CanvasAgentSnapshot } from '../src/core/canvas/agent/types';
import '../src/core/theme/themeTokens.css';

const initial: CanvasAgentSnapshot = {
  canvasId: 'fixture-r7', conversationId: 'current', sessionId: 'session-current', runId: 'run-current', status: 'completed',
  messages: [
    { role: 'user', text: '把产品参考整理成一组晨光主题分镜，保持光线和镜头衔接。' },
    { role: 'assistant', reasoningStartedAt:100,reasoningEndedAt:1800,reasoningDurationMs:1700, reasoningText: '合成测试文本：检查连续模型输出的折叠展示，不代表真实模型调用。', text: '已整理成三个相互衔接的镜头：\n\n1. 第一束晨光落在桌面。\n2. 推近杯身，保留柔和的陶瓷质感。\n3. 镜头缓慢后退，留出干净的文字空间。\n\n节点已按阅读顺序排列，可以继续调整构图。' },
  ],
  tools: [
    { callId: 'read-1', name: 'canvas_read_context', status: 'completed', startedAt: 100, endedAt: 300, summary: '合成测试：读取 3 个节点。' },
    { callId: 'apply-1', name: 'canvas_apply_plan', displayTitle:'创建晨光分镜',displayTitleEn:'Create morning-light storyboard', status: 'completed', startedAt: 400, endedAt: 1400, summary: '合成测试：排列 3 个分镜节点。' },
  ],
  progress: [{ id: 'progress-1', summary: '统一分镜的光线与材质。', createdAt: 500 }],
};
const legacy: CanvasAgentSnapshot = { ...initial, messages: [initial.messages[0], ...Array.from({ length: 9 }, (_, i) => ({ role: 'assistant' as const, text: '', reasoningText: `合成旧版片段 ${i + 1}。` })), { role: 'assistant', text: '合成旧版回复：九个片段应属于同一轮，而不是九个 Agent。' }] };
function Fixture() {
  const [snapshot, setSnapshot] = useState<CanvasAgentSnapshot | null>(initial);
  const [reduced, setReduced] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setSnapshot(current => current?.stream?.reasoning ? {...current, stream:{...current.stream, reasoningText:(current.stream.reasoningText || '') + ' 合成增量：光线沿镜头方向自然延续。'}} : current), 900);
    return () => window.clearInterval(timer);
  }, [busy]);
  const select = (value: CanvasAgentSnapshot | null, running = false) => { setSnapshot(value); setBusy(running); };
  return <CanvasMotionProvider reduced={reduced}><main className={`fixture-stage${reduced ? " reduce-motion" : ""}`}>
    <nav aria-label="合成场景"><button aria-pressed={reduced} onClick={()=>setReduced(value=>!value)}>应用内减少动态</button>
      <button onClick={() => select(initial)}>完整对话</button>
      <button onClick={() => select(legacy)}>旧版九段</button>
      <button onClick={() => select(null)}>欢迎页</button>
      <button onClick={() => select({ ...initial, status: 'running', messages: initial.messages.slice(0, 1), tools: [], progress: [], stream: { attemptId: 'attempt-r6', status: 'streaming', text: '', reasoning: true, reasoningStartedAt:Date.now(),reasoningActiveStartedAt:Date.now(),reasoningDurationMs:0, reasoningText: '合成流式状态：逐步检查镜头之间的连续性。' } }, true)}>流式推理</button>
      <button onClick={() => select({ ...initial, status: 'running', messages: initial.messages.slice(0, 1), tools: [], progress: [], stream: { attemptId: 'attempt-text', status: 'streaming', text: '合成直接回复，没有提供推理内容。', reasoning: false } }, true)}>直接回复</button>
      <button onClick={() => select({ ...initial, status: 'failed', messages: initial.messages.slice(0, 1), tools: [{ callId: 'error-1', name: 'canvas_apply_plan', status: 'failed', startedAt: 100, endedAt: 300, summary: '合成测试：节点在操作前发生变化，未执行。' }] })}>工具失败</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; }}>切换主题</button>
    </nav>
    <div className="fixture-art">晨光 · 产品分镜<br /><small>合成 UI 验证，无模型或生成调用</small></div>
    <CanvasAgentPanel models={{available:[{provider:'Fixture',model:'fixture-reasoner',label:'示例模型',inputModalities:['text'],reasoning:{efforts:[{id:'low',name:'低'},{id:'high',name:'高'}],defaultEffort:'high'}}],defaultModel:{provider:'Fixture',model:'fixture-reasoner'},currentModel:{provider:'Fixture',model:'fixture-reasoner'}}} selectedModel={{provider:'Fixture',model:'fixture-reasoner',reasoningEffort:'high'}} onSelectModel={()=>{}} canvasName="晨光产品分镜" snapshot={snapshot} contextChips={[]} execution={null} busy={busy} draftKey="r7-fixture"
      conversations={[{ conversationId: 'current', sessionId: 'session-current', title: '晨光产品分镜', updatedAt: 1792480000000, messageCount: 2 }, { conversationId: 'older', sessionId: 'session-older', title: '周末短片', updatedAt: 1792300000000, messageCount: 8 }]}
      onSend={async () => true} onCancel={async () => { setBusy(false); setSnapshot(current => current ? { ...current, status: 'cancelled' } : current); }}
      onApply={async () => true} onLocate={() => {}} onRemoveContext={() => {}} onClose={() => {}} onLoadConversations={async () => {}}
      onSelectConversation={async id => { select({ ...initial, conversationId: id, sessionId: `session-${id}` }); return true; }}
      onNewConversation={async () => { select({ ...initial, conversationId: 'new', messages: [], tools: [], progress: [], sessionId: null, runId: null, status: 'idle' }); return true; }} />
  </main></CanvasMotionProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
