// Issue-116 D — the right (attachments) sidebar gets the left panel's resize
// contract: an inner drag edge, collapse-past-threshold, restore-last-width,
// a short open/close transition that never runs during the drag, and
// prefers-reduced-motion support.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the resize handle is a real, labelled hit target on the sidebar's inner edge", async () => {
  const page = await read("src/features/notes/NotesPage.tsx");
  assert.match(page, /className="lr-attachment-resize-handle"/);
  assert.match(page, /role="separator"/);
  assert.match(page, /aria-orientation="vertical"/);
  assert.match(page, /aria-label="调整附件栏宽度"/);
  assert.match(page, /onPointerDown=\{startAttachmentSidebarResize\}/);
  // The frame carries the width so the handle never overlaps editor events.
  assert.match(page, /className="lr-attachment-sidebar-frame" style=\{\{ width: attachmentSidebarWidth \}\}/);
});

test("dragging resizes, dragging far enough collapses, reopening restores", async () => {
  const page = await read("src/features/notes/NotesPage.tsx");
  // Threshold collapse inside the drag loop.
  assert.match(page, /rawWidth < ATTACHMENT_SIDEBAR_COLLAPSE_THRESHOLD/);
  assert.match(page, /setAttachmentSidebarOpen\(false\);/);
  // Width clamps both ways and remembers the last expanded value.
  assert.match(page, /lastExpandedAttachmentWidthRef\.current = nextWidth;/);
  assert.match(page, /Math\.max\(lastExpandedAttachmentWidthRef\.current, ATTACHMENT_SIDEBAR_DEFAULT_WIDTH\)/);
  // Pointer capture/cancel/finish are all handled like the left panel.
  assert.match(page, /window\.addEventListener\("pointermove", onPointerMove/);
  assert.match(page, /window\.addEventListener\("pointerup", finishResize/);
  assert.match(page, /window\.addEventListener\("pointercancel", finishResize/);
  // The close button still works; the toggle routes through the animated path.
  assert.match(page, /onClose=\{\(\) => setAttachmentSidebarOpen\(false\)\}/);
  // The production toolbar now lives in the shared full document surface.
  // Prove both ends of the forwarding route instead of pinning its old JSX site.
  assert.match(page, /toggleAttachments:\s*toggleAttachmentSidebar/);
  const surface = await read("src/features/notes/NoteDocumentSurface.tsx");
  const ast = ts.createSourceFile("NoteDocumentSurface.tsx", surface, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let forwarded = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "button") {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const named = attrs.find(attr => attr.name.getText(ast) === "className")?.initializer;
      const click = attrs.find(attr => attr.name.getText(ast) === "onClick")?.initializer;
      if (named && ts.isStringLiteral(named) && named.text === "note-attachments-action") {
        forwarded = Boolean(click && ts.isJsxExpression(click) && click.expression?.getText(ast) === "actions.toggleAttachments");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(forwarded, true, "the actual attachment button must call the forwarded animated toggle");
});

test("the transition is short, only on open/close, disabled while dragging and for reduced motion", async () => {
  const [page, css] = await Promise.all([
    read("src/features/notes/NotesPage.tsx"),
    read("src/features/notes/noteAttachmentSidebar.css"),
  ]);
  assert.match(page, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(page, /setAttachmentSidebarAnimating\(true\)/);
  assert.match(page, /window\.setTimeout\(\(\) => setAttachmentSidebarAnimating\(false\), 200\)/);
  assert.match(css, /\.editor-row\[data-attachments-animating="true"\] \.lr-attachment-sidebar-frame\s*\{[^}]*transition: width 180ms/);
  assert.match(css, /body\.lr-attachment-resizing[\s\S]{0,300}?transition: none !important/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the stored width is a real preference and bounded to the viewport", async () => {
  const page = await read("src/features/notes/NotesPage.tsx");
  assert.match(page, /ATTACHMENT_SIDEBAR_WIDTH_KEY = "luckyray-notes-attachment-width-v1"/);
  assert.match(page, /ATTACHMENT_SIDEBAR_MIN_WIDTH = 260/);
  assert.match(page, /ATTACHMENT_SIDEBAR_MAX_WIDTH = 560/);
  assert.match(page, /Math\.min\(ATTACHMENT_SIDEBAR_MAX_WIDTH, Math\.floor\(window\.innerWidth \* 0\.42\)\)/);
  // Only persisted while the panel is actually open.
  assert.match(page, /if \(!attachmentSidebarOpen\) return; \/\/ the stored width is a real preference/);
});

test("toggling the panel does not touch the attachment pipeline", async () => {
  const page = await read("src/features/notes/NotesPage.tsx");
  const toggle = page.slice(
    page.indexOf("const toggleAttachmentSidebar = useCallback"),
    page.indexOf("}, []);", page.indexOf("const toggleAttachmentSidebar = useCallback")),
  );
  assert.doesNotMatch(toggle, /recheckAttachments|externalAttachmentFlow|setAssetsForNote/);
});
