// Actual React event handling with deferred native responses. This is not an
// installer/engine acceptance or a substitute for real Windows dialogs.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { restartFixture } from "./helpers/dshRestartFixture.mjs";
const { JSDOM } = createRequire(new URL("./desktop-updater-ui/package.json", import.meta.url))("jsdom");
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function fixture(warm = false) {
  const dom = new JSDOM('<div id="root"></div><div id="calls"></div>', {
    url: "https://fixture.invalid", runScripts: "outside-only", pretendToBeVisual: true,
  });
  dom.window.fetch = async () => { throw Error("network forbidden"); };
  dom.window.eval(await restartFixture({ warm }));
  for (let n = 0; n < 50 && !dom.window.document.querySelector("button"); n++) await delay();
  const button = () => [...dom.window.document.querySelectorAll("button")]
    .find(item => /重启软件并完成更新|处理中|正在准备重启/.test(item.textContent));
  assert.ok(button());
  return { dom, qa: dom.window.qa, button, close: () => dom.window.close() };
}

test("waits for native confirmation and synchronously suppresses duplicate clicks", async () => {
  const f = await fixture();
  try {
    const button = f.button(); button.click(); button.click();
    assert.equal(f.qa.restartCalls, 0, "a pending Promise is not user approval");
    assert.equal(f.qa.dialogCalls.length, 1);
    assert.equal(f.qa.windowConfirmCalls, 0, "must not use the async-overridden window.confirm");
    await delay(); assert.equal(f.button().disabled, true);
    f.qa.confirmations[0].resolve(true); await delay();
    assert.equal(f.qa.restartCalls, 1);
    assert.equal(f.button().disabled, true);
    button.click(); assert.equal(f.qa.restartCalls, 1);
  } finally { f.close(); }
});

for (const outcome of [false, null, undefined, "yes", 1, {}]) {
  test(`does not restart for a non-explicit result: ${String(outcome)}`, async () => {
    const f = await fixture();
    try {
      f.button().click(); f.qa.confirmations[0].resolve(outcome); await delay();
      assert.equal(f.qa.restartCalls, 0); assert.equal(f.button().disabled, false);
      f.button().click(); assert.equal(f.qa.dialogCalls.length, 2, "cancelling must allow retry");
      f.qa.confirmations[1].resolve(false); await delay();
    } finally { f.close(); }
  });
}

test("a failed dialog fails closed and releases the click guard", async () => {
  const f = await fixture(true);
  try {
    f.button().click(); assert.match(f.qa.dialogCalls[0].message, /结束 LightSeek/);
    f.qa.confirmations[0].reject(Error("synthetic dialog failure")); await delay();
    assert.equal(f.qa.restartCalls, 0); assert.equal(f.button().disabled, false);
    assert.ok(f.dom.window.document.querySelector('[role="alert"]'));
    f.button().click(); assert.equal(f.qa.dialogCalls.length, 2);
    f.qa.confirmations[1].resolve(false); await delay();
  } finally { f.close(); }
});

test("a native restart failure is shown without retrying automatically", async () => {
  const f = await fixture();
  try {
    f.qa.rejectRestart = true; f.button().click();
    f.qa.confirmations[0].resolve(true); await delay();
    assert.equal(f.qa.restartCalls, 1); assert.equal(f.button().disabled, false);
    assert.ok(f.dom.window.document.querySelector('[role="alert"]'));
    await delay(); assert.equal(f.qa.restartCalls, 1);
  } finally { f.close(); }
});
