import assert from "node:assert/strict";
import test from "node:test";
import { canApplyCompanionPresentation } from "../src/app/companionPresentationLease";

test("main renderer applies only a live native presentation claim", () => {
  assert.equal(canApplyCompanionPresentation(2_000, 10, false), true);
  assert.equal(canApplyCompanionPresentation(2_000, 1_950, false), false);
  assert.equal(canApplyCompanionPresentation(200, 500, false), false);
  assert.equal(canApplyCompanionPresentation(2_000, 10, true), false);
  assert.equal(canApplyCompanionPresentation("2000", 10, false), false);
  assert.equal(canApplyCompanionPresentation(Number.MAX_SAFE_INTEGER + 1, 10, false), false);
  assert.equal(canApplyCompanionPresentation(2_000, Number.NaN, false), false);
});
