import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaRoot = path.join(root, "src-tauri", "media-engine");
const python = path.join(mediaRoot, "python.exe");
const ffmpegDir = path.join(mediaRoot, "ffmpeg");
const ffmpeg = path.join(ffmpegDir, "ffmpeg.exe");
const ffprobe = path.join(ffmpegDir, "ffprobe.exe");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result;
}

test("the app-owned media runner downloads and merges one bounded video/audio track pair", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "luckyray-track-pair-"));
  const video = path.join(temp, "video.mp4");
  const audio = path.join(temp, "audio.m4a");
  const output = path.join(temp, "merged.mp4");
  try {
    run(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1",
      "-an", "-c:v", "mpeg4", video,
    ]);
    run(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-vn", "-c:a", "aac", audio,
    ]);
    const videoBytes = await readFile(video);
    const audioBytes = await readFile(audio);
    const server = createServer((request, response) => {
      const body = request.url === "/video" ? videoBytes : request.url === "/audio" ? audioBytes : null;
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": request.url === "/video" ? "video/mp4" : "audio/mp4",
        "Content-Length": body.length,
      });
      response.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      const manifest = JSON.parse(await readFile(path.join(mediaRoot, "runtime-manifest.json"), "utf8"));
      const child = spawn(python, ["-I", path.join(mediaRoot, "runner.py")], {
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: temp,
          TMP: temp,
          HOME: temp,
          USERPROFILE: temp,
          LOCALAPPDATA: temp,
          APPDATA: temp,
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          LUCKYRAY_MEDIA_OUTPUT: output,
          LUCKYRAY_MEDIA_WHEEL: path.join(mediaRoot, manifest.ytDlpWheel),
          LUCKYRAY_MEDIA_EJS_WHEEL: path.join(mediaRoot, manifest.ytDlpEjsWheel),
          LUCKYRAY_MEDIA_FFMPEG_DIR: ffmpegDir,
          LUCKYRAY_MEDIA_DENO: path.join(mediaRoot, manifest.deno),
          LUCKYRAY_MEDIA_ALLOW_LOOPBACK_TEST: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.stdin.end(JSON.stringify({
        operation: "download",
        url: `${base}/video`,
        audioUrl: `${base}/audio`,
        formatSelector: null,
        maxBytes: 16 * 1024 * 1024,
        deadlineSeconds: 30,
        userAgent: "LuckyRay fixture",
        referer: `${base}/watch`,
      }));
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("media runner timed out"));
        }, 45_000);
        child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(exitCode, 0, `stdout=${Buffer.concat(stdout)} stderr=${Buffer.concat(stderr)}`);
      assert.equal(Buffer.concat(stdout).length, 0);
      assert.equal(Buffer.concat(stderr).length, 0);
      assert.ok((await stat(output)).size > 1_000);
      const probe = run(ffprobe, [
        "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", output,
      ]).stdout;
      assert.match(probe, /video/);
      assert.match(probe, /audio/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
