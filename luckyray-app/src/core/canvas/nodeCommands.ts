import {
  getCanvasNodeCapabilities,
  type CanvasNodeCapabilityData,
} from "./nodeCapabilities";

/** Stable command ids shared by the desktop canvas and future CLI/MCP adapters. */
export const CANVAS_NODE_COMMAND_IDS = {
  detail: "canvas.node.detail",
  edit: "canvas.node.edit",
  openSource: "canvas.node.open-source",
  replaceMedia: "canvas.node.replace-media",
  clearMedia: "canvas.node.clear-media",
  derive: "canvas.node.derive",
  saveResult: "canvas.node.save-result",
  saveNote: "canvas.node.save-note",
  clearGenerator: "canvas.node.clear-generator",
  duplicate: "canvas.node.duplicate",
  delete: "canvas.node.delete",
} as const;

export type CanvasNodeCommandId = (typeof CANVAS_NODE_COMMAND_IDS)[keyof typeof CANVAS_NODE_COMMAND_IDS];
export type CanvasNodeCommandGroup = "primary" | "manage";
export type CanvasNodeCommandTone = "default" | "danger";
export type CanvasNodeCommandIcon = "detail" | "edit" | "open" | "replace" | "clear" | "derive" | "save" | "duplicate" | "delete";

export type CanvasNodeCommand = {
  id: CanvasNodeCommandId;
  label: string;
  hint: string;
  icon: CanvasNodeCommandIcon;
  group: CanvasNodeCommandGroup;
  tone: CanvasNodeCommandTone;
  enabled: boolean;
};

const command = (
  id: CanvasNodeCommandId,
  label: string,
  hint: string,
  icon: CanvasNodeCommandIcon,
  group: CanvasNodeCommandGroup = "primary",
  enabled = true,
  tone: CanvasNodeCommandTone = "default",
): CanvasNodeCommand => ({ id, label, hint, icon, group, tone, enabled });

export function getCanvasNodeCommands(data: CanvasNodeCapabilityData): CanvasNodeCommand[] {
  const capabilities = getCanvasNodeCapabilities(data);
  const commands: CanvasNodeCommand[] = [
    command(CANVAS_NODE_COMMAND_IDS.detail, "查看详情", "打开节点详情", "detail"),
  ];

  if (data.kind === "text" || data.kind === "aiPrompt") {
    commands.push(command(CANVAS_NODE_COMMAND_IDS.edit, "编辑内容", "直接编辑卡片文字", "edit"));
  }

  if ((data.kind === "image" || data.kind === "video") && data._emptyMedia !== true) {
    commands.push(
      command(CANVAS_NODE_COMMAND_IDS.openSource, "打开原素材", "前往素材库查看来源", "open"),
      command(CANVAS_NODE_COMMAND_IDS.replaceMedia, "替换素材", "从素材库选择同类型内容", "replace"),
      command(CANVAS_NODE_COMMAND_IDS.clearMedia, "清空素材", "恢复为空白占位卡片", "clear"),
    );
  }

  if (data.kind === "noteRef") {
    commands.push(command(CANVAS_NODE_COMMAND_IDS.openSource, "打开原笔记", "前往知识库查看来源", "open"));
  }

  if (capabilities.contentActions.includes("derive")) {
    commands.push(command(CANVAS_NODE_COMMAND_IDS.derive, "继续创作", "以当前节点作为创作上下文", "derive"));
  }

  if (data.kind === "text" || (data.kind === "aiResult" && (!data.resultKind || data.resultKind === "text"))) {
    commands.push(command(CANVAS_NODE_COMMAND_IDS.saveNote,"保存为新笔记","新建到当前知识库根目录","save"));
  }
  if (["image","video","generator"].includes(data.kind) || (data.kind === "aiResult" && data.resultKind !== "text")) {
    commands.push(command(
      CANVAS_NODE_COMMAND_IDS.saveResult,
      "保存到素材库",
      "将生成结果保存到默认素材库",
      "save",
      "primary",
      true,
    ));
  }

  if (data.kind === "generator") {
    commands.push(command(CANVAS_NODE_COMMAND_IDS.clearGenerator, "清空输入", "保留卡片并重置提示词", "clear"));
  }

  commands.push(
    command(CANVAS_NODE_COMMAND_IDS.duplicate, "复制卡片", "在右下方创建副本", "duplicate", "manage"),
    command(CANVAS_NODE_COMMAND_IDS.delete, "删除卡片", "同时移除相关连线", "delete", "manage", true, "danger"),
  );

  return commands;
}
