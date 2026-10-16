import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function source(path) {
  return readFile(resolve(appRoot, path), "utf8");
}

test("the frozen official web_search resolves one backend credential and fails closed without it", async () => {
  const [provider, providerPackage, subprocess] = await Promise.all([
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-web-search-deepseek/package.json"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js"),
  ]);

  assert.equal(JSON.parse(providerPackage).version, "0.1.5-rc.2");
  assert.match(provider, /const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"/u);
  assert.match(provider, /credentials\.resolve\(apiKeyEnv\)/u);
  assert.match(provider, /WEB_PROVIDER_CREDENTIAL_MISSING/u);
  assert.match(subprocess, /SENSITIVE_ENV_PATTERN = \/KEY\|PASSWORD\|SECRET\|TOKEN\/i/u);
  assert.match(subprocess, /!SENSITIVE_ENV_PATTERN\.test\(key\)/u);
});

test("official and LuckyRay search tools remain distinct and conversation-provider neutral", async () => {
  const [officialTool, luckyRayTools, standard, code, cordis] = await Promise.all([
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js"),
    source("src-tauri/dsh-host/luckyray-dsh-resource-tools/index.mjs"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc/agent.cordis.yml"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml"),
  ]);

  assert.match(officialTool, /name:\s*"web_search"/u);
  assert.doesNotMatch(officialTool, /deepseek-official|b-ai|current\.provider/u);
  assert.match(luckyRayTools, /"luckyray_web_search"/u);
  assert.doesNotMatch(luckyRayTools, /deepseek-official|b-ai|current\.provider/u);
  for (const preset of [standard, code, cordis]) {
    assert.match(preset, /- id: tool-web\s+name: '@deepseek-ai\/dsh-tool-web'/u);
  }
});

test("only the exact backend credential crosses the two existing minimal launch environments", async () => {
  const [outerHost, surfaceHost] = await Promise.all([
    source("src-tauri/src/dsh_host.rs"),
    source("src-tauri/dsh-host/luckyray-dsh-host.mjs"),
  ]);

  assert.match(outerHost, /var_os\("DEEPSEEK_API_KEY"\)/u);
  assert.match(surfaceHost, /launchEnvironment\.DEEPSEEK_API_KEY/u);
  assert.doesNotMatch(surfaceHost, /\.\.\.process\.env|Object\.assign\([^)]*process\.env/u);
});

test("official search accepts a backend-only credential in a provider-neutral local fixture", async () => {
  const modulePath = resolve(
    appRoot,
    "src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js",
  );
  const { DeepSeekSearchProvider } = await import(pathToFileURL(modulePath).href);
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        content: [{
          type: "web_search_tool_result",
          tool_use_id: "fixture-tool-use",
          content: [{
            type: "web_search_result",
            url: "https://example.invalid/result",
            title: "fixture",
            page_age: "today",
          }],
        }],
      }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = new DeepSeekSearchProvider(() => ({
      resolveApiKey: async () => "epoch225-fixture-secret",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: `http://127.0.0.1:${address.port}`,
      model: "deepseek-v4-flash",
      apiVersion: "2023-06-01",
      maxTokens: 64,
      maxUses: 1,
    }));
    assert.equal(provider.id, "deepseek-official");
    const result = await provider.search({ query: "provider-neutral fixture", maxResults: 8 });
    assert.deepEqual(result.sources.map(({ url }) => url), ["https://example.invalid/result"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer epoch225-fixture-secret");
    assert.equal(JSON.stringify(requests[0].body).includes("b-ai"), false);

    const missing = new DeepSeekSearchProvider(() => ({
      resolveApiKey: async () => undefined,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: `http://127.0.0.1:${address.port}`,
      model: "deepseek-v4-flash",
      apiVersion: "2023-06-01",
      maxTokens: 64,
      maxUses: 1,
    }));
    await assert.rejects(
      missing.search({ query: "must fail before dispatch", maxResults: 8 }),
      (error) => error?.code === "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
    assert.equal(requests.length, 1, "a missing credential must fail before network dispatch");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
