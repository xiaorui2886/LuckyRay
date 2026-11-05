// Recheck the twelve reviewed recipe inputs in the frozen public manifest.
// No archive is saved, unpacked or executed, and no production manifest is edited.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "xiaorui2886/LuckyRay";
export const PUBLIC_BRANCH = "codex/mac-source-evidence-20261105";
export const MANIFEST_BLOB = "cc84a3e1a03999afa7d5678e866b5ec272780a72";
const INPUT_IDS = [145, 147, 155, 177, 223, 278, 302, 310, 325, 334, 364, 376]
  .map(line => `libvips-input-${line}`);
const OFFICIAL_CHECKSUMS = {
  "libvips-input-145": {
    sha256: "17d15cac2af80a33271127408e0abc2748eb297c595c2a26409e81e14e7d1b8f",
    sourceUrl: "https://download.gnome.org/sources/glib/2.90/glib-2.90.0.sha256sum",
  },
  "libvips-input-155": {
    sha256: "98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821",
    sourceUrl: "https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.4.sha256sum",
  },
  "libvips-input-334": {
    sha256: "852b18e1a00b8605528825a27dc7748bff2a5dd254028f59dc22a34ea57e81b6",
    sourceUrl: "https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.sha256sum",
  },
  "libvips-input-310": {
    sha256: "1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4",
    sourceUrl: "https://www.cairographics.org/news/cairo-1.18.6/",
  },
  "libvips-input-325": {
    sha256: "342385b6ca3b7c73455d7c80a13b7dbe4489e00bc3bd4c5bd6ed4dce421e374a",
    sourceUrl: "https://download.gnome.org/sources/pango/1.58/pango-1.58.2.sha256sum",
  },
};
const LIMITS = { maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000, maxRedirects: 4 };

export async function readPublicInputs() {
  const bytes = await readFile(new URL("../third-party-notices/macos-dsh/INDEX.json", import.meta.url));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blob !== MANIFEST_BLOB) throw new Error("public-manifest-blob-mismatch");
  const manifest = JSON.parse(bytes);
  const selected = manifest.sourceInputs.filter(input => INPUT_IDS.includes(input.id));
  if (selected.length !== INPUT_IDS.length || selected.some((input, index) =>
    input.id !== INPUT_IDS[index] || !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.required !== true ||
    !["source-archive", "patch"].includes(input.kind) || !input.url.startsWith("https://"))) {
    throw new Error("public-input-set-mismatch");
  }
  return {
    inputs: selected.map(({ id, recipeLine, url, kind, sha256, bytes }) => ({
      id, recipeLine, url, kind, reviewedPin: { sha256, bytes }, officialChecksum: OFFICIAL_CHECKSUMS[id] ?? null,
    })),
    unresolvedRequirementIds: [
      ...manifest.sourceInputs.filter(input => input.required && input.sha256 === null).map(({ id }) => id),
      ...manifest.additionalUnresolvedRequirements.filter(input => input.required).map(({ id }) => id),
    ],
    unresolvedClosures: manifest.additionalUnresolvedRequirements.filter(input => input.required).map(({ id }) => id),
  };
}

// request injection is for offline HTTP fixtures only. The CLI has no URL override.
export async function collectSource(input, { request = fetch, signal, ...limits } = {}) {
  const { maxBytes, timeoutMs, maxRedirects } = { ...LIMITS, ...limits };
  const result = {
    id: input.id, kind: input.kind, recipeLine: input.recipeLine, sourceUrl: input.url,
    status: "failed", httpStatus: null, bytes: null, observedBytes: 0, sha256: null,
    officialChecksum: input.officialChecksum ? {
      ...input.officialChecksum, sourceRetrievedInThisRun: false, comparison: "not-performed",
    } : null,
    reviewedPin: input.reviewedPin ? { ...input.reviewedPin, comparison: "not-performed" } : null,
    sourceQualification: "not-performed", failure: null,
  };
  const controller = new AbortController();
  let timedOut = false;
  const interrupt = () => controller.abort();
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response;
  const fail = reason => { result.failure = reason; throw new Error(reason); };
  try {
    let url = new URL(input.url);
    for (let redirects = 0; ; redirects += 1) {
      if (url.protocol !== "https:" || url.username || url.password) fail("https-without-credentials-required");
      response = await request(url.href, {
        redirect: "manual", signal: controller.signal,
        headers: { "Accept-Encoding": "identity" },
      });
      result.httpStatus = response.status;
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= maxRedirects) fail("redirect-limit-exceeded");
      const location = response.headers.get("location");
      if (!location) fail("redirect-location-missing");
      url = new URL(location, url);
    }
    if (response.status !== 200) fail("http-status-not-200");
    // fetch may transparently decode content encodings; require archive bytes as served.
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") fail("unexpected-content-encoding");
    if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) fail("html-response-not-source");
    const lengthHeader = response.headers.get("content-length");
    const expectedBytes = lengthHeader === null ? null : Number(lengthHeader);
    if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)) fail("invalid-content-length");
    if (expectedBytes > maxBytes) fail("byte-limit-exceeded");
    if (!response.body) fail("response-body-missing");
    const hash = createHash("sha256");
    for await (const chunk of response.body) {
      result.observedBytes += chunk.byteLength;
      if (result.observedBytes > maxBytes) fail("byte-limit-exceeded");
      hash.update(chunk);
    }
    if (controller.signal.aborted) fail(timedOut ? "timeout" : "interrupted");
    if (!result.observedBytes) fail("empty-source");
    if (expectedBytes !== null && result.observedBytes !== expectedBytes) fail("content-length-mismatch");
    result.bytes = result.observedBytes;
    result.sha256 = hash.digest("hex");
    if (result.reviewedPin) {
      const matched = result.sha256 === result.reviewedPin.sha256 && result.bytes === result.reviewedPin.bytes;
      result.reviewedPin.comparison = matched ? "match" : "mismatch";
      if (!matched) fail("reviewed-source-pin-mismatch");
    }
    if (result.officialChecksum) {
      const matched = result.sha256 === result.officialChecksum.sha256;
      result.officialChecksum.comparison = matched ? "match" : "mismatch";
      if (!matched) fail("official-sha256-mismatch");
    }
    result.status = "download-complete-awaiting-source-review";
  } catch {
    result.failure ??= timedOut ? "timeout" : signal?.aborted ? "interrupted" :
      result.observedBytes ? "body-transfer-interrupted" : "transport-failed";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
    await response?.body?.cancel().catch(() => {});
  }
  return result;
}

async function main() {
  if (process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== PUBLIC_REPOSITORY ||
    process.env.GITHUB_REF !== `refs/heads/${PUBLIC_BRANCH}` ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")) {
    throw new Error("fixed-public-branch-actions-context-required");
  }
  const { inputs, unresolvedClosures, unresolvedRequirementIds } = await readPublicInputs();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const report = {
    schemaVersion: 2, scope: "public-upstream-source-evidence-only",
    repository: PUBLIC_REPOSITORY, ref: `refs/heads/${PUBLIC_BRANCH}`,
    checkoutCommit: process.env.GITHUB_SHA, nodeVersion: process.version,
    manifestSource: "exact checkoutCommit", manifestBlob: MANIFEST_BLOB,
    startedAt: new Date().toISOString(), limits: LIMITS,
    status: "not-completed", applicationBuild: "not-run", binaryExport: false,
    productionManifestModified: false, sourceQualification: "not-performed", distributionReady: false,
    reviewedInputIds: inputs.map(input => input.id), unresolvedRequirementIds,
    unresolvedClosures, results: [],
  };
  try {
    // One attempt per input; failures do not hide the results for later inputs.
    for (const input of inputs) {
      if (controller.signal.aborted) {
        report.results.push({ id: input.id, sourceUrl: input.url, status: "not-run", reason: "interrupted" });
      } else {
        report.results.push(await collectSource(input, { signal: controller.signal }));
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  const complete = report.results.every(result => result.status === "download-complete-awaiting-source-review");
  report.status = controller.signal.aborted ? "interrupted" : complete ? "collected-awaiting-source-review" : "incomplete";
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  if (!complete || controller.signal.aborted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const reason = ["fixed-public-branch-actions-context-required", "public-manifest-blob-mismatch", "public-input-set-mismatch"]
      .includes(error.message) ? error.message : "source-evidence-preflight-failed";
    console.log(JSON.stringify({ scope: "public-upstream-source-evidence-only", status: "not-run", reason }));
    process.exitCode = 1;
  });
}
