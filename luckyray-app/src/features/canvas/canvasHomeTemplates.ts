import { instantiateWorkflow, WORKFLOW_FORMAT, type WorkflowTemplate, type WorkflowNode } from "../../core/canvas/workflowTemplates";

export type HomeTemplateKind = "blank" | "material" | "note" | "ai";
/** Ready-to-edit local graphs. No provider calls, demo media, invented knowledge IDs or generated results. */
export function buildHomeTemplate(kind: HomeTemplateKind, english = false, nextId = () => crypto.randomUUID()) {
  if (kind === "blank") return { nodes: [], edges: [] };
  const text = (id: string, zh: string, en: string, x: number, y: number): WorkflowNode => ({ id, kind: "text", label: english ? en : zh, position: { x, y }, width: 320, height: 180 });
  const nodes: WorkflowNode[] = kind === "material" ? [
    { id: "references", kind: "group", label: english ? "Visual references" : "视觉参考", position: { x: 0, y: 0 }, width: 760, height: 480, referencePack: { version: 1, kind: "style" } },
    { ...text("brief", "创作方向\n双击填写主题、色彩、构图和需要保留的元素。", "Creative direction\nDouble-click to describe the subject, colors, composition and details to preserve.", 28, 64), parentId: "references" },
    text("notes", "参考记录\n将素材库中的图片或视频拖入参考包，再在这里记录可借鉴的细节。", "Reference notes\nDrag images or videos from the library into the reference pack, then note the useful details here.", 808, 0),
  ] : kind === "note" ? [
    text("topic", "核心主题\n双击填写你正在研究的问题。", "Central topic\nDouble-click to describe the question you are exploring.", 0, 170),
    text("evidence", "资料与笔记\n从知识库拖入真实笔记，连接到本主题。", "Sources and notes\nDrag real notes from Knowledge and connect them to the topic.", 420, 0),
    text("ideas", "结论与下一步\n整理观点、证据和待验证的问题。", "Findings and next steps\nOrganize conclusions, evidence and open questions.", 420, 340),
  ] : [
    text("brief", "短片脚本\n填写主题、角色、场景、情绪与镜头安排。", "Short-film brief\nDescribe the theme, characters, setting, mood and shot plan.", 0, 0),
    ...[0, 1, 2].map((i): WorkflowNode => ({ id: `shot${i + 1}`, kind: "generator", generationKind: "image", label: english ? `Shot ${i + 1}` : `镜头 ${i + 1}`, prompt: english ? `Create shot ${i + 1} from the connected script. Describe composition and action here, and keep characters and style consistent.` : `根据连接的脚本设计镜头 ${i + 1}。在这里填写构图与动作要求，保持角色与风格一致。`, aspect: "16:9", position: { x: 420 + i * 760, y: 0 } })),
  ];
  const edges = kind === "note" ? ["evidence", "ideas"].map((target, order) => ({ source: "topic", target, role: "promptContext" as const, order })) : kind === "ai" ? [1, 2, 3].map((i) => ({ source: "brief", target: `shot${i}`, role: "promptContext" as const, order: i - 1 })) : [];
  const template: WorkflowTemplate = { format: WORKFLOW_FORMAT, version: 1, name: kind, description: "", nodes, edges };
  return instantiateWorkflow(template, { x: 60, y: 80 }, nextId);
}

export function toggleHomeSelection(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
