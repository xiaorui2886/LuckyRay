import { isEnabled } from "../../featureFlags";
import type { ShellRoute } from "../../app/AppSidebar";
import type { ShortcutCommandId } from "../../app/shortcuts";
import { getLuckyRayBridge } from "../bridge/luckyRayBridge";
import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from "../i18n/index";

export type LuckyRayCommandId =
  | "search.open"
  | "commandPalette.open"
  | "route.materials"
  | "route.notes"
  | "route.graph"
  | "route.canvas"
  | "route.community"
  | "route.ai"
  | "route.tags"
  | "route.collection"
  | "route.settings"
  | "note.create"
  | "note.closeTab"
  | "note.nextTab"
  | "note.prevTab"
  | "note.toggleIndex"
  | "asset.import"
  | "asset.toggleDetail"
  | "collection.captureClipboard"
  | "shell.toggleSidebar";

export type LuckyRayCommandContext = {
  openSearch?: () => void;
  openCommandPalette?: () => void;
  getRoute?: () => ShellRoute;
};

export type LuckyRayCommand = {
  id: LuckyRayCommandId;
  label: string;
  hint: string;
  keywords: string;
  shortcutId?: ShortcutCommandId;
  palette?: boolean;
};

type CommandDefinition = Omit<LuckyRayCommand, "label"> & { labelKey: MessageKey };

const COMMAND_DEFINITIONS: CommandDefinition[] = [
  { id: "search.open", labelKey: "command.search.open", hint: "Ctrl+K", keywords: "search global 搜索", shortcutId: "globalSearch", palette: true },
  { id: "route.materials", labelKey: "command.route.materials", hint: "navigation materials assets 素材", keywords: "materials assets 素材", palette: true },
  { id: "route.notes", labelKey: "command.route.notes", hint: "navigation notes knowledge 笔记 知识库", keywords: "notes knowledge 笔记 知识库", palette: true },
  { id: "route.graph", labelKey: "command.route.graph", hint: "navigation graph 图谱", keywords: "graph 图谱", palette: true },
  { id: "route.canvas", labelKey: "command.route.canvas", hint: "navigation canvas 画布", keywords: "canvas 画布", palette: true },
  { id: "route.community", labelKey: "command.route.community", hint: "navigation community capability 社区 能力", keywords: "community capability 社区 能力", palette: true },
  { id: "route.ai", labelKey: "command.route.ai", hint: "Ctrl+J", keywords: "ai assistant 助手", shortcutId: "aiAssistant", palette: true },
  { id: "route.tags", labelKey: "command.route.tags", hint: "navigation tags 标签", keywords: "tags 标签", palette: true },
  { id: "route.collection", labelKey: "command.route.collection", hint: "navigation collection inbox 收集箱", keywords: "collection inbox 收集箱", palette: true },
  { id: "route.settings", labelKey: "command.route.settings", hint: "Ctrl+,", keywords: "settings preferences 设置", palette: true },
  { id: "note.create", labelKey: "command.note.create", hint: "Ctrl+N", keywords: "note create new 新建笔记", shortcutId: "newNote", palette: true },
  { id: "asset.import", labelKey: "command.asset.import", hint: "materials 素材库", keywords: "asset import materials 导入素材", palette: true },
  { id: "collection.captureClipboard", labelKey: "command.collection.captureClipboard", hint: "Ctrl+Shift+C", keywords: "clipboard collection capture 剪贴板 收集", shortcutId: "captureClip", palette: true },
  { id: "shell.toggleSidebar", labelKey: "command.shell.toggleSidebar", hint: "Ctrl+\\", keywords: "sidebar shell 侧边栏", shortcutId: "toggleSidebar", palette: true },
  { id: "asset.toggleDetail", labelKey: "command.asset.toggleDetail", hint: "Ctrl+D", keywords: "asset detail inspector 素材详情", shortcutId: "toggleDetail", palette: true },
  { id: "note.toggleIndex", labelKey: "command.note.toggleIndex", hint: "Ctrl+Shift+I", keywords: "note index panel 知识索引", shortcutId: "toggleNotesIndex", palette: true },
  { id: "commandPalette.open", labelKey: "command.palette.open", hint: "Ctrl+Shift+P", keywords: "command palette 命令面板", shortcutId: "commandPalette" },
  { id: "note.closeTab", labelKey: "command.note.closeTab", hint: "Ctrl+W", keywords: "note tab close 关闭笔记标签", shortcutId: "closeNoteTab" },
  { id: "note.nextTab", labelKey: "command.note.nextTab", hint: "Ctrl+Tab", keywords: "note tab next 下一个笔记标签", shortcutId: "nextNoteTab" },
  { id: "note.prevTab", labelKey: "command.note.prevTab", hint: "Ctrl+Shift+Tab", keywords: "note tab previous 上一个笔记标签", shortcutId: "prevNoteTab" },
];

function localizeCommands(locale: Locale): LuckyRayCommand[] {
  return COMMAND_DEFINITIONS.map(({ labelKey, ...command }) => ({
    ...command,
    label: translate(locale, labelKey),
    hint: command.hint.startsWith("navigation ") ? translate(locale, "shell.command.hint.navigation") : command.hint,
  }));
}

export const APP_COMMANDS: LuckyRayCommand[] = localizeCommands(DEFAULT_LOCALE);

const SHORTCUT_TO_COMMAND = new Map<ShortcutCommandId, LuckyRayCommandId>(
  APP_COMMANDS
    .filter((command): command is LuckyRayCommand & { shortcutId: ShortcutCommandId } => Boolean(command.shortcutId))
    .map((command) => [command.shortcutId, command.id])
);

function navigate(route: ShellRoute) {
  window.location.hash = `#${route}`;
}

function dispatch(name: string) {
  window.dispatchEvent(new CustomEvent(name));
}

function runNotesCommand(command: LuckyRayCommandId, context: LuckyRayCommandContext) {
  if (context.getRoute?.() !== "notes") return;
  if (command === "note.closeTab") dispatch("luckyray:notes-tab-close-active");
  if (command === "note.nextTab") dispatch("luckyray:notes-tab-next");
  if (command === "note.prevTab") dispatch("luckyray:notes-tab-prev");
  if (command === "note.toggleIndex") dispatch("luckyray:notes-toggle-panel");
}

export function getCommandIdForShortcut(id: ShortcutCommandId): LuckyRayCommandId | null {
  if (id === "quickNote") return "note.create";
  return SHORTCUT_TO_COMMAND.get(id) || null;
}

export function listPaletteCommands(locale: Locale = DEFAULT_LOCALE): LuckyRayCommand[] {
  return localizeCommands(locale).filter((command) => command.palette);
}

export async function runAppCommand(id: LuckyRayCommandId, context: LuckyRayCommandContext = {}): Promise<void> {
  switch (id) {
    case "search.open":
      if (isEnabled("searchReact")) context.openSearch?.();
      return;
    case "commandPalette.open":
      context.openCommandPalette?.();
      return;
    case "route.materials":
      navigate("materials");
      return;
    case "route.notes":
      navigate("notes");
      return;
    case "route.graph":
      navigate("graph");
      return;
    case "route.canvas":
      navigate("canvas");
      return;
    case "route.community":
      navigate("community");
      return;
    case "route.ai":
      navigate("ai");
      return;
    case "route.tags":
      navigate("tags");
      return;
    case "route.collection":
      navigate("collection");
      return;
    case "route.settings":
      navigate("settings");
      return;
    case "note.create":
      navigate("notes");
      window.setTimeout(() => dispatch("luckyray:notes-create"), 0);
      return;
    case "note.closeTab":
    case "note.nextTab":
    case "note.prevTab":
    case "note.toggleIndex":
      runNotesCommand(id, context);
      return;
    case "asset.import":
      navigate("materials");
      window.setTimeout(() => dispatch("luckyray:materials-import"), 0);
      return;
    case "asset.toggleDetail":
      dispatch("luckyray:materials-toggle-detail");
      return;
    case "collection.captureClipboard":
      await getLuckyRayBridge()
        .then((bridge) => bridge.collectionAddClipboard("text"))
        .catch(() => undefined);
      navigate("collection");
      return;
    case "shell.toggleSidebar":
      dispatch("luckyray:shell-toggle-sidebar");
      return;
  }
}
