import { readActiveContext } from "../activeContext";
import { focusEntity } from "./context";
import {
  appendKnowledgeDocument,
  createKnowledgeDocument,
  insertIntoCurrentKnowledgeDocument,
  knowledgeDocumentNoteId,
  listKnowledgeDocuments,
  readKnowledgeDocument,
  replaceKnowledgeDocument,
  type KnowledgeDocumentRef,
} from "./knowledge";

export type NoteRecord = {
  id: string;
  title: string;
  contentText?: string;
  updatedAt?: string;
  folderId?: string | null;
  documentRef: KnowledgeDocumentRef;
  revision?: string;
};

export type NoteCreateInput = {
  title?: string;
  folderId?: string | null;
  contentJson?: string;
  contentText?: string;
  color?: string | null;
};

export type CurrentNoteInsertInput = {
  text?: string;
  assetName?: string;
  appendIfNoCursor?: boolean;
};

function noteRecordFromDocument(document: Awaited<ReturnType<typeof readKnowledgeDocument>>): NoteRecord {
  return {
    id: knowledgeDocumentNoteId(document.documentRef),
    title: document.title,
    contentText: document.content,
    updatedAt: document.modifiedAt || undefined,
    folderId: null,
    documentRef: document.documentRef,
    revision: document.revision,
  };
}

export function notifyNoteExternalUpdated(noteId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("luckyray:note-external-updated", { detail: { noteId } }));
}

export function focusNote(noteId: string) {
  if (typeof window === "undefined") return;
  focusEntity("note", noteId);
  window.location.hash = "#notes";
}

export async function listNotes(): Promise<NoteRecord[]> {
  const summaries = await listKnowledgeDocuments({ limit: 200 });
  return summaries.map((summary) => ({
    id: knowledgeDocumentNoteId(summary.documentRef),
    title: summary.title,
    updatedAt: summary.modifiedAt || undefined,
    folderId: null,
    documentRef: summary.documentRef,
  }));
}

export async function getNote(noteId: string): Promise<NoteRecord | null> {
  const summary = (await listKnowledgeDocuments({ limit: 200 }))
    .find((candidate) => knowledgeDocumentNoteId(candidate.documentRef) === noteId);
  if (!summary) return null;
  return noteRecordFromDocument(await readKnowledgeDocument(summary.documentRef));
}

export async function createNote(input: NoteCreateInput = {}): Promise<NoteRecord> {
  const document = await createKnowledgeDocument({
    title: input.title || "未命名笔记",
    content: input.contentText || "",
  });
  return noteRecordFromDocument(document);
}

export async function createNoteAndFocus(input: NoteCreateInput = {}): Promise<NoteRecord> {
  const note = await createNote(input);
  focusNote(note.id);
  return note;
}

export async function updateNoteContent(noteId: string, contentText: string): Promise<NoteRecord | null> {
  const note = await getNote(noteId);
  if (!note) return null;
  const result = await replaceKnowledgeDocument(note.documentRef, contentText, note.revision);
  notifyNoteExternalUpdated(noteId);
  return noteRecordFromDocument(result.document);
}

export async function appendToNote(noteId: string, content: string): Promise<NoteRecord> {
  const note = await getNote(noteId);
  if (!note) throw new Error("目标笔记不存在");
  const result = await appendKnowledgeDocument(note.documentRef, content, note.revision);
  notifyNoteExternalUpdated(noteId);
  return noteRecordFromDocument(result.document);
}

export async function readCurrentNoteId(): Promise<string | null> {
  return readActiveContext().note?.documentRef
    ? knowledgeDocumentNoteId(readActiveContext().note!.documentRef!)
    : null;
}

export async function insertIntoCurrentNote(
  input: CurrentNoteInsertInput,
): Promise<{ noteId: string; position?: string }> {
  const text = input.text || (input.assetName ? `![[${input.assetName}]]` : "");
  const result = await insertIntoCurrentKnowledgeDocument({
    text,
    appendIfNoCursor: input.appendIfNoCursor ?? true,
  });
  const noteId = knowledgeDocumentNoteId(result.document.documentRef);
  notifyNoteExternalUpdated(noteId);
  return { noteId, position: result.position };
}
