import assert from "node:assert/strict";
import test from "node:test";
import { excerpt } from "../src/features/notes/noteExcerpt.ts";

test("bounded note previews preserve whitespace and UTF-16 truncation semantics", () => {
  const cases = [
    "",
    " \n\t",
    "  中文\n\nhello \t world  ",
    "a".repeat(55) + " \nword",
    "😀".repeat(30),
    "\uFEFF\u00a0a\u2028b",
    "prefix ".repeat(100),
  ];
  let seed = 7;
  const alphabet = ["a", "中", " ", "\t", "\n", "\r", "\u00a0", "\uFEFF", "😀"];
  for (let sample = 0; sample < 200; sample++) {
    let value = "";
    for (let i = 0; i < 130; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      value += alphabet[seed % alphabet.length];
    }
    cases.push(value);
  }
  for (const value of cases)
    assert.equal(
      excerpt(value),
      value.replace(/\s+/g, " ").trim().slice(0, 56),
    );
  assert.equal(
    excerpt("Visible preview ".repeat(8) + "ignored tail\n".repeat(100000)),
    excerpt("Visible preview ".repeat(8)),
  );
});
