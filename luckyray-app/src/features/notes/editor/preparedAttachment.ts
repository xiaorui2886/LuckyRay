import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { LiveAsset, LiveNoteEmbed } from "./types";
import type { AttachmentResolution } from "../../../core/services/vaultAttachments";

/** A publication receipt's presentation belongs to its inserted text, not a
 * global filename cache. Positions and history follow the document transaction. */
export type PreparedAttachment = { markdown: string; asset: LiveAsset; embed: LiveNoteEmbed; resolution?: AttachmentResolution; target?: string; wiki?: boolean };
type BoundAttachment = PreparedAttachment & { from: number; to: number };
export const preparedAttachmentEffect = StateEffect.define<readonly BoundAttachment[]>({
  map: (items, changes) => items.map(item => ({ ...item, from: changes.mapPos(item.from, 1), to: changes.mapPos(item.to, -1) })),
});
export const addPreparedAttachment = StateEffect.define<BoundAttachment>({
  map: (item, changes) => ({ ...item, from: changes.mapPos(item.from, 1), to: changes.mapPos(item.to, -1) }),
});
export const preparedAttachments = StateField.define<readonly BoundAttachment[]>({
  create: () => [],
  update(previous, tr) {
    let next = previous;
    if (tr.docChanged && previous.length) next = previous.flatMap(item => {
      const from = tr.changes.mapPos(item.from, 1), to = tr.changes.mapPos(item.to, -1);
      return to >= from && tr.newDoc.sliceString(from, to) === item.markdown ? [{ ...item, from, to }] : [];
    });
    for (const effect of tr.effects) {
      if (effect.is(preparedAttachmentEffect)) next = effect.value.filter(item => item.to >= item.from && tr.newDoc.sliceString(item.from, item.to) === item.markdown);
      if (effect.is(addPreparedAttachment)) next = [...next, effect.value];
    }
    return next;
  },
});
export const preparedAttachmentHistory = invertedEffects.of(tr =>
  (tr.docChanged || tr.effects.some(effect => effect.is(preparedAttachmentEffect)))
    && tr.startState.field(preparedAttachments).length + tr.state.field(preparedAttachments).length > 0
    ? [preparedAttachmentEffect.of(tr.startState.field(preparedAttachments))] : []);

export function prepareAttachmentInsertion(prepared: PreparedAttachment, from: number, text: string) {
  const offset = text.indexOf(prepared.markdown);
  if (offset < 0) throw new Error("Published attachment does not match insertion");
  // Existing positions are mapped by the StateField. The effect adds this
  // receipt after those changes, without rebuilding or replacing the editor.
  return { ...prepared, from: from + offset, to: from + offset + prepared.markdown.length };
}

export function prepareAttachmentInsertions(prepared: readonly PreparedAttachment[], from: number, text: string) {
  let searchFrom = 0;
  return prepared.map((item) => {
    const offset = text.indexOf(item.markdown, searchFrom);
    if (offset < 0) throw new Error("Published attachment does not match insertion order");
    searchFrom = offset + item.markdown.length;
    return { ...item, from: from + offset, to: from + searchFrom };
  });
}

export function withPreparedAttachments<T extends { assets: LiveAsset[]; noteEmbeds: LiveNoteEmbed[] }>(state: EditorState, options: T): T {
  const bindings = state.field(preparedAttachments, false);
  if (!bindings?.length) return options;
  const assets = new Map(options.assets.map(asset => [asset.id, asset]));
  const embeds = new Map(options.noteEmbeds.map(embed => [embed.targetName, embed]));
  for (const binding of bindings) {
    const authoritative = embeds.get(binding.embed.targetName);
    // Once the index/resolver has a real result (including missing/denied), it
    // takes precedence. A delayed/pending index never erases a valid receipt.
    if (authoritative && authoritative.resolutionStatus !== "pending") continue;
    assets.set(binding.asset.id, binding.asset);
    embeds.set(binding.embed.targetName, binding.embed);
  }
  return { ...options, assets: [...assets.values()], noteEmbeds: [...embeds.values()] };
}
