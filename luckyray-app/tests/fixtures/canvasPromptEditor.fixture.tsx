import { createRoot } from "react-dom/client";
import { createRef } from "react";
import {
  CanvasPromptEditor,
  type CanvasPromptEditorHandle,
} from "../../src/features/canvas/CanvasPromptEditor";
import type { ReferenceEntry } from "../../src/core/canvas/referencePlan";
export function mountPromptEditorFixture(target: HTMLElement) {
  const root = createRoot(target);
  const handle = createRef<CanvasPromptEditorHandle>();
  let value = "before after";
  let entries: ReferenceEntry[] = ["a", "b"].map((key) => ({
    key,
    source: "connected",
    role: "reference",
    reference: {
      id: key,
      kind: "image",
      label: key === "a" ? "Ocean study.png" : "山间日出",
      thumbnailUrl:
        key === "a" ? "https://fixture.invalid/ocean.png" : undefined,
    },
  }));
  const render = () =>
    root.render(
      <CanvasPromptEditor
        ref={handle}
        value={value}
        onChange={(next) => {
          value = next;
          render();
        }}
        entries={entries}
        placeholder="Write here"
      />,
    );
  render();
  return {
    root,
    handle,
    value: () => value,
    entries: () => entries,
    setEntries: (next: ReferenceEntry[]) => {
      entries = next;
      render();
    },
    set: (next: string) => {
      value = next;
      render();
    },
    rename: (label: string) => {
      entries = entries.map((entry) =>
        entry.key === "a"
          ? { ...entry, reference: { ...entry.reference, label } }
          : entry,
      );
      render();
    },
    reorder: () => {
      entries = [...entries].reverse();
      render();
    },
    remove: () => {
      entries = entries.filter((entry) => entry.key !== "a");
      render();
    },
  };
}
