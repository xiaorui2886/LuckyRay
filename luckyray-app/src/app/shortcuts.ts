const SHORTCUTS_KEY = "luckyray-settings-v1-shortcuts";

export const SHORTCUT_SCOPE_ORDER = ["global", "materials", "knowledge", "canvas", "graph"] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPE_ORDER)[number];

export type ShortcutCommandDefinition = Readonly<{
  id: string;
  scope: ShortcutScope;
  defaultValue: string;
  nameKey: `settings.shortcuts.name.${string}`;
  descriptionKey: `settings.shortcuts.description.${string}`;
  owner: string;
  desktopGlobal?: boolean;
  allowInTextEntry?: boolean;
  focusedInputOnly?: boolean;
}>;

export const SHORTCUT_COMMANDS = [
  { id: "searchModeToggle", scope: "global", defaultValue: "Tab", nameKey: "settings.shortcuts.name.searchModeToggle", descriptionKey: "settings.shortcuts.description.searchModeToggle", owner: "TitlebarMaterialSearch:focusedInput", focusedInputOnly: true },
  { id: "globalSearch", scope: "global", defaultValue: "Ctrl+K", nameKey: "settings.shortcuts.name.globalSearch", descriptionKey: "settings.shortcuts.description.globalSearch", owner: "AppShell:search.open", desktopGlobal: true },
  { id: "toggleSidebar", scope: "global", defaultValue: "Ctrl+\\", nameKey: "settings.shortcuts.name.toggleSidebar", descriptionKey: "settings.shortcuts.description.toggleSidebar", owner: "AppShell:shell.toggleSidebar" },
  { id: "commandPalette", scope: "global", defaultValue: "Ctrl+Shift+P", nameKey: "settings.shortcuts.name.commandPalette", descriptionKey: "settings.shortcuts.description.commandPalette", owner: "AppShell:commandPalette.open", desktopGlobal: true },
  { id: "captureClip", scope: "global", defaultValue: "Ctrl+Shift+C", nameKey: "settings.shortcuts.name.captureClip", descriptionKey: "settings.shortcuts.description.captureClip", owner: "AppShell:collection.captureClipboard", desktopGlobal: true },
  { id: "aiAssistant", scope: "global", defaultValue: "Ctrl+J", nameKey: "settings.shortcuts.name.aiAssistant", descriptionKey: "settings.shortcuts.description.aiAssistant", owner: "AppShell:route.ai" },
  { id: "openSettings", scope: "global", defaultValue: "Ctrl+,", nameKey: "settings.shortcuts.name.openSettings", descriptionKey: "settings.shortcuts.description.openSettings", owner: "AppShell:route.settings" },
  { id: "navigateBack", scope: "global", defaultValue: "Alt+ArrowLeft", nameKey: "settings.shortcuts.name.navigateBack", descriptionKey: "settings.shortcuts.description.navigateBack", owner: "AppShell:navigation.back" },
  { id: "navigateForward", scope: "global", defaultValue: "Alt+ArrowRight", nameKey: "settings.shortcuts.name.navigateForward", descriptionKey: "settings.shortcuts.description.navigateForward", owner: "AppShell:navigation.forward" },
  { id: "materialsQuickPreview", scope: "materials", defaultValue: "Space", nameKey: "settings.shortcuts.name.materialsQuickPreview", descriptionKey: "settings.shortcuts.description.materialsQuickPreview", owner: "MaterialsPage:openQuickPreview" },
  { id: "toggleDetail", scope: "materials", defaultValue: "Ctrl+D", nameKey: "settings.shortcuts.name.toggleDetail", descriptionKey: "settings.shortcuts.description.toggleDetail", owner: "AppShell:asset.toggleDetail" },
  { id: "materialsSelectAll", scope: "materials", defaultValue: "Ctrl+A", nameKey: "settings.shortcuts.name.materialsSelectAll", descriptionKey: "settings.shortcuts.description.materialsSelectAll", owner: "MaterialsPage:selectAll" },
  { id: "materialsImport", scope: "materials", defaultValue: "Ctrl+I", nameKey: "settings.shortcuts.name.materialsImport", descriptionKey: "settings.shortcuts.description.materialsImport", owner: "MaterialsPage:importAssets" },
  { id: "materialsToggleFilter", scope: "materials", defaultValue: "Ctrl+F", nameKey: "settings.shortcuts.name.materialsToggleFilter", descriptionKey: "settings.shortcuts.description.materialsToggleFilter", owner: "MaterialsPage:toggleFilter" },
  { id: "materialsOpen", scope: "materials", defaultValue: "Enter", nameKey: "settings.shortcuts.name.materialsOpen", descriptionKey: "settings.shortcuts.description.materialsOpen", owner: "MaterialsPage:openSelection" },
  { id: "materialsDelete", scope: "materials", defaultValue: "Delete", nameKey: "settings.shortcuts.name.materialsDelete", descriptionKey: "settings.shortcuts.description.materialsDelete", owner: "MaterialsPage:deleteSelection" },
  { id: "materialsTag", scope: "materials", defaultValue: "#", nameKey: "settings.shortcuts.name.materialsTag", descriptionKey: "settings.shortcuts.description.materialsTag", owner: "MaterialsPage:tagSelection" },
  { id: "newNote", scope: "knowledge", defaultValue: "Ctrl+N", nameKey: "settings.shortcuts.name.newNote", descriptionKey: "settings.shortcuts.description.newNote", owner: "AppShell:note.create" },
  { id: "quickNote", scope: "knowledge", defaultValue: "Ctrl+Shift+N", nameKey: "settings.shortcuts.name.quickNote", descriptionKey: "settings.shortcuts.description.quickNote", owner: "AppShell:note.create" },
  { id: "closeNoteTab", scope: "knowledge", defaultValue: "Ctrl+W", nameKey: "settings.shortcuts.name.closeNoteTab", descriptionKey: "settings.shortcuts.description.closeNoteTab", owner: "AppShell:note.closeTab", allowInTextEntry: true },
  { id: "nextNoteTab", scope: "knowledge", defaultValue: "Ctrl+Tab", nameKey: "settings.shortcuts.name.nextNoteTab", descriptionKey: "settings.shortcuts.description.nextNoteTab", owner: "AppShell:note.nextTab", allowInTextEntry: true },
  { id: "prevNoteTab", scope: "knowledge", defaultValue: "Ctrl+Shift+Tab", nameKey: "settings.shortcuts.name.prevNoteTab", descriptionKey: "settings.shortcuts.description.prevNoteTab", owner: "AppShell:note.prevTab", allowInTextEntry: true },
  { id: "toggleNotesIndex", scope: "knowledge", defaultValue: "Ctrl+Shift+I", nameKey: "settings.shortcuts.name.toggleNotesIndex", descriptionKey: "settings.shortcuts.description.toggleNotesIndex", owner: "AppShell:note.toggleIndex", allowInTextEntry: true },
  { id: "knowledgeSave", scope: "knowledge", defaultValue: "Ctrl+S", nameKey: "settings.shortcuts.name.knowledgeSave", descriptionKey: "settings.shortcuts.description.knowledgeSave", owner: "NotesPage:saveNote", allowInTextEntry: true },
  { id: "knowledgeBold", scope: "knowledge", defaultValue: "Ctrl+B", nameKey: "settings.shortcuts.name.knowledgeBold", descriptionKey: "settings.shortcuts.description.knowledgeBold", owner: "NotesPage:editor.bold", allowInTextEntry: true },
  { id: "knowledgeItalic", scope: "knowledge", defaultValue: "Ctrl+I", nameKey: "settings.shortcuts.name.knowledgeItalic", descriptionKey: "settings.shortcuts.description.knowledgeItalic", owner: "NotesPage:editor.italic", allowInTextEntry: true },
  { id: "knowledgeLink", scope: "knowledge", defaultValue: "Ctrl+K", nameKey: "settings.shortcuts.name.knowledgeLink", descriptionKey: "settings.shortcuts.description.knowledgeLink", owner: "NotesPage:editor.link", allowInTextEntry: true },
  { id: "knowledgeExternalLink", scope: "knowledge", defaultValue: "Ctrl+Shift+K", nameKey: "settings.shortcuts.name.knowledgeExternalLink", descriptionKey: "settings.shortcuts.description.knowledgeExternalLink", owner: "NotesPage:editor.externalLink", allowInTextEntry: true },
  { id: "knowledgePreview", scope: "knowledge", defaultValue: "Ctrl+E", nameKey: "settings.shortcuts.name.knowledgePreview", descriptionKey: "settings.shortcuts.description.knowledgePreview", owner: "NotesPage:editor.preview", allowInTextEntry: true },
  { id: "knowledgeSource", scope: "knowledge", defaultValue: "Ctrl+Shift+E", nameKey: "settings.shortcuts.name.knowledgeSource", descriptionKey: "settings.shortcuts.description.knowledgeSource", owner: "NotesPage:editor.source", allowInTextEntry: true },
  { id: "knowledgeAiWrite", scope: "knowledge", defaultValue: "Ctrl+J", nameKey: "settings.shortcuts.name.knowledgeAiWrite", descriptionKey: "settings.shortcuts.description.knowledgeAiWrite", owner: "NotesPage:editor.aiWrite", allowInTextEntry: true },
  { id: "knowledgeAutocomplete", scope: "knowledge", defaultValue: "Ctrl+Space", nameKey: "settings.shortcuts.name.knowledgeAutocomplete", descriptionKey: "settings.shortcuts.description.knowledgeAutocomplete", owner: "NotesPage:editor.autocomplete", allowInTextEntry: true },
  { id: "canvasSave", scope: "canvas", defaultValue: "Ctrl+S", nameKey: "settings.shortcuts.name.canvasSave", descriptionKey: "settings.shortcuts.description.canvasSave", owner: "CanvasSpike:save" },
  { id: "canvasCopy", scope: "canvas", defaultValue: "Ctrl+C", nameKey: "settings.shortcuts.name.canvasCopy", descriptionKey: "settings.shortcuts.description.canvasCopy", owner: "CanvasSpike:copy" },
  { id: "canvasPaste", scope: "canvas", defaultValue: "Ctrl+V", nameKey: "settings.shortcuts.name.canvasPaste", descriptionKey: "settings.shortcuts.description.canvasPaste", owner: "CanvasSpike:paste" },
  { id: "canvasUndo", scope: "canvas", defaultValue: "Ctrl+Z", nameKey: "settings.shortcuts.name.canvasUndo", descriptionKey: "settings.shortcuts.description.canvasUndo", owner: "CanvasSpike:undo" },
  { id: "canvasRedo", scope: "canvas", defaultValue: "Ctrl+Y", nameKey: "settings.shortcuts.name.canvasRedo", descriptionKey: "settings.shortcuts.description.canvasRedo", owner: "CanvasSpike:redo" },
  { id: "canvasRedoAlternate", scope: "canvas", defaultValue: "Ctrl+Shift+Z", nameKey: "settings.shortcuts.name.canvasRedoAlternate", descriptionKey: "settings.shortcuts.description.canvasRedoAlternate", owner: "CanvasSpike:redo" },
  { id: "canvasDeleteSelection", scope: "canvas", defaultValue: "Delete", nameKey: "settings.shortcuts.name.canvasDeleteSelection", descriptionKey: "settings.shortcuts.description.canvasDeleteSelection", owner: "CanvasSpike:deleteSelection" },
  { id: "canvasDeleteSelectionAlternate", scope: "canvas", defaultValue: "Backspace", nameKey: "settings.shortcuts.name.canvasDeleteSelectionAlternate", descriptionKey: "settings.shortcuts.description.canvasDeleteSelectionAlternate", owner: "CanvasSpike:deleteSelection" },
  { id: "graphCloseFloating", scope: "graph", defaultValue: "Esc", nameKey: "settings.shortcuts.name.graphCloseFloating", descriptionKey: "settings.shortcuts.description.graphCloseFloating", owner: "GraphPage:closeFloatingMenus" },
] as const satisfies readonly ShortcutCommandDefinition[];

export type ShortcutCommandId = (typeof SHORTCUT_COMMANDS)[number]["id"];
export type ShortcutValues = Partial<Record<ShortcutCommandId, string>>;

const BY_ID = new Map<ShortcutCommandId, (typeof SHORTCUT_COMMANDS)[number]>(SHORTCUT_COMMANDS.map((item) => [item.id, item]));

function readOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getShortcutDefinition(id: ShortcutCommandId) { return BY_ID.get(id); }

export function getShortcutValue(id: ShortcutCommandId): string {
  const base = BY_ID.get(id);
  const overrides = readOverrides();
  return String(overrides[id] || base?.defaultValue || "");
}

function normalizeKey(key: string) {
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function normalizeShortcut(value: string) {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  const modifiers = new Set<string>();
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") modifiers.add("Ctrl");
    else if (lower === "shift") modifiers.add("Shift");
    else if (lower === "alt") modifiers.add("Alt");
    else if (lower === "meta" || lower === "cmd" || lower === "command") modifiers.add("Meta");
    else key = normalizeKey(part);
  }
  return { ctrl: modifiers.has("Ctrl"), shift: modifiers.has("Shift"), alt: modifiers.has("Alt"), meta: modifiers.has("Meta"), key };
}

export function normalizeShortcutForConflict(value: string): string {
  const parsed = normalizeShortcut(value);
  if (!parsed.key || (parsed.ctrl && parsed.meta)) return "";
  return `${parsed.ctrl || parsed.meta ? "Mod+" : ""}${parsed.alt ? "Alt+" : ""}${parsed.shift ? "Shift+" : ""}${parsed.key}`;
}

function matchesValue(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = normalizeShortcut(shortcut);
  if (parsed.ctrl && parsed.meta) return false;
  const commandOrControl = parsed.ctrl ? Boolean(event.ctrlKey || event.metaKey) : !event.ctrlKey;
  const meta = parsed.meta ? Boolean(event.metaKey) : (parsed.ctrl ? true : !event.metaKey);
  return Boolean(parsed.key)
    && commandOrControl
    && Boolean(event.shiftKey) === parsed.shift
    && Boolean(event.altKey) === parsed.alt
    && meta
    && normalizeKey(event.key) === parsed.key;
}

export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tagName = element?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(element?.isContentEditable);
}

function hasOpenModal(): boolean {
  return typeof document !== "undefined" && Boolean(document.querySelector('[aria-modal="true"], [role="dialog"][open]'));
}

export function matchesShortcut(event: KeyboardEvent, id: ShortcutCommandId, values?: ShortcutValues): boolean {
  const shortcut = values?.[id] ?? getShortcutValue(id);
  return Boolean(shortcut) && matchesValue(event, shortcut);
}

export function resolveScopedShortcut(
  event: KeyboardEvent,
  activeScope: Exclude<ShortcutScope, "global"> | null,
  values?: ShortcutValues,
  options: Readonly<{ modalOpen?: boolean; ids?: readonly ShortcutCommandId[] }> = {},
): ShortcutCommandId | null {
  if (event.defaultPrevented || event.isComposing || options.modalOpen || hasOpenModal()) return null;
  const allowedIds = options.ids ? new Set(options.ids) : null;
  const textEntry = isTextEntry(event.target);
  for (const command of SHORTCUT_COMMANDS) {
    if ("focusedInputOnly" in command && command.focusedInputOnly) continue;
    if (command.scope !== "global" && command.scope !== activeScope) continue;
    if (allowedIds && !allowedIds.has(command.id)) continue;
    if (textEntry && !("allowInTextEntry" in command && command.allowInTextEntry)) continue;
    if (matchesShortcut(event, command.id, values)) return command.id;
  }
  return null;
}

export function findShortcutCommand(event: KeyboardEvent, ids: readonly ShortcutCommandId[]): ShortcutCommandId | null {
  return ids.find((id) => matchesShortcut(event, id)) || null;
}

export type ShortcutConflict = Readonly<{ kind: "same-scope" | "global-route"; shortcut: string; ids: readonly [ShortcutCommandId, ShortcutCommandId] }>;

export function findShortcutConflicts(values: readonly { id: ShortcutCommandId; value: string }[]): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const left = values[index];
    const leftDefinition = BY_ID.get(left.id);
    const normalized = normalizeShortcutForConflict(left.value);
    if (!leftDefinition || !normalized) continue;
    for (let candidate = index + 1; candidate < values.length; candidate += 1) {
      const right = values[candidate];
      const rightDefinition = BY_ID.get(right.id);
      if (!rightDefinition || normalizeShortcutForConflict(right.value) !== normalized) continue;
      if (leftDefinition.scope === rightDefinition.scope) conflicts.push({ kind: "same-scope", shortcut: normalized, ids: [left.id, right.id] });
      else if (leftDefinition.scope === "global" || rightDefinition.scope === "global") conflicts.push({ kind: "global-route", shortcut: normalized, ids: [left.id, right.id] });
    }
  }
  return conflicts;
}
