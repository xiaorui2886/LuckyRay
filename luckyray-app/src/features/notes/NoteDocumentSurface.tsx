import type {ComponentProps,HTMLAttributes,TextareaHTMLAttributes,RefObject,ReactNode} from 'react';
import {useI18n} from '../../core/i18n';
import {InlineFilename} from './editor/noteFilename';
import {FavoriteGlyph} from '../../components/FavoriteGlyph';
import {LiveMarkdownEditor,type LiveMarkdownEditorHandle} from './editor/LiveMarkdownEditor';
import {NotePreview} from './NotePreview';

export type NoteSurfaceActions = {
 changeTitle(value:string):void; askAi():void; toggleFavorite():void; toggleAttachments():void;
 createDocument():void; browseDocuments():void; closeTab():void; removeTag(id:string):void; editTags():void;
 suggestAi():void; toggleAiTag(tag:string):void; applyAiTags():void; toggleIndex():void;
 reloadConflict():void; keepConflict():void; retrySave():void; togglePreview():void; toggleSource():void;
};
export type NoteDocumentSurfaceProps = {
 viewId:string; paneId:string; selectedNote:{id:string}|null; selectedNoteId:string|null; editTitle:string;
 editorMode:'live'|'source'|'preview'; selectedNoteFavorite:unknown; favoriteAvailable:boolean; filenameTitle:boolean;
 attachmentProblem:unknown; attachmentSidebarOpen:boolean; activeNoteTags:string[]; tagDialogOpen:boolean;
 aiPanelOpen:boolean; aiBusy:boolean; aiSuggestion?:{summary?:string;auto_tags?:string[];error?:string}|null;
 aiSuggestionTags:string[]; selectedAiTags:string[]; panelOpen:boolean; wordCount:number; lineCount:number;
 activeRealVaultExternalConflict:unknown; status:string; mobileEditingNoteId:string|null; locale:string;
 viewRefs:{live:RefObject<LiveMarkdownEditorHandle|null>;source:RefObject<HTMLTextAreaElement|null>;content:RefObject<HTMLDivElement|null>};
 areaEvents:HTMLAttributes<HTMLDivElement>; contentEvents:HTMLAttributes<HTMLDivElement>;
 sourceEditor:TextareaHTMLAttributes<HTMLTextAreaElement>;
 liveEditor:ComponentProps<typeof LiveMarkdownEditor>; preview:ComponentProps<typeof NotePreview>;
 localHeader?:ReactNode; tagName:(id:string)=>string; actions:NoteSurfaceActions;
};
/** The production document surface shared by Main and exact-document runtimes.
 * All authority arrives through typed handlers; this module cannot discover a vault or bridge.
 * The caller retains this component under its stable view id, never document/pane focus.
 */
export function NoteDocumentSurface(props:NoteDocumentSurfaceProps){
 const {t}=useI18n();
 const {viewId,paneId,selectedNote,editTitle,editorMode,selectedNoteFavorite,favoriteAvailable,filenameTitle,attachmentProblem,attachmentSidebarOpen,activeNoteTags,tagDialogOpen,aiPanelOpen,aiBusy,aiSuggestion,aiSuggestionTags,selectedAiTags,panelOpen,wordCount,lineCount,activeRealVaultExternalConflict,status,mobileEditingNoteId,selectedNoteId,locale,viewRefs,areaEvents,contentEvents,sourceEditor,liveEditor,preview,localHeader,tagName,actions}=props;
  return (
<div className="note-editor-area" data-notes-dock-pane={paneId} {...areaEvents}>
              {localHeader}
              {selectedNote && (
                <div className="note-title-strip">
                  {filenameTitle ? <InlineFilename id={selectedNote.id} title={editTitle} className="note-title-filename" /> : <input
                    className="note-title-input"
                    value={editTitle}
                    title={editTitle}
                    onChange={(event) => actions.changeTitle(event.target.value)}
                    placeholder={t("editor.notes.untitledNote")}
                  />}
                  <button type="button" className="note-ai-ask" onClick={() => actions.askAi()} title={t("editor.notes.sendLightSeek")} aria-label={t("editor.notes.sendLightSeek")}>
                    <svg viewBox="0 0 16 16"><path d="M2 3h12v8H7l-3 3v-3H2z" /></svg>
                  </button>
                  <button
                    type="button"
                    className={`note-favorite-action${selectedNoteFavorite ? " active" : ""}`}
                    onClick={() => actions.toggleFavorite()}
                    title={selectedNoteFavorite ? t("editor.notes.favorite.remove") : t("editor.notes.favorite.add")}
                    aria-label={selectedNoteFavorite ? t("editor.notes.favorite.removeCurrent") : t("editor.notes.favorite.addCurrent")}
                    aria-pressed={Boolean(selectedNoteFavorite)}
                    disabled={!favoriteAvailable}
                  >
                    <FavoriteGlyph filled={Boolean(selectedNoteFavorite)} />
                  </button>
                  <button type="button" className="note-attachments-action" title={attachmentProblem ? "笔记附件：有附件需要检查" : "笔记附件"} aria-label={attachmentProblem ? "打开笔记附件侧栏，有附件需要检查" : "打开笔记附件侧栏"} aria-pressed={attachmentSidebarOpen} onMouseDown={event => event.preventDefault()} onClick={actions.toggleAttachments}><svg viewBox="0 0 24 24"><path d="m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3" /></svg>{Boolean(attachmentProblem) && <span className="note-attachment-error-dot" aria-hidden="true" />}</button>
                </div>
              )}
              <div className="note-content-area" ref={viewRefs.content} {...contentEvents}>
                {!selectedNote ? (
                  <div className="note-empty-tab-page">
                    <div className="note-empty-tab-actions" role="group" aria-label={t("editor.notes.empty.actions")}>
                      <button type="button" onClick={() => actions.createDocument()}>
                        <span>{t("editor.notes.empty.create")}</span>
                        <kbd>Ctrl + N</kbd>
                      </button>
                      <button type="button" onClick={() => actions.browseDocuments()}>
                        <span>{t("editor.notes.empty.open")}</span>
                      </button>
                      <button type="button" onClick={() => actions.closeTab()}>
                        <span>{t("editor.notes.empty.close")}</span>
                      </button>
                    </div>
                  </div>
                ) : editorMode === "preview" ? (
                  <NotePreview {...preview} />
                ) : editorMode === "source" ? (
                  <textarea ref={viewRefs.source} {...sourceEditor} />
                ) : (
                  <LiveMarkdownEditor key={viewId} ref={viewRefs.live} {...liveEditor} />
                )}
              </div>
              {selectedNote && (
                <div className="note-tags-bar">
                  {activeNoteTags.map((tagId) => (
                    <span className="note-tag" key={tagId}>
                      {tagName(tagId)}
                      <button className="tag-remove" onClick={() => actions.removeTag(tagId)} title={t("editor.notes.tag.remove")}>×</button>
                    </span>
                  ))}
                  <button className={`note-tag-add${tagDialogOpen ? " active" : ""}`} onClick={() => actions.editTags()}>
                    <svg viewBox="0 0 10 10"><line x1="5" y1="2" x2="5" y2="8" /><line x1="2" y1="5" x2="8" y2="5" /></svg>
                    {t("editor.notes.tag.add")}
                  </button>
                  <button className={`ai-suggest-btn${aiPanelOpen ? " active" : ""}`} disabled={aiBusy} onClick={() => actions.suggestAi()}>{t("editor.notes.ai.suggest")}</button>
                </div>
              )}
              {aiPanelOpen && (
                <div className="ai-note-suggest-panel">
                  {aiBusy ? (
                    <span>{t("editor.notes.ai.loadingSuggestions")}</span>
                  ) : aiSuggestion?.error ? (
                    <span>{aiSuggestion.error}</span>
                  ) : aiSuggestion ? (
                    <>
                      {aiSuggestion.summary && <div className="ai-note-summary">{aiSuggestion.summary}</div>}
                      {!!aiSuggestion.auto_tags?.length && (
                        <div className="ai-note-tags" role="group" aria-label={t("editor.notes.ai.candidates")}>
                          {aiSuggestionTags.map((tag) => {
                            const selected = selectedAiTags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase());
                            return (
                              <button
                                key={tag}
                                type="button"
                                className={`ai-note-tag-chip${selected ? " selected" : ""}`}
                                aria-pressed={selected}
                                onClick={() => actions.toggleAiTag(tag)}
                              >
                                <span className="ai-note-tag-check">{selected ? "✓" : ""}</span>
                                <span>{tag}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <button className="ai-note-apply-btn" onClick={() => actions.applyAiTags()} disabled={!aiSuggestionTags.length}>{t("editor.notes.ai.applyTags")}</button>
                    </>
                  ) : (
                    <span>{t("editor.notes.ai.suggestionHint")}</span>
                  )}
                </div>
              )}
              <div className="editor-status">
                <div className="editor-status-panel">
                  <button
                    className={`editor-status-btn notes-index-status-toggle${panelOpen ? " active" : ""}`}
                    onClick={actions.toggleIndex}
                    title={panelOpen ? t("editor.notes.status.panelClose") : t("editor.notes.status.panelOpen")}
                    aria-label={t("editor.notes.status.panel")}
                  >
                    <svg viewBox="0 0 16 16"><path d="M3 3.5h10v9H3z" /><path d="M7 3.5v9" /></svg>
                    {t("editor.notes.status.panel")}
                  </button>
                </div>
                <div className="editor-status-left">
                  <span>{t("editor.notes.status.characters", { count: wordCount })}</span>
                  <span>{t("editor.notes.status.lines", { count: lineCount })}</span>
                </div>
                <div className="editor-status-center">
                  {activeRealVaultExternalConflict ? (
                    <span className="editor-status-conflict">
                      <span>{t("editor.notes.status.externalConflict")}</span>
                      <button type="button" onClick={actions.reloadConflict}>{t("editor.notes.status.reloadDisk")}</button>
                      <button type="button" onClick={actions.keepConflict}>{t("editor.notes.status.keepEdit")}</button>
                    </span>
                  ) : <>{status}{status === t("editor.notes.status.saveFailed") && <button type="button" onClick={actions.retrySave}>重试保存</button>}</>}
                </div>
                <div className="editor-status-right">
                  <span>{mobileEditingNoteId === selectedNoteId && mobileEditingNoteId
                    ? (locale === "zh-CN" ? "手机正在编辑" : "Editing on phone")
                    : selectedNote ? t("editor.notes.status.justEdited") : ""}</span>
                  <button
                    className="editor-status-btn"
                    onClick={() => actions.togglePreview()}
                    title={editorMode === "preview" ? t("editor.notes.status.switchLive") : t("editor.notes.status.switchPreview")}
                  >
                    {editorMode === "preview" ? (
                      <svg viewBox="0 0 16 16"><path d="M3 12.5l1.2-3.2 6.9-6.9 2.5 2.5-6.9 6.9L3 12.5z" /><path d="M10.2 3.3l2.5 2.5" /></svg>
                    ) : (
                      <svg viewBox="0 0 16 16"><path d="M1.5 8s2.6-4.5 6.5-4.5S14.5 8 14.5 8 11.9 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
                    )}
                    {editorMode === "preview" ? t("editor.notes.status.edit") : t("editor.notes.status.preview")}
                  </button>
                  <button
                    className={`editor-status-btn${editorMode === "source" ? " active" : ""}`}
                    onClick={() => actions.toggleSource()}
                    title={editorMode === "source" ? t("editor.notes.status.backLive") : t("editor.notes.status.switchSource")}
                  >
                    <svg viewBox="0 0 16 16"><path d="M5.5 4L2 8l3.5 4" /><path d="M10.5 4L14 8l-3.5 4" /><path d="M9 2.5L7 13.5" /></svg>
                    {t("editor.notes.status.source")}
                  </button>
                </div>
              </div>
            </div>
    );
}
