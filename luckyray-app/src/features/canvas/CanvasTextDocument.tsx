import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NodeToolbar, Position, useStore } from '@xyflow/react';
import { canvasTextToolbarGeometry } from './canvasTextToolbarGeometry';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { liveMarkdownPreview } from '../notes/editor/liveMarkdownExtensions';
import { parseNoteInline, type NoteInlineToken } from '../../core/services/noteRenderer';
import { canvasScriptTemplate, canvasTextOutline, formatCanvasText, type CanvasTextFormat } from './canvasTextEditing';
import '../notes/editor/liveMarkdown.css';
import './canvasTextDocument.css';

export type CanvasTextDocumentProps = {
  nodeId: string; value: string; selected: boolean; editing: boolean; english?: boolean; placeholder?: string;
  onChange: (value: string) => void; onStartEditing: () => void; onFinishEditing: () => void;
};
const formats: [CanvasTextFormat, string, string, string][] = [
  ['h1', 'H1', '一级标题', 'Heading 1'], ['h2', 'H2', '二级标题', 'Heading 2'], ['h3', 'H3', '三级标题', 'Heading 3'],
  ['paragraph', '¶', '正文', 'Paragraph'], ['bold', 'B', '加粗', 'Bold'], ['italic', 'I', '斜体', 'Italic'],
  ['strike', 'S', '删除线', 'Strikethrough'], ['bullet', '• ≡', '无序列表', 'Bullet list'], ['number', '1. ≡', '有序列表', 'Numbered list'],
];
function inline(tokens: NoteInlineToken[]): ReactNode {
  return tokens.map((token, i) => {
    if (token.type === 'strong') return <strong key={i}>{token.value}</strong>;
    if (token.type === 'emphasis') return <em key={i}>{token.value}</em>;
    if (token.type === 'strike') return <s key={i}>{token.value}</s>;
    if (token.type === 'code') return <code key={i}>{token.value}</code>;
    return <span key={i}>{token.type === 'text' ? token.value : token.type === 'url' ? token.label : token.display}</span>;
  });
}
/** No EditorViews for idle nodes, no HTML injection and no loading remote embeds. */
export function CanvasTextPreview({ value, placeholder: hint }: { value: string; placeholder?: string }) {
  const lines = useMemo(() => {
    let fence = '';
    // Card-only preview budget, never a limit or truncation of saved/editable text.
    return value.slice(0, 12000).split('\n').slice(0, 80).map((line, index) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''; }
      const heading = !fence && !marker ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
      return <div key={index} className={`canvas-text-line${heading ? ` h${heading[1].length}` : ''}${fence || marker ? ' is-code' : ''}`}>{heading ? inline(parseNoteInline(heading[2])) : fence || marker ? line || '\u200b' : inline(parseNoteInline(line || '\u200b'))}</div>;
    });
  }, [value]);
  return <div className={`canvas-text-preview${value ? '' : ' is-empty'}`}>{value ? lines : hint}</div>;
}
/** React Flow owns pan/zoom/node-resize updates; only toolbar size needs an observer. */
function FloatingTextToolbar({ nodeId, toolbarRef, children }: { nodeId: string; toolbarRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const metrics = useStore(state => {
    const node = state.nodeLookup.get(nodeId);
    const [x, y, zoom] = state.transform;
    return [node ? (node.internals.positionAbsolute.x + (node.measured.width || 0) / 2) * zoom + x : 0,
      node ? node.internals.positionAbsolute.y * zoom + y : 0, zoom, state.width, state.height];
  }, (a, b) => a.every((value, index) => value === b[index]));
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setSize(old => old.width === rect.width && old.height === rect.height ? old : { width: rect.width, height: rect.height }); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  });
  const placement = canvasTextToolbarGeometry(metrics[0], metrics[1], metrics[2], metrics[3], metrics[4], size.width, size.height);
  return <NodeToolbar nodeId={nodeId} isVisible position={Position.Top} align="center" offset={placement.offset}
    className="canvas-text-floating-tools nodrag nopan nowheel"
    style={{ marginLeft: placement.shiftX, maxWidth: placement.maxWidth, visibility: placement.visible ? 'visible' : 'hidden' }}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div ref={toolbarRef} className="canvas-text-floating-content" style={{ maxWidth: placement.maxWidth }}>{children}</div>
  </NodeToolbar>;
}
export function CanvasTextDocument(props: CanvasTextDocumentProps) {
  const latest = useRef(props); latest.current = props;
  const expandedRef = useRef(false);
  const [expanded, setExpanded] = useState(false); expandedRef.current = expanded;
  const [revision, setRevision] = useState(0);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const [zoom, setZoom] = useState(100);
  const [templateMenu, setTemplateMenu] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null), savedState = useRef<EditorState | null>(null);
  const floatingToolbar = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const active = props.editing || expanded;
  const english = !!props.english;
  const label = (zh: string, en: string) => english ? en : zh;
  const outline = useMemo(() => canvasTextOutline(props.value), [props.value]);
  const outlineRef = useRef(outline); outlineRef.current = outline;
  const composing = () => !!view.current?.compositionStarted;
  const closeExpanded = () => { if (composing()) return; setExpanded(false); setTemplateMenu(false); latest.current.onFinishEditing(); requestAnimationFrame(() => (focusReturn.current?.isConnected ? focusReturn.current : wrapper.current)?.focus({ preventScroll: true })); };
  const finish = () => { if (composing()) return; if (templateMenu) { setTemplateMenu(false); return; } expanded ? closeExpanded() : latest.current.onFinishEditing(); };
  const apply = (format: CanvasTextFormat) => {
    const editor = view.current; if (!editor || composing()) return;
    const selection = editor.state.selection.main;
    const edit = formatCanvasText(editor.state.doc.toString(), selection.from, selection.to, format);
    editor.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.anchor, head: edit.head }, userEvent: 'input.format' });
    editor.focus();
  };
  const actions = useRef({ finish, apply }); actions.current = { finish, apply };
  useLayoutEffect(() => {
    if (!expanded) return;
    // A portal can lose focus to body after a toolbar/selection interaction.
    // Own Escape only while expanded; IME and other dialogs keep their keys.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing()) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && target !== document.body && !wrapper.current?.contains(target)) return;
      event.preventDefault(); event.stopPropagation(); actions.current.finish();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [expanded]);
  const makeState = (doc: string) => EditorState.create({ doc, extensions: [history(), markdown(), EditorView.lineWrapping,
      placeholder(latest.current.placeholder || ''), liveMarkdownPreview({ assets: [], notes: [], tags: [], noteLinks: [], noteEmbeds: [] }),
      keymap.of([{ key: 'Escape', run: () => { if (composing()) return false; actions.current.finish(); return true; } },
        { key: 'Mod-Enter', run: () => { actions.current.finish(); return true; } },
        { key: 'Mod-b', run: () => { actions.current.apply('bold'); return true; } },
        { key: 'Mod-i', run: () => { actions.current.apply('italic'); return true; } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (update.selectionSet || update.docChanged) {
          const heading = [...outlineRef.current].reverse().find(item => item.from <= update.state.selection.main.head);
          setActiveHeading(heading?.from ?? null);
        }
        if (update.docChanged) { latest.current.onChange(update.state.doc.toString()); setRevision(n => n + 1); } }),
      EditorView.contentAttributes.of({ 'aria-label': english ? 'Canvas text' : '画布文本', spellcheck: 'false' }),
    ] });
  useLayoutEffect(() => {
    if (!active || !host.current) return;
    const old = savedState.current;
    // A change outside this editor is a new authoritative history baseline.
    const state = old?.doc.toString() === latest.current.value ? old : makeState(latest.current.value);
    const editor = new EditorView({ state, parent: host.current }); view.current = editor; editor.focus();
    // Preserve native IME keys before CodeMirror shortcuts and canvas handlers.
    // Do not preventDefault: Escape still belongs to the composition window.
    const composingKey = (event: KeyboardEvent) => { if (event.isComposing || event.keyCode === 229) event.stopImmediatePropagation(); };
    editor.contentDOM.addEventListener('keydown', composingKey, true);
    return () => { editor.contentDOM.removeEventListener('keydown', composingKey, true); savedState.current = editor.state; editor.destroy(); if (view.current === editor) view.current = null; };
  }, [active, expanded, props.nodeId]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && !composing() && editor.state.doc.toString() !== props.value) {
      const selection = editor.state.selection.main;
      const state = makeState(props.value);
      editor.setState(state.update({ selection: { anchor: Math.min(selection.anchor, props.value.length), head: Math.min(selection.head, props.value.length) } }).state);
      savedState.current = null;
    }
  }, [props.value]);
  const openExpanded = () => { if (composing()) return; focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setExpanded(true); props.onStartEditing(); };
  // Let native IME finish when focus moves to the toolbar; EditorState retains the selection.
  const button = (name: string, text: string, action: () => void, className = '') => <button type="button" className={className} title={name} aria-label={name} onClick={event => { event.stopPropagation(); action(); }}>{text}</button>;
  const toolbar = <div className="canvas-text-toolbar" role="toolbar" aria-label={label('文本编辑工具', 'Text formatting')}>
    {button(label('撤销', 'Undo'), '↶', () => { if (view.current && !composing()) { undo(view.current); view.current.focus(); } })}
    {button(label('重做', 'Redo'), '↷', () => { if (view.current && !composing()) { redo(view.current); view.current.focus(); } })}
    <span className="canvas-text-tool-divider" />
    {formats.map(([format, icon, zh, en]) => <button key={format} type="button" className={`format-${format}`} title={english ? en : zh} aria-label={english ? en : zh} onClick={() => apply(format)}>{icon}</button>)}
    <span className="canvas-text-tool-spacer" />
    {expanded ? <>
      {button(label('缩小', 'Zoom out'), '−', () => setZoom(value => Math.max(75, value - 10)))}<span className="canvas-text-zoom">{zoom}%</span>{button(label('放大', 'Zoom in'), '+', () => setZoom(value => Math.min(150, value + 10)))}
      {button(label('关闭聚焦编辑', 'Close focused editor'), '×', closeExpanded)}
    </> : button(label('聚焦编辑', 'Focus editor'), '⤢', openExpanded)}
  </div>;
  const body = <div ref={wrapper} tabIndex={-1} className={`canvas-text-document${active ? ' nodrag nopan nowheel' : ''}${expanded ? ' is-expanded' : ''}${active ? ' is-editing' : ''}`} data-node-id={props.nodeId} data-revision={revision}
    onPointerDown={event => { if (active) event.stopPropagation(); }} onDoubleClick={event => { event.stopPropagation(); props.onStartEditing(); }}
    onKeyDown={event => {
      if (active) event.stopPropagation();
      if (!event.defaultPrevented && event.key === 'Escape' && !(event.nativeEvent as KeyboardEvent).isComposing && !composing()) { event.preventDefault(); finish(); }
      if (expanded && event.key === 'Tab') {
        const items = [...(wrapper.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[contenteditable="true"],select') || [])];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} onBlur={event => {
      if (!expanded && active && !event.currentTarget.contains(event.relatedTarget as Node | null) && !floatingToolbar.current?.contains(event.relatedTarget as Node | null)) {
        // Let the browser finish selection/default focus before removing an editor.
        requestAnimationFrame(() => { if (!expandedRef.current && wrapper.current && !wrapper.current.contains(document.activeElement) && !floatingToolbar.current?.contains(document.activeElement) && !composing()) latest.current.onFinishEditing(); });
      }
    }}>
    {expanded ? toolbar : (active || props.selected) ? <FloatingTextToolbar nodeId={props.nodeId} toolbarRef={floatingToolbar}>{active ? toolbar : <div className="canvas-text-idle-actions nodrag nopan">{button(label('编辑文本', 'Edit text'), '✎', props.onStartEditing)}{button(label('聚焦编辑', 'Focus editor'), '⤢', openExpanded)}</div>}</FloatingTextToolbar> : null}
    <div className="canvas-text-workspace">
      {expanded && <aside className="canvas-text-outline" aria-label={label('文档大纲', 'Document outline')}>
        <div className="canvas-text-outline-title">{label('文档大纲', 'Outline')}</div>
        {outline.length ? outline.map((heading, index) => <button type="button" key={`${heading.from}-${index}`} aria-current={activeHeading === heading.from ? 'location' : undefined} style={{ paddingInlineStart: 12 + Math.min(heading.level - 1, 3) * 12 }} onClick={() => { const editor = view.current; if (editor) { editor.dispatch({ selection: { anchor: heading.from }, effects: EditorView.scrollIntoView(heading.from, { y: 'start', yMargin: 24 }) }); editor.focus(); } }}>{heading.text}</button>) : <p>{label('添加标题后，章节会显示在这里。', 'Add headings to navigate chapters here.')}</p>}
        <div className="canvas-text-template">
          {button(label('添加剧本结构', 'Add script structure'), label('＋ 剧本结构', '+ Script structure'), () => setTemplateMenu(value => !value))}
          {templateMenu && <div className="canvas-text-template-confirm"><p>{label('在末尾追加故事大纲、人物小传和场景设计，不替换现有文字。', 'Append story outline, characters and scene design. Existing text stays unchanged.')}</p>{button(label('追加到文末', 'Append to document'), label('追加到文末', 'Append to document'), () => {
            const editor = view.current; if (!editor || composing()) return;
            const at = editor.state.doc.length, insert = (at ? '\n\n' : '') + canvasScriptTemplate(english);
            editor.dispatch({ changes: { from: at, insert }, selection: { anchor: at + (at ? 2 : 0) }, userEvent: 'input.template', scrollIntoView: true }); setTemplateMenu(false); editor.focus();
          })}</div>}
        </div>
      </aside>}
      <div className="canvas-text-writing" style={expanded ? { fontSize: `${14 * zoom / 100}px` } : undefined}>
        {active ? <div ref={host} className="canvas-text-editor" /> : <CanvasTextPreview value={props.value} placeholder={props.placeholder} />}
      </div>
    </div>
    {expanded && <footer className="canvas-text-footer"><span>{label('Markdown · 修改同步到当前节点', 'Markdown · Changes sync to this node')}</span><span>Esc {label('返回画布', 'Back to canvas')}</span></footer>}
  </div>;
  return expanded ? <><div className="canvas-text-focus-placeholder"><CanvasTextPreview value={props.value} placeholder={props.placeholder} /></div>{createPortal(<div className="canvas-text-focus-backdrop" role="dialog" aria-modal="true" aria-label={label('文本聚焦编辑', 'Focused text editor')}>{body}</div>, document.body)}</> : body;
}
