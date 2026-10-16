// Read-only feasibility gate for the existing pinned media runtime.
// Does not install, transcode, import, alter a profile, or launch the application.
// Usage: node script.cjs RUNTIME_ROOT EXPECTED_MANIFEST_SHA256 FILE [FILE...]
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fileSha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const run = (exe, args, maxBuffer = 1024 * 1024) => new Promise((resolve, reject) => {
  execFile(exe, args, { windowsHide: true, timeout: 15000, maxBuffer, encoding: 'buffer' }, (error, stdout) => {
    if (error) reject(new Error(`native-decoder-command-failed:${path.basename(exe)}:${error.code || 'unknown'}`));
    else resolve(stdout);
  });
});
async function verifyRuntime(root, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected || '')) throw new Error('expected-manifest-sha-required');
  const canonicalRoot = fs.realpathSync(root);
  const raw = fs.readFileSync(path.join(canonicalRoot, 'runtime-manifest.json'));
  if (sha(raw) !== expected.toLowerCase()) throw new Error('runtime-manifest-sha-mismatch');
  const manifest = JSON.parse(raw);
  const source = fs.readFileSync(path.resolve(__dirname, '../third_party/media-engine/manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.sourceManifestSha256 !== sha(source) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 512) throw new Error('runtime-source-invalid');
  const declared = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(p => !p || p === '..' || p === '.') || declared.has(entry.path)) throw new Error('runtime-path-invalid');
    declared.add(entry.path);
    const full = path.join(canonicalRoot, entry.path), stat = fs.lstatSync(full);
    const relative = path.relative(canonicalRoot, fs.realpathSync(full));
    if (stat.isSymbolicLink() || !stat.isFile() || relative.startsWith('..') || path.isAbsolute(relative) || stat.size !== entry.size || await fileSha(full) !== entry.sha256) throw new Error('runtime-file-mismatch');
  }
  // Undeclared DLLs must not participate in executable dependency resolution.
  function inventory(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.isSymbolicLink()) throw new Error('runtime-link-invalid');
      const name = prefix + entry.name;
      return entry.isDirectory() ? inventory(path.join(directory, entry.name), name + '/') : [name];
    });
  }
  const actual = inventory(canonicalRoot).filter(name => name !== 'runtime-manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...declared].sort())) throw new Error('runtime-undeclared-file');
  if (!declared.has('ffmpeg/ffmpeg.exe') || !declared.has('ffmpeg/ffprobe.exe')) throw new Error('runtime-decoder-missing');
  const ffmpeg = path.join(canonicalRoot, 'ffmpeg/ffmpeg.exe'), ffprobe = path.join(canonicalRoot, 'ffmpeg/ffprobe.exe');
  const version = (await run(ffmpeg, ['-hide_banner', '-version'])).toString();
  if (!version.includes('--enable-shared') || /--enable-(gpl|nonfree)(?:\s|$)/.test(version)) throw new Error('runtime-lgpl-build-gate');
  return { ffmpeg, ffprobe, manifestSha256: sha(raw) };
}
async function inspect(runtime, input) {
  const file = fs.realpathSync(input);
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('input-must-be-local-file');
  const before = await fileSha(file);
  const metadata = JSON.parse((await run(runtime.ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=codec_name,profile,width,height,pix_fmt:format=duration','-of','json',file])).toString());
  const video = metadata.streams?.[0], duration = Number(metadata.format?.duration);
  if (!video?.width || !video?.height || !Number.isFinite(duration) || duration <= 0) throw new Error('video-metadata-invalid');
  const frames = [];
  for (const proportion of [.05, .5, .95]) {
    const seconds = duration * proportion, start = performance.now();
    const jpeg = await run(runtime.ffmpeg, ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-threads','2','-ss',seconds.toFixed(6),'-i',file,'-map','0:v:0','-frames:v','1','-an','-sn','-dn','-filter_threads','1','-vf','scale=256:256:force_original_aspect_ratio=decrease','-threads','1','-c:v','mjpeg','-f','image2pipe','pipe:1']);
    if (jpeg.length < 4 || jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[jpeg.length-2] !== 255 || jpeg[jpeg.length-1] !== 217) throw new Error('frame-not-jpeg');
    frames.push({ seconds, milliseconds: Math.round(performance.now()-start), bytes: jpeg.length, sha256: sha(jpeg) });
  }
  if (before !== await fileSha(file)) throw new Error('source-changed-during-read-only-check');
  return { name: path.basename(file), codec: video.codec_name, profile: video.profile, width: video.width, height: video.height, pixelFormat: video.pix_fmt, duration, frames, distinctFrames: new Set(frames.map(f=>f.sha256)).size, originalSha256: before, originalUnchanged: true };
}
async function main() {
  const [root, expected, ...files] = process.argv.slice(2);
  if (!root || !files.length || files.length > 4) throw new Error('usage: runtime-root expected-manifest-sha256 local-file [up-to-four]');
  const runtime = await verifyRuntime(root, expected), results = [];
  for (const file of files) results.push(await inspect(runtime, file));
  console.log(JSON.stringify({ outcome: 'NATIVE_READ_ONLY_PROBE_AND_TEMPORAL_FRAME_PASS', manifestSha256: runtime.manifestSha256, applicationIntegrated: false, playbackValidated: false, sourceFilesWritten: false, profileOpened: false, results }, null, 2));
}
if (require.main === module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = { verifyRuntime, inspect };
