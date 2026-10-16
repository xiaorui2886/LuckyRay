import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaRoot = path.join(root, "src-tauri", "media-engine");
const python = path.join(mediaRoot, "python.exe");

async function run(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("the production resolver rejects a partial video track paired with full-length audio", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "luckyray-format-duration-"));
  const ffmpegDir = path.join(mediaRoot, "ffmpeg");
  const ffmpeg = path.join(ffmpegDir, "ffmpeg.exe");
  const runner = path.join(root, "third_party", "media-engine", "runner.py");
  const matched = path.join(temp, "matched.mp4");
  const mismatched = path.join(temp, "mismatched.mp4");
  try {
    const matchedBuild = await run(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "mpeg4", "-c:a", "aac", matched,
    ]);
    assert.equal(matchedBuild.exitCode, 0, matchedBuild.stderr);
    const mismatchedBuild = await run(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
      "-c:v", "mpeg4", "-c:a", "aac", mismatched,
    ]);
    assert.equal(mismatchedBuild.exitCode, 0, mismatchedBuild.stderr);

    const validation = await run(python, [
      "-I", "-c",
      [
        "import importlib.util,json,pathlib,sys",
        "spec=importlib.util.spec_from_file_location('luckyray_media_runner',sys.argv[1])",
        "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
        "print(json.dumps({'matched':module.validate_muxed_candidate(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[4]),True),'mismatched':module.validate_muxed_candidate(pathlib.Path(sys.argv[3]),pathlib.Path(sys.argv[4]),True)}))",
      ].join(";"),
      runner, matched, mismatched, ffmpegDir,
    ]);
    assert.equal(validation.exitCode, 0, validation.stderr);
    assert.deepEqual(JSON.parse(validation.stdout), { matched: true, mismatched: false });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the production catalog omits preview tracks shorter than the full media", async () => {
  const runner = path.join(root, "third_party", "media-engine", "runner.py");
  const result = await run(python, [
    "-I", "-c",
    [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('luckyray_media_runner',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
      "payload={'duration':120,'formats':[{'format_id':'preview','height':1080,'width':1920,'vcodec':'h264','acodec':'none','ext':'mp4','duration':20},{'format_id':'complete','height':720,'width':1280,'vcodec':'h264','acodec':'aac','ext':'mp4','duration':120}]}",
      "print(json.dumps(module.project_format_catalog(payload)))",
    ].join(";"),
    runner,
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const formats = JSON.parse(result.stdout);
  assert.deepEqual(formats.map((format) => format.selector), ["complete"]);
});

test("the app-owned resolver returns a bounded safe multi-resolution catalog without downloading", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "luckyray-format-catalog-"));
  const server = createServer((request, response) => {
    if (request.url !== "/master.m3u8") {
      response.writeHead(404).end();
      return;
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      `${base}/PRIVATE-360.m3u8?token=PRIVATE`,
      "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720",
      `${base}/PRIVATE-720.m3u8?token=PRIVATE`,
      "",
    ].join("\n");
    response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const manifest = JSON.parse(await readFile(path.join(mediaRoot, "runtime-manifest.json"), "utf8"));
    const base = `http://127.0.0.1:${server.address().port}`;
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
        LUCKYRAY_MEDIA_WHEEL: path.join(mediaRoot, manifest.ytDlpWheel),
        LUCKYRAY_MEDIA_EJS_WHEEL: path.join(mediaRoot, manifest.ytDlpEjsWheel),
        LUCKYRAY_MEDIA_FFMPEG_DIR: path.join(mediaRoot, "ffmpeg"),
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
      operation: "probe",
      url: `${base}/master.m3u8`,
      maxBytes: 64 * 1024,
      deadlineSeconds: 30,
      userAgent: "LuckyRay fixture",
      referer: `${base}/watch`,
    }));
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("media probe timed out"));
      }, 45_000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, `stderr=${Buffer.concat(stderr)}`);
    assert.equal(Buffer.concat(stderr).length, 0);
    const text = Buffer.concat(stdout).toString("utf8");
    assert.ok(Buffer.byteLength(text) <= 64 * 1024);
    const result = JSON.parse(text);
    assert.deepEqual(result.formats.map((format) => format.height), [720, 360]);
    assert.ok(result.formats.every((format) => format.selector && format.label));
    assert.doesNotMatch(text, /PRIVATE|token=|127\.0\.0\.1|https?:\/\//i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
