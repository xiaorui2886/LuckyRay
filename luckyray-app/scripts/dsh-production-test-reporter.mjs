const SCHEMA_VERSION = 1;

function resultStatus(event) {
  if (event.data.skip !== undefined) return "skipped";
  if (event.data.todo !== undefined) return "todo";
  return event.type === "test:pass" ? "passed" : "failed";
}

export default async function* dshProductionTestReporter(source) {
  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.nesting === 0) {
      yield `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "test-result",
        name: event.data.name,
        status: resultStatus(event),
      })}\n`;
      continue;
    }
    if (event.type === "test:summary" && event.data.file === undefined) {
      yield `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "summary",
        tests: event.data.counts.tests,
        pass: event.data.counts.passed,
        fail: event.data.counts.failed,
        cancelled: event.data.counts.cancelled,
        skipped: event.data.counts.skipped,
      })}\n`;
    }
  }
}
