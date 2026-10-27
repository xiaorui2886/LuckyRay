/** Advance only an acknowledged write. Observations are never allowed to rebase a draft. */
export function acknowledgeNoteSave(
  baselines: Map<string, string>,
  noteId: string,
  expectedContent: string,
  saved: { contentText?: string; revision?: string },
  isCurrent: () => boolean,
  publish: () => void,
) {
  if (saved.contentText !== expectedContent || !saved.revision) {
    throw new Error("Saved document did not acknowledge the exact content");
  }
  if (!isCurrent()) throw new Error("Saved note source session changed");
  // Publish the baseline synchronously, before observers can interpret this write.
  baselines.set(noteId, saved.contentText);
  publish();
}

export function shouldPauseConflictAutosave(
  reason: string, noteId: string, conflictNoteId: string | undefined, keptDrafts: ReadonlySet<string>,
) {
  return reason === "user-edit-autosave" && (conflictNoteId === noteId || keptDrafts.has(noteId));
}
