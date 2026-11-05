import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import reporter, { FRONTEND_TEST_FILES, FRONTEND_TEST_PREFIX, safeFrontendTestResult }
  from "../scripts/macos-frontend-test-reporter.mjs";

const ownFile = "tests/macosFrontendTestReporter.test.mjs";
const canary = "PRIVATE_FRONTEND_CANARY";
const collect = async events => {
  let output = "";
  for await (const line of reporter(events)) output += line;
  return output;
};
const rows = output => output.trim().split("\n").filter(Boolean).map(line => {
  assert.ok(line.startsWith(FRONTEND_TEST_PREFIX));
  return JSON.parse(line.slice(FRONTEND_TEST_PREFIX.length));
});

if (process.env.MACOS_FRONTEND_REPORTER_FIXTURE === "1") {
  test(`${canary}_name`, () => {
    console.log(`${canary}_stdout`);
    console.error(`${canary}_stderr`);
    assert.equal(`${canary}_actual`, `${canary}_expected`, `${canary}_message`);
  });
} else {
  test("frontend projection emits only fixed fields and bounded positions", () => {
    const value = { file: ownFile, line: 0, column: 0, status: "failed", errorCode: "ERR_TEST_FAILURE",
      name: canary, actual: canary, expected: canary, message: canary, stderr: canary };
    assert.deepEqual(safeFrontendTestResult(value), {
      file: ownFile, line: 0, column: 0, status: "failed", errorCode: "ERR_TEST_FAILURE",
    });
    for (const bad of [{ file: `/private/${canary}/${ownFile}` }, { line: -1 }, { line: Infinity },
      { column: 1_000_001 }, { status: canary }, { errorCode: canary }]) {
      assert.equal(safeFrontendTestResult({ ...value, ...bad }), null);
    }
    assert.equal(safeFrontendTestResult({ ...value, status: "passed" }), null);
    assert.ok(FRONTEND_TEST_FILES.includes(ownFile));
  });

  test("reporter filters canaries and confines failure positions to the same fixed file", async () => {
    const error = { code: "ERR_TEST_FAILURE", message: canary, cause: { code: "ERR_ASSERTION",
      actual: canary, expected: canary,
      stack: `${canary}\n    at hidden (/private/${canary}/source.ts:88:9)\n    at check (${import.meta.url}:74:12)` } };
    const data = { file: fileURLToPath(import.meta.url), line: 70, column: 2, name: canary, details: { error } };
    const output = await collect([
      { type: "test:stdout", data: { ...data, message: canary } },
      { type: "test:stderr", data: { ...data, message: canary } },
      { type: "test:diagnostic", data: { ...data, message: canary } },
      { type: "test:fail", data },
      { type: "test:fail", data: { ...data, file: `/private/${canary}/${ownFile}` } },
    ]);
    assert.equal(output.includes(canary), false);
    assert.deepEqual(rows(output), [{ file: ownFile, line: 70, column: 2, status: "failed",
      errorCode: "ERR_ASSERTION", failureLine: 74, failureColumn: 12 }]);
    const otherFile = new URL("./macosNoteDataWorker.test.mjs", import.meta.url).href;
    const other = await collect([{ type: "test:fail", data: { ...data, details: {
      error: { code: canary, stack: `    at check (${otherFile}:5:3)` },
    } } }]);
    assert.deepEqual(rows(other), [{ file: ownFile, line: 70, column: 2, status: "failed", errorCode: "OTHER" }]);
  });

  test("reporter preserves skipped and todo states and file-level failures", async () => {
    const data = { file: ownFile, line: 1, column: 1 };
    assert.deepEqual(rows(await collect([
      { type: "test:pass", data },
      { type: "test:pass", data: { ...data, skip: canary } },
      { type: "test:fail", data: { ...data, todo: canary } },
      { type: "test:fail", data: { file: ownFile } },
    ])).map(({ line, status, errorCode }) => [line, status, errorCode]), [
      [1, "passed", null], [1, "skipped", null], [1, "todo", null], [0, "failed", "OTHER"],
    ]);
  });

  test("real failing Node child exposes no names, assertions, or output", () => {
    const env = { ...process.env, MACOS_FRONTEND_REPORTER_FIXTURE: "1" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--test", "--test-reporter=./scripts/macos-frontend-test-reporter.mjs", ownFile], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 15000, maxBuffer: 65536,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(`${child.stdout}${child.stderr}`.includes(canary), false);
    assert.equal(child.stderr, "");
    const results = rows(child.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "failed");
    assert.equal(results[0].errorCode, "ERR_ASSERTION");
    assert.ok(results[0].line > 0 && results[0].failureLine > results[0].line);
    assert.deepEqual(safeFrontendTestResult(results[0]), results[0]);
  });
}
