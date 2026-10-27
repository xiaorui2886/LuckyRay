import type { ShortcutScope } from "./shortcuts";
/** Fixed, context-owned keys are reference-only, not pretend-rebindable commands.
 * source identifies the actual handler inspected for the October 2026 audit. */
export type ShortcutReferenceGroup = { scope: ShortcutScope; title: string; titleEn: string; source: string; rows: readonly (readonly [string, string, string])[] };
export const SHORTCUT_REFERENCE_GROUPS: readonly ShortcutReferenceGroup[] = [
  { scope: "global", title: "菜单与弹窗", titleEn: "Menus and dialogs", source: "components/ContextMenuSurface.tsx; app/applicationModalIsolation.ts", rows: [
    ["切换焦点 / 反向切换", "Move focus / previous focus", "Tab / Shift + Tab"],
    ["菜单移动 / 首项 / 末项", "Menu navigation / first / last", "↑ / ↓ / Home / End"],
    ["执行聚焦操作 / 关闭当前弹层", "Activate focused action / close layer", "Enter / Esc"],
  ] },
  { scope: "materials", title: "素材选择与详情", titleEn: "Material selection and details", source: "features/materials/MaterialsPage.tsx", rows: [
    ["增减选择", "Toggle selection", "Ctrl / Cmd + 点击"],
    ["详情中上一项 / 下一项", "Previous / next item in details", "← / →"],
    ["关闭当前详情 / 退出选择", "Close details / clear selection", "Esc"],
  ] },
  { scope: "materials", title: "图片对比", titleEn: "Image comparison", source: "features/materials/MaterialCompareModal.tsx", rows: [
    ["切换当前图片", "Switch active image", "← / →"],
    ["放大 / 缩小", "Zoom in / out", "+ / −"],
    ["适合窗口 / 原始比例", "Fit / actual size", "0 / 1"],
    ["联动缩放 / 重置全部", "Linked zoom / reset all", "L / R"],
    ["关闭选择器或对比", "Close picker or comparison", "Esc"],
  ] },
  { scope: "knowledge", title: "笔记编辑与查找", titleEn: "Note editing and search", source: "features/notes/editor/LiveMarkdownEditor.tsx; @codemirror/commands; @codemirror/search", rows: [
    ["撤销 / 重做（编辑器内）", "Undo / redo in editor", "Ctrl / Cmd + Z · Ctrl + Y / Cmd + Shift + Z"],
    ["查找 / 下一个 / 上一个结果", "Find / next / previous match", "Ctrl / Cmd + F · F3 / Shift + F3"],
    ["下一个 / 上一个结果（替代）", "Next / previous match (alternate)", "Ctrl / Cmd + G · Ctrl / Cmd + Shift + G"],
    ["跳到行", "Go to line", "Ctrl / Cmd + Alt + G"],
    ["选中下一个相同内容", "Select next occurrence", "Ctrl / Cmd + D"],
    ["选中全部相同内容", "Select all occurrences", "Ctrl / Cmd + Shift + L"],
    ["上移 / 下移当前行", "Move line up / down", "Alt + ↑ / ↓"],
    ["复制行到上方 / 下方", "Copy line up / down", "Shift + Alt + ↑ / ↓"],
    ["添加上方 / 下方光标", "Add cursor above / below", "Ctrl / Cmd + Alt + ↑ / ↓"],
    ["列表缩进 / 取消缩进", "Indent / outdent list", "Tab / Shift + Tab"],
    ["减少 / 增加缩进", "Decrease / increase indent", "Ctrl / Cmd + [ / ]"],
    ["折叠 / 展开当前章节", "Fold / unfold section", "Ctrl + Shift + [ / ] · Cmd + Alt + [ / ]"],
    ["折叠 / 展开全部章节", "Fold / unfold all", "Ctrl + Alt + [ / ]"],
    ["接受链接候选 / 取消候选", "Accept / dismiss link completion", "Enter / Tab · Esc"],
    ["切换 Tab 焦点模式", "Toggle Tab focus mode", "Ctrl + M · macOS: Shift + Alt + M"],
  ] },
  { scope: "canvas", title: "画布与 Agent", titleEn: "Canvas and Agent", source: "CanvasSpike.tsx; features/canvas/CanvasAgentPanel.tsx; features/canvas/CanvasTextDocument.tsx", rows: [
    ["微移节点 1 / 10 个画布单位", "Nudge nodes by 1 / 10 canvas units", "方向键 / Shift + 方向键"],
    ["增减节点选择", "Toggle node selection", "Ctrl / Cmd / Shift + 点击"],
    ["重命名聚焦的画布标题", "Rename focused canvas title", "F2 / Enter"],
    ["发送 Agent 消息 / 换行", "Send Agent message / newline", "Enter / Shift + Enter"],
    ["文本节点加粗 / 斜体", "Bold / italic in text node", "Ctrl / Cmd + B / I"],
    ["结束文本节点编辑", "Finish editing text node", "Ctrl / Cmd + Enter / Esc"],
    ["同组参考项前移 / 后移", "Reorder focused reference in its group", "Alt + ← / →"],
    ["关闭当前菜单或聚焦编辑", "Close current menu or focus editor", "Esc"],
  ] },
];

export function matchingShortcutReferences(scope: ShortcutScope, query: string): ShortcutReferenceGroup[] {
  const needle = query.trim().toLowerCase();
  return SHORTCUT_REFERENCE_GROUPS
    .filter(group => Boolean(needle) || group.scope === scope)
    .map(group => ({ ...group, rows: group.rows.filter(row => !needle || `${group.title} ${group.titleEn} ${row.join(" ")}`.toLowerCase().includes(needle)) }))
    .filter(group => group.rows.length > 0);
}
