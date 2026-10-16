import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runNativeDshProbe } from "../src-tauri/dsh-host/luckyray-dsh-host.mjs";

// Actual official CLI resume on a new synthetic home; the only model endpoint
// is this deterministic loopback provider. Never accept a user-state override.
test("the new official runtime resumes an old conversation twice and preserves its original events", {
  timeout: 120_000,
}, async (t) => {
  const oldRoot = process.env.DSH_UPGRADE_FROM_RUNTIME_ROOT;
  const newRoot = process.env.DSH_UPGRADE_TO_RUNTIME_ROOT;
  assert.ok(oldRoot && newRoot, "both verified runtime roots are required");
  const home = await mkdtemp(join(tmpdir(), "luckyray-dsh-resume-upgrade-"));
  const prompt = "LUCKYRAY_SYNTHETIC_CONTINUE_EXISTING_SESSION";
  const answer = "LUCKYRAY_SYNTHETIC_RESUME_ACCEPTED";
  let verified = false;
  try {
    await runNativeDshProbe({ runtimeRoot: oldRoot, stateRoot: home });
    const load = name => import(pathToFileURL(join(newRoot, "host/node_modules", name, "lib/index.js")));
    const { Context } = await load("@deepseek-ai/cordis");
    const { default: Persistence } = await load("@deepseek-ai/dsh-session-persistence-jsonl");
    const storage = () => new Persistence(new Context(), { root: join(home, "sessions") });
    const before = await storage().list();
    assert.equal(before.length, 1);
    const id = before[0].header.id;
    const read = async () => {
      const handle = await storage().open(id, "read");
      try { return await handle.read(); } finally { await handle.close(); }
    };
    const original = await read();
    assert.ok(original.events.length > 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      let accepted = 0;
      const server = createServer((req, res) => {
        if (req.method !== "POST" || !["/v1/messages", "/chat/completions"].includes(req.url)) {
          res.writeHead(404).end(); return;
        }
        let bytes = 0;
        const chunks = [];
        req.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        req.on("end", () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks)); } catch { res.writeHead(400).end(); return; }
          const user = payload.messages?.filter(message => message.role === "user").at(-1);
          const firstText = Array.isArray(user?.content) ? user.content.find(part => part.type === "text")?.text : user?.content;
          if (accepted !== 0 || firstText !== prompt) { res.writeHead(422).end(); return; }
          accepted++;
          res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          if (req.url === "/v1/messages") {
            for (const event of [
              { type: "message_start", message: { id: "synthetic-resume", type: "message", role: "assistant", model: payload.model,
                content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: answer } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ id: "synthetic-resume", object: "chat.completion.chunk", created: 1, model: payload.model,
              choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "synthetic-resume", object: "chat.completion.chunk", created: 1, model: payload.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
            res.write("data: [DONE]\n\n");
          }
          res.end();
        });
      });
      await new Promise(done => server.listen(0, "127.0.0.1", done));
      try {
        const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          TEMP: home, TMP: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"),
          LOCALAPPDATA: join(home, "AppData/Local"), XDG_CONFIG_HOME: join(home, ".config"), DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: "1", DSH_TOOLS_MODE: "native", DSH_PERMISSION_MODE: "read-only",
          DEEPSEEK_API_KEY: "synthetic-local-resume", DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` };
        const child = spawn(join(newRoot, "node/node.exe"), [join(newRoot, "host/node_modules/@deepseek-ai/dsh/lib/bin.js"),
          "--profile", "headless", "--patch", join(home, "luckyray-native-probe.patch.yml"), "--session-id", id, prompt],
        { cwd: join(home, "workspace"), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
        const timeout = setTimeout(() => child.kill(), 30_000);
        let result;
        try { result = await new Promise((done, reject) => {
          child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
        }); } finally { clearTimeout(timeout); }
        assert.deepEqual(result, { code: 0, signal: null }, stderr);
        assert.equal(accepted, 1, "the continued turn actually reached only the local diagnostic provider");
      } finally { await new Promise(done => server.close(done)); }
      const current = await read();
      assert.deepEqual(current.events.slice(0, original.events.length), original.events, "the original conversation remains an exact prefix");
      assert.equal(current.events.filter(event => event.type === "turn/end" && event.data?.reason?.kind === "completed").length, attempt + 2);
      assert.equal(current.events.filter(event => event.type === "assistant/message" && JSON.stringify(event).includes(answer)).length, attempt + 1);
      assert.equal((await storage().list()).length, 1, "continuation retains the original Session ID");
    }
    assert.equal(await readFile(join(home, "luckyray-native-probe.patch.yml"), "utf8"), "- id: session-title-llm\n  disabled: true\n");
    verified = true;
    t.diagnostic(`old Session ${id} continued twice by separate new-runtime processes; exact old event prefix preserved`);
  } finally {
    if (verified) await rm(home, { recursive: true, force: true });
    else t.diagnostic(`failed synthetic resume fixture retained: ${home}`);
  }
});
