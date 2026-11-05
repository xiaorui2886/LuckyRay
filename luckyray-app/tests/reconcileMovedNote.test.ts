import assert from "node:assert/strict";
import { posix } from "node:path";
import test from "node:test";
import {
  isNonRelativeTarget,
  rebaseRelativeTarget,
  extractMarkdownLinkRewrites,
  reconcileMovedNoteContent,
  rebaseMarkdownContent,
  toPosixDir,
} from "../src/features/notes/reconcileMovedNote.ts";

test("toPosixDir extracts directory correctly", () => {
  assert.equal(toPosixDir("file.md"), "");
  assert.equal(toPosixDir("sub/file.md"), "sub");
  assert.equal(toPosixDir("a/b/c/file.md"), "a/b/c");
  assert.equal(toPosixDir("a\\b\\file.md"), "a/b");
});

test("isNonRelativeTarget identifies remote, anchor and absolute targets", () => {
  assert.equal(isNonRelativeTarget("https://example.com/pic.png"), true);
  assert.equal(isNonRelativeTarget("http://example.com/pic.png"), true);
  assert.equal(isNonRelativeTarget("data:image/png;base64,..."), true);
  assert.equal(isNonRelativeTarget("real-vault:Note.md"), true);
  assert.equal(isNonRelativeTarget("#heading"), true);
  assert.equal(isNonRelativeTarget("/absolute/path.png"), true);
  assert.equal(isNonRelativeTarget("C:\\path\\file.png"), true);
  assert.equal(isNonRelativeTarget("attachments/pic.png"), false);
  assert.equal(isNonRelativeTarget("../attachments/pic.png"), false);
  assert.equal(isNonRelativeTarget("./sub/pic.png"), false);
});

test("rebaseRelativeTarget adjusts relative paths between folders", () => {
  // Move root -> Moved
  assert.equal(rebaseRelativeTarget("", "Moved", "attachments/note-flow.png"), "../attachments/note-flow.png");
  // Move Moved -> root
  assert.equal(rebaseRelativeTarget("Moved", "", "../attachments/note-flow.png"), "attachments/note-flow.png");
  // Move sub1 -> sub2
  assert.equal(rebaseRelativeTarget("sub1", "sub2", "../attachments/note-flow.png"), "../attachments/note-flow.png");
  // Move sub1/nested -> sub2
  assert.equal(rebaseRelativeTarget("sub1/nested", "sub2", "../../attachments/pic.png"), "../attachments/pic.png");
  // Targets with hash
  assert.equal(rebaseRelativeTarget("", "Moved", "attachments/note-flow.png#section"), "../attachments/note-flow.png#section");
  // Targets with query
  assert.equal(rebaseRelativeTarget("", "Moved", "attachments/note-flow.png?v=1"), "../attachments/note-flow.png?v=1");
  // Same dir
  assert.equal(rebaseRelativeTarget("sub", "sub", "attachments/pic.png"), "attachments/pic.png");
});

test("new draft links outside the vault keep pointing to the same external path after a move", () => {
  const cases = [
    { oldDir: "", newDir: "Moved", target: "../outside.png", expected: "../../outside.png" },
    { oldDir: "", newDir: "Moved/Nested", target: "../../outside.png", expected: "../../../../outside.png" },
    { oldDir: "Deep/Nested", newDir: "Moved", target: "../../../outside.png", expected: "../../outside.png" },
    { oldDir: "Deep/Nested", newDir: "", target: "../../../outside.png", expected: "../outside.png" },
  ];
  for (const { oldDir, newDir, target, expected } of cases) {
    const result = rebaseRelativeTarget(oldDir, newDir, target, "macos");
    assert.equal(result, expected);
    assert.equal(posix.resolve("/vault", newDir, result), posix.resolve("/vault", oldDir, target));
  }
  const draft = "# Draft\n![new external](../outside.png)\n";
  assert.equal(reconcileMovedNoteContent("Note.md", "Moved/Note.md", "# Draft\n", "# Draft\n", draft, "macos"),
    "# Draft\n![new external](../../outside.png)\n");
});

test("draft rebasing preserves frontmatter and HTML while updating real links", () => {
  for (const marker of ["---", "+++"]) {
    const source = `\ufeff${marker}\r\nwiki: [[./property.png]]\r\nlink: [property](./property.png)\r\n${marker}\r\n\r\n<!-- [[./comment.png]] -->\r\n\r\n[[./visible.png]] ![visible](./visible.png)\r\n`;
    const result = rebaseMarkdownContent("Note.md", "Moved/Note.md", source, new Map(), "macos");
    assert(result.includes(`wiki: [[./property.png]]\r\nlink: [property](./property.png)\r\n${marker}`));
    assert(result.includes("<!-- [[./comment.png]] -->"));
    assert(result.includes("[[../visible.png]] ![visible](../visible.png)"));
  }
  // An opening horizontal rule without a closing delimiter is normal content.
  const unclosed = "---\n\n[[./visible.png]]\n";
  assert(rebaseMarkdownContent("Note.md", "Moved/Note.md", unclosed, new Map(), "macos").includes("[[../visible.png]]"));
});

test("legacy reconciliation preserves the previous Windows outputs", () => {
  // These are the outputs from the unmodified shared implementation before
  // the Mac-only fix, including its existing handling of out-of-vault links.
  const outside = "# Draft\n![external](../outside.png)\n";
  assert.equal(reconcileMovedNoteContent("Note.md", "Moved/Note.md", "# Base\n", "# Base\n", outside), outside);
  const content = "---\nwiki: [[./property.png]]\nlink: [property](./property.png)\n---\n\n<!-- [[./comment.png]] -->\n\n[[./visible.png]] ![visible](./visible.png)\n";
  const expected = "---\nwiki: [[../property.png]]\nlink: [property](../property.png)\n---\n\n<!-- [[../comment.png]] -->\n\n[[../visible.png]] ![visible](../visible.png)\n";
  assert.equal(reconcileMovedNoteContent("Note.md", "Moved/Note.md", "# Base\n", "# Base\n", content), expected);
  assert.equal(reconcileMovedNoteContent("Note.md", "Moved/Note.md", "# Base\n", "# Base\n", content, "legacy"), expected);
});

test("extractMarkdownLinkRewrites detects link changes between content versions", () => {
  const before = "# Title\n\n![pic](attachments/flow.png)\n[doc](docs/guide.pdf)";
  const moved = "# Title\n\n![pic](../attachments/flow.png)\n[doc](../docs/guide.pdf)";
  const rewrites = extractMarkdownLinkRewrites(before, moved);
  assert.equal(rewrites.get("attachments/flow.png"), "../attachments/flow.png");
  assert.equal(rewrites.get("docs/guide.pdf"), "../docs/guide.pdf");
});

test("reconcileMovedNoteContent preserves user drafts and rewrites relative links", () => {
  const oldPath = "Synthetic.md";
  const newPath = "Moved/Synthetic.md";
  const before = "# Synthetic\n\n![diagram](attachments/note-flow.png)\n\nOriginal text.\n";
  const moved = "# Synthetic\n\n![diagram](../attachments/note-flow.png)\n\nOriginal text.\n";
  const draft = "# Synthetic\n\n![diagram](attachments/note-flow.png)\n\nOriginal text.\nUser added line while moving.\n";

  const reconciled = reconcileMovedNoteContent(oldPath, newPath, before, moved, draft);

  // Draft text must be preserved
  assert(reconciled.includes("User added line while moving."));
  // Relative link must be rewritten to new directory
  assert(reconciled.includes("![diagram](../attachments/note-flow.png)"));
  // Old relative link must not be present
  assert(!reconciled.includes("![diagram](attachments/note-flow.png)"));
});

test("reconcileMovedNoteContent handles newly added relative links in draft", () => {
  const oldPath = "Synthetic.md";
  const newPath = "Moved/Synthetic.md";
  const before = "# Synthetic\n\nOriginal text.\n";
  const moved = "# Synthetic\n\nOriginal text.\n";
  const draft = "# Synthetic\n\nOriginal text.\n![new](attachments/new.png)\n[remote](https://test.com)\n";

  const reconciled = reconcileMovedNoteContent(oldPath, newPath, before, moved, draft);

  assert(reconciled.includes("![new](../attachments/new.png)"));
  assert(reconciled.includes("[remote](https://test.com)"));
});

test("rebaseMarkdownContent strictly preserves code blocks, inline code and escaped text", () => {
  const input = `# Note Title

Inline attachment: ![diagram](attachments/note-flow.png)

Inline code span with fake link: \`![fake](attachments/note-flow.png)\`

\`\`\`markdown
# Fenced code block
![code](attachments/note-flow.png)
cat attachments/note-flow.png
\`\`\`

Escaped markdown syntax: \\!\\[escaped\\](attachments/note-flow.png)

External web URL: [Google](https://google.com/attachments/note-flow.png)
Anchor link: [Jump](#heading)
`;

  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // Real inline attachment MUST be rebased
  assert(output.includes("![diagram](../attachments/note-flow.png)"));
  // Inline code MUST NOT be rebased
  assert(output.includes("`![fake](attachments/note-flow.png)`"));
  // Code block lines MUST NOT be rebased
  assert(output.includes("![code](attachments/note-flow.png)"));
  assert(output.includes("cat attachments/note-flow.png"));
  // Escaped syntax MUST NOT be rebased
  assert(output.includes("\\!\\[escaped\\](attachments/note-flow.png)"));
  // External web URL MUST NOT be rebased
  assert(output.includes("[Google](https://google.com/attachments/note-flow.png)"));
  // Anchor link MUST NOT be rebased
  assert(output.includes("[Jump](#heading)"));
});

test("rebaseMarkdownContent accurately rebases reference-style attachment definitions", () => {
  const input = `# Note

Reference-style image usage: ![Architecture][arch-fig]
Reference-style document link: [Manual][doc-manual]

[arch-fig]: attachments/architecture.png "System Arch"
[doc-manual]: <attachments/manual.pdf>
[web-ref]: https://example.com/api "Web Docs"
`;

  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // Reference definition with title MUST be rebased
  assert(output.includes('[arch-fig]: ../attachments/architecture.png "System Arch"'));
  // Reference definition with angle brackets MUST be rebased
  assert(output.includes("[doc-manual]: <../attachments/manual.pdf>"));
  // Web reference definition MUST NOT be rebased
  assert(output.includes('[web-ref]: https://example.com/api "Web Docs"'));
  // Reference usages themselves stay unchanged
  assert(output.includes("![Architecture][arch-fig]"));
  assert(output.includes("[Manual][doc-manual]"));
});

test("reconcileMovedNoteContent returns movedContent directly when no edits during move", () => {
  const oldPath = "Synthetic.md";
  const newPath = "Moved/Synthetic.md";
  const before = "# Synthetic\n\n![diagram](attachments/note-flow.png)\n";
  const moved = "# Synthetic\n\n![diagram](../attachments/note-flow.png)\n";
  const draft = before;

  const reconciled = reconcileMovedNoteContent(oldPath, newPath, before, moved, draft);
  assert.equal(reconciled, moved);
});

test("reconcileMovedNoteContent returns draft directly when moved within same dir (rename)", () => {
  const oldPath = "Synthetic.md";
  const newPath = "Renamed.md";
  const before = "# Synthetic\n\n![diagram](attachments/note-flow.png)\n";
  const moved = "# Renamed\n\n![diagram](attachments/note-flow.png)\n";
  const draft = "# Synthetic\n\n![diagram](attachments/note-flow.png)\nUser edits\n";

  const reconciled = reconcileMovedNoteContent(oldPath, newPath, before, moved, draft);
  assert.equal(reconciled, draft);
});

test("rebaseMarkdownContent strictly preserves escaped wikilinks and indented code blocks", () => {
  const input = `# Note

Escaped wikilink:
\\[\\[./attachments/diagram.png\\]\\]

Real wikilink:
[[./attachments/diagram.png]]

Indented code block:

    ![diagram](attachments/note-flow.png)
    echo "keep attachments/note-flow.png"

Reference definition with newline:

[multiline-ref]:
    attachments/extra.png "Multiline Title"
`;

  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // Escaped wikilink MUST NOT be rebased
  assert(output.includes("\\[\\[./attachments/diagram.png\\]\\]"));
  // Real wikilink MUST be rebased
  assert(output.includes("[[../attachments/diagram.png]]"));
  // Indented code block MUST NOT be rebased
  assert(output.includes("    ![diagram](attachments/note-flow.png)"));
  assert(output.includes('    echo "keep attachments/note-flow.png"'));
  // Multiline reference definition MUST be rebased
  assert(output.includes('[multiline-ref]:\n    ../attachments/extra.png "Multiline Title"'));
});

test("rebaseMarkdownContent handles inline code inside link labels without altering code literals", () => {
  // Label containing brackets inside backticks
  const input = `Check this: [label \`\\](a.png)\`](attachments/real.png) and image: ![img \`\\](fake.png)\`](attachments/photo.jpg)`;
  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // The inline code \`\\](a.png)\` must remain identical
  assert(output.includes("`\\](a.png)`"));
  assert(output.includes("`\\](fake.png)`"));
  // The real destination must be rebased
  assert(output.includes("[label `\\](a.png)`](../attachments/real.png)"));
  assert(output.includes("![img `\\](fake.png)`](../attachments/photo.jpg)"));
});

test("rebaseMarkdownContent prevents overlapping and duplicate rewrites between standard and wiki links", () => {
  // Standard link whose label contains wiki-like brackets
  const input = `[label with [[attachments/nested.png]] target](attachments/outer.png) and separate [[./attachments/standalone.png]]`;
  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // Outer link destination must be rebased
  assert(output.includes("](../attachments/outer.png)"));
  // Standalone wiki link must be rebased
  assert(output.includes("[[../attachments/standalone.png]]"));
  // Nested wiki bracket inside the standard link label must not cause double-rewrite corruption
  assert(!output.includes("NaN") && !output.includes("undefined"));
});

test("rebaseMarkdownContent accurately preserves external URLs with backslash escapes, character entities, schemes, and wiki links", () => {
  const input = `# External Links and Relative Attachments

Local attachment (must be rebased):
![Diagram](attachments/architecture.png)

External link with backslash-escaped colon (must be preserved verbatim):
[Escaped Colon](https\\://example.com/api/v1)

External link with numeric entity (must be preserved verbatim):
[Numeric Entity](http&#58;//example.com/test)

External link with named entity (must be preserved verbatim):
[Named Entity](https&colon;//example.com/guide)

External link with HTML entity in query string (must be preserved verbatim):
[Query Entity](https://example.com/search?q=luckyray&amp;lang=zh)

Protocol-relative external URL (must be preserved verbatim):
[Protocol Relative](//cdn.example.com/assets/logo.png)

Mailto and FTP external URLs (must be preserved verbatim):
[Mail](mailto:developer@luckyray.app)
[FTP](ftp://files.luckyray.app/release.zip)

Angle-bracket external URL (must be preserved verbatim):
[Angle Bracket](<https://example.com/path>)

Wiki link with external target (must be preserved verbatim):
[[https://example.com/wiki]]
[[https\\://example.com/wiki-escaped]]
[[http&#58;//example.com/wiki-entity]]

Code blocks containing relative and external links (must be preserved verbatim):
\`\`\`markdown
![Code Diagram](attachments/architecture.png)
[Code Site](https\\://example.com)
\`\`\`

Inline code containing links (must be preserved verbatim):
\`[Inline](attachments/architecture.png)\`
\`[Inline Ext](https\\://example.com)\`

Escaped markdown syntax:
\\[Escaped Link\\](attachments/architecture.png)
`;

  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // 1. Local attachment MUST be rebased
  assert(output.includes("![Diagram](../attachments/architecture.png)"));

  // 2. All external links MUST retain their exact raw characters and ranges, NEVER converted to local paths
  assert(output.includes("[Escaped Colon](https\\://example.com/api/v1)"));
  assert(output.includes("[Numeric Entity](http&#58;//example.com/test)"));
  assert(output.includes("[Named Entity](https&colon;//example.com/guide)"));
  assert(output.includes("[Query Entity](https://example.com/search?q=luckyray&amp;lang=zh)"));
  assert(output.includes("[Protocol Relative](//cdn.example.com/assets/logo.png)"));
  assert(output.includes("[Mail](mailto:developer@luckyray.app)"));
  assert(output.includes("[FTP](ftp://files.luckyray.app/release.zip)"));
  assert(output.includes("[Angle Bracket](<https://example.com/path>)"));

  // 3. Wiki links with external targets MUST be preserved verbatim
  assert(output.includes("[[https://example.com/wiki]]"));
  assert(output.includes("[[https\\://example.com/wiki-escaped]]"));
  assert(output.includes("[[http&#58;//example.com/wiki-entity]]"));

  // 4. Code blocks and inline code MUST be preserved verbatim
  assert(output.includes("![Code Diagram](attachments/architecture.png)"));
  assert(output.includes("[Code Site](https\\://example.com)"));
  assert(output.includes("`[Inline](attachments/architecture.png)`"));
  assert(output.includes("`[Inline Ext](https\\://example.com)`"));

  // 5. Escaped syntax MUST be preserved verbatim
  assert(output.includes("\\[Escaped Link\\](attachments/architecture.png)"));

  // 6. Ensure no external link was mistakenly prefixed with ../
  assert(!output.includes("../https"));
  assert(!output.includes("../http"));
  assert(!output.includes("../mailto"));
  assert(!output.includes("../ftp"));
  assert(!output.includes("..//cdn"));
});

test("rebaseMarkdownContent preserves external link target while accurately rebasing wrapped local images", () => {
  const input = `# Nested Links Test

External link wrapping local image:
[![Architecture](attachments/architecture.png)](https://example.com/docs)

External link with escaped colon wrapping local image:
[![Flow Diagram](attachments/flow.png)](https\\://example.com/flow)

External link with angle brackets wrapping local image with title:
[![Overview](<attachments/overview.png> "System Overview")](<https://example.com/overview>)

External link wrapping multiple local images:
[Check ![One](attachments/one.png) and ![Two](attachments/two.png)](https://example.com/gallery)
`;

  const output = rebaseMarkdownContent("Synthetic.md", "Moved/Synthetic.md", input);

  // External link targets MUST remain unchanged
  assert(output.includes("](https://example.com/docs)"));
  assert(output.includes("](https\\://example.com/flow)"));
  assert(output.includes("](<https://example.com/overview>)"));
  assert(output.includes("](https://example.com/gallery)"));

  // Wrapped local image targets MUST be rebased
  assert(output.includes("[![Architecture](../attachments/architecture.png)]"));
  assert(output.includes("[![Flow Diagram](../attachments/flow.png)]"));
  assert(output.includes("[![Overview](<../attachments/overview.png> \"System Overview\")]"));
  assert(output.includes("![One](../attachments/one.png)"));
  assert(output.includes("![Two](../attachments/two.png)"));

  // Old paths must not be present
  assert(!output.includes("](attachments/architecture.png)"));
  assert(!output.includes("](attachments/flow.png)"));
  assert(!output.includes("<attachments/overview.png>"));
});
