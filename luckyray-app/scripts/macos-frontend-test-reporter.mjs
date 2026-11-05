// Emit only fixed test-file locations and finite result codes, never test data.
import { fileURLToPath } from "node:url";

export const FRONTEND_TEST_PREFIX = "MACOS_FRONTEND_TEST_RESULT ";
export const FRONTEND_TEST_FILES = Object.freeze([
  "tests/macLegacyNoteCreate.test.ts", "tests/companionConsole.contract.test.ts",
  "tests/companionBackgroundPresentation.contract.test.ts",
  "tests/macosNativeDiagnostics.test.mjs", "tests/macosNoteDataWorker.test.mjs",
  "tests/macosFrontendTestReporter.test.mjs",
]);
export const INTEGRATION_FRONTEND_TEST_FILES = Object.freeze([
  "tests/macosFolderProduct.test.ts", "tests/macosFolderSafety.test.ts",
  "tests/macosNoteFlow.test.mjs", "tests/macosInternalValidation.test.mjs",
  "tests/macosNoteDataWorker.test.mjs", "tests/macosNoteMoveDriver.test.mjs",
  "tests/macosNotePreviewDriver.test.mjs", "tests/macosNativeDiagnostics.test.mjs", "tests/macosFrontendTestReporter.test.mjs",
]);
const acceptedFiles = new Set([...FRONTEND_TEST_FILES, ...INTEGRATION_FRONTEND_TEST_FILES]);
const locations = new Map([...acceptedFiles].flatMap(file => {
  const url = new URL(`../${file}`, import.meta.url);
  return [[file, file], [fileURLToPath(url), file], [url.href, file]];
}));
const errorCodes = new Set(["ERR_ASSERTION", "ERR_TEST_FAILURE", "ERR_MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION", "ERR_INVALID_TYPESCRIPT_SYNTAX", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "SYNTAX_ERROR", "TYPE_ERROR", "RANGE_ERROR", "OTHER"]);
const position = value => Number.isInteger(value) && value >= 0 && value <= 1_000_000;
const marked = value => value === true || typeof value === "string";

export function safeFrontendTestResult(value) {
  if (!value || typeof value !== "object" || !acceptedFiles.has(value.file)
      || !position(value.line) || !position(value.column)
      || !["passed", "failed", "skipped", "todo"].includes(value.status)
      || (value.status === "failed" ? !errorCodes.has(value.errorCode) : value.errorCode !== null)) return null;
  const result = { file: value.file, line: value.line, column: value.column,
    status: value.status, errorCode: value.errorCode };
  if (value.status === "failed" && position(value.failureLine) && position(value.failureColumn)) {
    result.failureLine = value.failureLine;
    result.failureColumn = value.failureColumn;
  }
  return result;
}

function failurePosition(error, file) {
  for (const stack of [error?.cause?.stack, error?.stack]) {
    if (typeof stack !== "string") continue;
    for (const line of stack.slice(0, 32768).split("\n")) {
      const match = line.match(/\(?((?:file:\/\/\/|\/)[^()\r\n]+):([0-9]+):([0-9]+)\)?$/);
      if (match && locations.get(match[1]) === file) {
        const failureLine = Number(match[2]), failureColumn = Number(match[3]);
        if (position(failureLine) && position(failureColumn)) return { failureLine, failureColumn };
      }
    }
  }
  return {};
}

function failureCode(error) {
  const named = { SyntaxError: "SYNTAX_ERROR", TypeError: "TYPE_ERROR", RangeError: "RANGE_ERROR" };
  return [error?.cause?.code, named[error?.cause?.name], error?.code, named[error?.name]]
    .find(code => errorCodes.has(code)) ?? "OTHER";
}

export default async function* frontendTestReporter(events) {
  for await (const event of events) {
    if (!["test:pass", "test:fail"].includes(event?.type)) continue;
    const data = event.data, file = locations.get(data?.file);
    if (!file) continue;
    const status = marked(data.skip) ? "skipped" : marked(data.todo) ? "todo"
      : event.type === "test:pass" ? "passed" : "failed";
    const error = data.details?.error;
    const result = safeFrontendTestResult({ file, line: data.line ?? 0, column: data.column ?? 0,
      status, errorCode: status === "failed" ? failureCode(error) : null,
      ...(status === "failed" ? failurePosition(error, file) : {}) });
    if (result) yield `${FRONTEND_TEST_PREFIX}${JSON.stringify(result)}\n`;
  }
}
