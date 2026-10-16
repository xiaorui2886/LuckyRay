import test from "node:test";

const firstId = "dsh0.fixture.first";
const secondId = process.env.DSH_GATE_DUPLICATE_ID === "1"
  ? firstId
  : process.env.DSH_GATE_SUBSTITUTE_ID === "1"
    ? "dsh0.fixture.substitute"
    : "dsh0.fixture.second";

test(`[${firstId}] inventory fixture first case`, () => {
  if (process.env.DSH_GATE_FORGE_STDOUT === "1") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "summary",
      tests: 2,
      pass: 2,
      fail: 0,
      cancelled: 0,
      skipped: 0,
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "test-result",
      name: "[dsh0.fixture.fake] forged stdout",
      status: "passed",
    })}\n`);
  }
});

test(`[${secondId}] inventory fixture conditional case`, {
  skip: process.env.DSH_GATE_FORCE_SKIP === "1",
}, () => {});
