//! Read-only bounded native metadata/thumbnail jobs; shared by cards and filmstrip.
use super::PreviewRequest;
use base64::Engine;
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
#[cfg(target_os = "linux")]
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
static JOBS: OnceLock<Mutex<HashMap<String, (Instant, Arc<AtomicBool>)>>> = OnceLock::new();
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
struct VerifiedTools {
    root: PathBuf,
    dir: PathBuf,
    _pins: Vec<std::fs::File>,
    // Linux read-only descriptors cannot refuse writers the way the Windows
    // share mode does, so every pinned file's identity is captured from its
    // descriptor and compared before each reuse of the verified directory.
    #[cfg(target_os = "linux")]
    stamps: Vec<(PathBuf, Stamp)>,
}
#[cfg(windows)]
const FFMPEG: &str = "ffmpeg.exe";
#[cfg(windows)]
const FFPROBE: &str = "ffprobe.exe";
// Linux runtime layout (T16 manifest: `"ffmpeg":"ffmpeg/ffmpeg"`): no suffix.
// Both must be regular files of the exact, digest-checked inventory.
#[cfg(target_os = "linux")]
const FFMPEG: &str = "ffmpeg";
#[cfg(target_os = "linux")]
const FFPROBE: &str = "ffprobe";
/// Device, inode, size, mtime and ctime. Any in-place write changes ctime and
/// any replacement changes the inode, so a mismatch means "changed since verified".
#[cfg(target_os = "linux")]
#[derive(PartialEq, Eq)]
struct Stamp(u64, u64, u64, i64, i64, i64, i64);
#[cfg(target_os = "linux")]
fn stamp(meta: &std::fs::Metadata) -> Stamp {
    use std::os::unix::fs::MetadataExt;
    Stamp(meta.dev(), meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec(), meta.ctime(), meta.ctime_nsec())
}
#[cfg(target_os = "linux")]
fn unchanged(stamps: &[(PathBuf, Stamp)]) -> bool {
    stamps.iter().all(|(path, pinned)| {
        std::fs::symlink_metadata(path)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink() && stamp(&meta) == *pinned)
    })
}
static TOOLS: OnceLock<Mutex<Option<VerifiedTools>>> = OnceLock::new();
// No playlists, concat scripts, manifests or image sequences that can resolve
// another file. This scope is local video containers, not arbitrary FFmpeg input.
const VIDEO_FORMATS: &str =
    "mov,matroska,webm,avi,asf,flv,mpeg,mpegts,ogg,nut,rm,h264,hevc,av1,m4v";
static CACHE: OnceLock<Mutex<VecDeque<(String, Value, usize)>>> = OnceLock::new();
// Failed device/codec combinations are not retried for every timeline tile.
// Bounded per source revision; never affects covers or playback.
static SOFTWARE_ONLY: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
// 2026-10-23 Windows 4K H264 sample: CPU median 156 ms, DXVA2 auto 484 ms.
// Keep the accepted CPU default; a supported device is not proof of a speedup.
const TIMELINE_HARDWARE_ENABLED: bool = false;
fn timeline_hardware_candidate(metadata: Option<&Value>, cover: bool) -> bool {
    if cover { return false; }
    metadata.is_some_and(|m| {
        m["width"].as_u64().unwrap_or(0).saturating_mul(m["height"].as_u64().unwrap_or(0)) >= 3_686_400
            && matches!(m["codec"].as_str(), Some("h264" | "hevc" | "vp9" | "av1"))
    })
}
fn hardware_allowed(key: &str) -> bool {
    SOFTWARE_ONLY.get_or_init(|| Mutex::new(VecDeque::new())).lock()
        .map(|items| !items.iter().any(|item| item == key)).unwrap_or(false)
}
fn remember_software_only(key: &str) {
    if let Ok(mut items) = SOFTWARE_ONLY.get_or_init(|| Mutex::new(VecDeque::new())).lock() {
        if !items.iter().any(|item| item == key) { items.push_back(key.to_owned()); }
        while items.len() > 32 { items.pop_front(); }
    }
}
struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Job(String);
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(jobs) = JOBS.get() {
            if let Ok(mut jobs) = jobs.lock() {
                jobs.remove(&self.0);
            }
        }
    }
}
pub(super) fn tool_dir(resources: &Path) -> Result<PathBuf, String> {
    let mut cache = TOOLS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "native-video-tools-busy")?;
    if let Some(tools) = &*cache {
        if tools.root == resources {
            #[cfg(target_os = "linux")]
            if !unchanged(&tools.stamps) {
                // Drop the pins; the next request verifies from scratch.
                *cache = None;
                return Err("native-video-tools-changed".into());
            }
            return Ok(tools.dir.clone());
        }
    }
    let tools = crate::media_transfer::verified_local_video_tools(resources)?;
    let mut pins = Vec::new();
    #[cfg(windows)]
    for entry in std::fs::read_dir(&tools).map_err(|_| "native-video-tools-unavailable")? {
        let path = entry.map_err(|_| "native-video-tools-unavailable")?.path();
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("dll") || e.eq_ignore_ascii_case("exe"))
        {
            pins.push(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(path)
                    .map_err(|_| "native-video-tools-unavailable")?,
            );
        }
    }
    // Linux (T45 V1): the verified inventory is the authority. Pin every
    // regular file of the verified tool directory (tools and any shared
    // libraries beside them) through an O_NOFOLLOW read-only descriptor and
    // record its identity from that descriptor. No PATH lookup.
    #[cfg(target_os = "linux")]
    let mut stamps = Vec::new();
    #[cfg(target_os = "linux")]
    for entry in std::fs::read_dir(&tools).map_err(|_| "native-video-tools-unavailable")? {
        let path = entry.map_err(|_| "native-video-tools-unavailable")?.path();
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| "native-video-tools-unavailable")?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        let pin = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| "native-video-tools-unavailable")?;
        let pinned = pin.metadata().map_err(|_| "native-video-tools-unavailable")?;
        stamps.push((path, stamp(&pinned)));
        pins.push(pin);
    }
    #[cfg(target_os = "linux")]
    for name in [FFMPEG, FFPROBE] {
        if !stamps.iter().any(|(path, _)| path.file_name().is_some_and(|n| n == name)) {
            return Err("native-video-tools-unavailable".into());
        }
    }
    // Revalidate after locking executable dependencies, closing validation/use
    // races. Pins remain alive for this process; repeated thumbnail jobs reuse it.
    if crate::media_transfer::verified_local_video_tools(resources)? != tools {
        return Err("native-video-tools-changed".into());
    }
    // A write between the first digest and the pin is caught by the second
    // verification; any write after the pin changes the recorded ctime.
    #[cfg(target_os = "linux")]
    if !unchanged(&stamps) {
        return Err("native-video-tools-changed".into());
    }
    *cache = Some(VerifiedTools {
        root: resources.to_owned(),
        dir: tools.clone(),
        _pins: pins,
        #[cfg(target_os = "linux")]
        stamps,
    });
    Ok(tools)
}
/// End only the process group this call created. Windows keeps child.kill();
/// Linux kills its own pgid (never group 0, never a foreign process).
#[cfg(target_os = "linux")]
fn stop_child(child: &mut std::process::Child) {
    let pgid = child.id() as i32;
    if pgid > 1 {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.wait();
}

fn run(exe: &Path, args: &[String], cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    run_before(exe, args, cancel, Instant::now() + Duration::from_secs(8))
}
fn run_before(exe: &Path, args: &[String], cancel: &AtomicBool, deadline: Instant) -> Result<Vec<u8>, String> {
    if Instant::now() >= deadline { return Err("native-video-preview-timeout".into()); }
    if cancel.load(Ordering::Acquire) {
        return Err("native-video-preview-cancelled".into());
    }
    #[cfg(windows)]
    let mut child = Command::new(exe)
        .args(args)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "native-video-tool-start-failed")?;
    // Linux: a private process group, a cleared environment with only the
    // fixed minimum, and stdio that cannot leak unrelated descriptors. Rust
    // opens its own files CLOEXEC, so no unrelated fd is inherited.
    #[cfg(target_os = "linux")]
    let mut child = Command::new(exe)
        .args(args)
        .process_group(0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "native-video-tool-start-failed")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("native-video-tool-output-unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let mut failure = None;
    loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            failure = Some(if cancel.load(Ordering::Acquire) {
                "native-video-preview-cancelled"
            } else {
                "native-video-preview-timeout"
            });
            #[cfg(windows)]
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "linux")]
            stop_child(&mut child);
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    failure = Some("native-video-decode-unavailable");
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                failure = Some("native-video-tool-wait-failed");
                #[cfg(windows)]
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                #[cfg(target_os = "linux")]
                stop_child(&mut child);
                break;
            }
        }
    }
    let bytes = reader
        .join()
        .map_err(|_| "native-video-output-worker-failed")?
        .map_err(|_| "native-video-tool-output-failed")?;
    if let Some(error) = failure {
        return Err(error.into());
    }
    if bytes.len() > 1024 * 1024 {
        return Err("native-video-tool-output-limit".into());
    }
    Ok(bytes)
}
fn cached(key: &str) -> Option<Value> {
    let mut c = CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .ok()?;
    let i = c.iter().position(|(k, _, _)| k == key)?;
    let entry = c.remove(i)?;
    let result = entry.1.clone();
    c.push_back(entry);
    Some(result)
}
fn retain(key: String, value: &Value) {
    if let Ok(mut c) = CACHE.get_or_init(|| Mutex::new(VecDeque::new())).lock() {
        let size = value.to_string().len();
        c.push_back((key, value.clone(), size));
        while c.len() > 160 || c.iter().map(|x| x.2).sum::<usize>() > 12 * 1024 * 1024 {
            c.pop_front();
        }
    }
}
fn parse_metadata(bytes: &[u8], revision: &str) -> Result<Value, String> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| "native-video-metadata-invalid")?;
    let video = raw["streams"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["codec_type"] == "video"))
        .ok_or("native-video-stream-missing")?;
    let mut width = video["width"].as_u64().unwrap_or(0);
    let mut height = video["height"].as_u64().unwrap_or(0);
    if width == 0 || height == 0 || width > 32768 || height > 32768 || width * height > 132_710_400
    {
        return Err("native-video-dimensions-unsupported".into());
    }
    let duration = raw["format"]["duration"]
        .as_str()
        .or_else(|| video["duration"].as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0. && *d <= 31_536_000.)
        .ok_or("native-video-duration-invalid")?;
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|a| a.iter().find_map(|s| s["rotation"].as_f64()))
        .unwrap_or(0.);
    if ((rotation.abs() % 180.) - 90.).abs() < 1. {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(
        json!({"width":width,"height":height,"duration":duration,"codec":video["codec_name"].as_str().unwrap_or("unknown"),"sourceRevision":revision}),
    )
}
pub(super) fn request(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: PreviewRequest,
) -> Result<Value, String> {
    let id = match &request {
        PreviewRequest::Metadata { job, .. }
        | PreviewRequest::Thumbnail { job, .. }
        | PreviewRequest::Cancel { job } => job,
    };
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("native-video-preview-job-invalid".into());
    }
    let flag = {
        let mut jobs = JOBS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "native-video-preview-busy")?;
        jobs.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(30));
        if jobs.len() >= 64 && !jobs.contains_key(id) {
            return Err("native-video-preview-busy".into());
        }
        let entry = jobs
            .entry(id.clone())
            .or_insert_with(|| (Instant::now(), Arc::new(AtomicBool::new(false))));
        entry.1.clone()
    };
    if matches!(request, PreviewRequest::Cancel { .. }) {
        flag.store(true, Ordering::Release);
        return Ok(json!({"cancelled":true}));
    }
    let _job = Job(id.clone());
    if ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 2).then_some(n + 1)
        })
        .is_err()
    {
        return Err("native-video-preview-busy".into());
    }
    let _permit = Permit;
    let (library, asset, expected, seconds, cover) = match request {
        PreviewRequest::Metadata {
            library_id,
            asset_id,
            ..
        } => (library_id, asset_id, None, None, false),
        PreviewRequest::Thumbnail {
            library_id,
            asset_id,
            revision,
            seconds,
            cover,
            ..
        } => (library_id, asset_id, Some(revision), Some(seconds), cover),
        _ => unreachable!(),
    };
    if seconds.is_some_and(|s| !s.is_finite() || s < 0. || s > 31_536_000.) {
        return Err("native-video-time-invalid".into());
    }
    let catalog = crate::material_catalog_in_library(&app, &caller, Some(&library))?;
    let (path, revision) = catalog
        .native_video_identity(&asset)
        .map_err(crate::encode_material_catalog_command_error)?;
    if expected.as_ref().is_some_and(|v| v != &revision) {
        return Err("native-video-source-changed".into());
    }
    #[cfg(windows)]
    let _source = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .map_err(|_| "native-video-source-unavailable")?;
    // Linux has no share mode; the read-only handle keeps the same inode
    // reachable and, like Windows, follows the catalog's resolved path.
    #[cfg(target_os = "linux")]
    let _source = std::fs::File::open(&path).map_err(|_| "native-video-source-unavailable")?;
    // File identity may have changed between revision lookup and acquiring the
    // read-only pin. Validate once more before trusting even a cache hit.
    catalog
        .native_video_source(&asset, &revision)
        .map_err(crate::encode_material_catalog_command_error)?;
    if flag.load(Ordering::Acquire) {
        return Err("native-video-preview-cancelled".into());
    }
    // Scope and source revision are checked even for a cache hit.
    let key = serde_json::to_string(&(catalog.db_path(), &library, &asset, &revision, seconds, cover))
        .map_err(|_| "native-video-cache-key-invalid")?;
    if let Some(value) = cached(&key) {
        return Ok(value);
    }
    let tools = tool_dir(
        &app.path()
            .resource_dir()
            .map_err(|_| "native-video-resources-unavailable")?,
    )?;
    let source_key = serde_json::to_string(&(catalog.db_path(), &library, &asset, &revision, Option::<f64>::None, false))
        .map_err(|_| "native-video-cache-key-invalid")?;
    let metadata = cached(&source_key);
    let hardware = TIMELINE_HARDWARE_ENABLED && seconds.is_some() && timeline_hardware_candidate(metadata.as_ref(), cover) && hardware_allowed(&source_key);
    let deadline = Instant::now() + Duration::from_secs(8);
    let value = match decode_sized(&tools, &path, &revision, seconds, &flag, cover, hardware, deadline) {
        Ok(value) => value,
        Err(error) if hardware && !flag.load(Ordering::Acquire) => {
            // Hardware availability varies with codec, driver and GPU. A failed
            // attempt falls back to the original software route within the same budget.
            remember_software_only(&source_key);
            if Instant::now() >= deadline { return Err(error); }
            decode_sized(&tools, &path, &revision, seconds, &flag, cover, false, deadline)?
        }
        Err(error) => return Err(error),
    };
    if flag.load(Ordering::Acquire) {
        return Err("native-video-preview-cancelled".into());
    }
    catalog
        .native_video_source(&asset, &revision)
        .map_err(crate::encode_material_catalog_command_error)?;
    retain(key, &value);
    Ok(value)
}
#[cfg(test)]
fn decode(tools: &Path, path: &Path, revision: &str, seconds: Option<f64>, flag: &AtomicBool) -> Result<Value, String> {
    decode_sized(tools, path, revision, seconds, flag, false, false, Instant::now() + Duration::from_secs(8))
}
fn decode_sized(
    tools: &Path,
    path: &Path,
    revision: &str,
    seconds: Option<f64>,
    flag: &AtomicBool,
    cover: bool,
    hardware: bool,
    deadline: Instant,
) -> Result<Value, String> {
    Ok(if let Some(seconds) = seconds {
        let mut args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            "2",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            VIDEO_FORMATS,
            "-ss",
            &format!("{seconds:.6}"),
            "-i",
            &path.to_string_lossy(),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            if cover { "scale=960:960:force_original_aspect_ratio=decrease" } else { "scale=320:180:force_original_aspect_ratio=decrease" },
            "-threads",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "pipe:1",
        ]
        .map(str::to_owned).to_vec();
        if hardware {
            // Input option before -i. Auto uses only devices supported by the
            // pinned FFmpeg build; CPU decode remains the fallback.
            let input = args.iter().position(|arg| arg == "-i").unwrap();
            args.splice(input..input, ["-hwaccel".to_owned(), "auto".to_owned()]);
        }
        let bytes = run_before(&tools.join(FFMPEG), &args, flag, deadline)?;
        if !bytes.starts_with(&[0xff, 0xd8]) {
            return Err("native-video-thumbnail-invalid".into());
        }
        json!({"src":format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)),"time":seconds})
    } else {
        let args=["-v","error","-protocol_whitelist","file,pipe","-format_whitelist",VIDEO_FORMATS,"-show_entries","stream=codec_type,codec_name,width,height,duration:stream_side_data=rotation:format=duration","-of","json","-i",&path.to_string_lossy()].map(str::to_owned);
        parse_metadata(&run(&tools.join(FFPROBE), &args, flag)?, revision)?
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeline_acceleration_is_scoped_to_large_supported_video() {
        assert!(!TIMELINE_HARDWARE_ENABLED, "slower local hardware readback must not become the default");
        assert!(!timeline_hardware_candidate(None, false));
        assert!(!timeline_hardware_candidate(Some(&json!({"width":1920,"height":1080,"codec":"h264"})), false));
        let large = json!({"width":3840,"height":2160,"codec":"hevc"});
        assert!(timeline_hardware_candidate(Some(&large), false));
        assert!(!timeline_hardware_candidate(Some(&large), true));
        assert!(!timeline_hardware_candidate(Some(&json!({"width":3840,"height":2160,"codec":"prores"})), false));
        remember_software_only("test-failed-device");
        assert!(!hardware_allowed("test-failed-device"));
    }
    #[test]
    fn metadata_rejects_audio_only_and_invalid_dimensions() {
        assert!(parse_metadata(
            br#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"2"}}"#,
            "r"
        )
        .is_err());
        assert!(parse_metadata(br#"{"streams":[{"codec_type":"video","width":0,"height":0}],"format":{"duration":"2"}}"#,"r").is_err());
    }
    #[test]
    fn metadata_preserves_rotation_duration_and_revision() {
        let v=parse_metadata(br#"{"streams":[{"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"side_data_list":[{"rotation":-90}]}],"format":{"duration":"127.43"}}"#,"r").unwrap();
        assert_eq!(v["width"], 1080);
        assert_eq!(v["height"], 1920);
        assert_eq!(v["sourceRevision"], "r");
    }
    #[test]
    #[ignore = "requires locally prepared pinned media runtime and existing synthetic H264 fixture"]
    fn prepared_runtime_executes_production_decode_and_cancel() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let tools = tool_dir(root).expect("prepared and pinned runtime");
        let source = root.join("../output/playwright/material-film/landscape.mp4");
        let flag = AtomicBool::new(false);
        let metadata = decode(&tools, &source, "fixture-revision", None, &flag).unwrap();
        assert_eq!(metadata["width"], 640);
        assert_eq!(metadata["height"], 360);
        let frame = decode(&tools, &source, "fixture-revision", Some(2.), &flag).unwrap();
        assert!(frame["src"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        let cover = decode_sized(&tools, &source, "fixture-revision", Some(2.), &flag, true, false, Instant::now() + Duration::from_secs(8)).unwrap();
        let dimensions = |value: &Value| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(value["src"].as_str().unwrap().split(',').nth(1).unwrap()).unwrap();
            let image = image::load_from_memory(&bytes).unwrap();
            (image.width(), image.height())
        };
        assert_eq!(dimensions(&frame), (320, 180));
        assert_eq!(dimensions(&cover), (960, 540));
        flag.store(true, Ordering::Release);
        assert_eq!(
            decode(&tools, &source, "fixture-revision", Some(3.), &flag).unwrap_err(),
            "native-video-preview-cancelled"
        );
        assert_eq!(ACTIVE.load(Ordering::Acquire), 0);
    }

    // T45 V1: Linux-only live smoke. CI prepares a synthetic pinned media
    // runtime and synthetic lavfi videos; the box never installs ffmpeg.
    #[cfg(target_os = "linux")]
    fn live_env(name: &str) -> PathBuf {
        PathBuf::from(
            std::env::var(name)
                .unwrap_or_default(),
        )
    }

    /// Any still-running process whose command line mentions our unique
    /// synthetic input would be a leaked child of the timed-out tool.
    #[cfg(target_os = "linux")]
    fn process_mentions(marker: &str) -> bool {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return false;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(raw) = name.to_str() else { continue };
            if !raw.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            if let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) {
                if cmdline
                    .split(|byte| *byte == 0)
                    .any(|arg| arg == marker.as_bytes())
                {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "needs LUCKYRAY_LIVE_FFMPEG=present, a prepared pinned media runtime and synthetic lavfi videos"]
    fn live_present_ffmpeg_preview() {
        let mode = std::env::var("LUCKYRAY_LIVE_FFMPEG").unwrap_or_default();
        assert!(
            mode == "present",
            "run through the media-preview CI step; LUCKYRAY_LIVE_FFMPEG does not match"
        );
        let resources = live_env("LUCKYRAY_LIVE_MEDIA_RESOURCES");
        let video = live_env("LUCKYRAY_LIVE_MEDIA_VIDEO");
        let audio = live_env("LUCKYRAY_LIVE_MEDIA_AUDIO");
        let long = live_env("LUCKYRAY_LIVE_MEDIA_LONG");
        assert!(
            [&resources, &video, &audio, &long].iter().all(|path| !path.as_os_str().is_empty()),
            "prepared synthetic fixtures are missing"
        );
        let tools = tool_dir(&resources).expect("verified pinned tool directory");
        let (ffmpeg, ffprobe) = (tools.join(FFMPEG), tools.join(FFPROBE));
        assert!(ffmpeg.is_file() && ffprobe.is_file(), "verified tools missing");
        assert_eq!(tool_dir(&resources).as_ref(), Ok(&tools), "unchanged runtime must reuse the pins");

        // a) metadata: dimensions after rotation, duration, source revision.
        let flag = AtomicBool::new(false);
        let metadata = decode(&tools, &video, "t45-revision", None, &flag).expect("ffprobe metadata");
        assert_eq!((metadata["width"].as_u64(), metadata["height"].as_u64()), (Some(180), Some(320)),
            "rotation metadata was not applied to dimensions: {metadata}");
        let duration = metadata["duration"].as_f64().unwrap_or(0.);
        assert!((5.5..=6.5).contains(&duration), "duration {duration} is not the 6 s fixture");
        assert_eq!(metadata["sourceRevision"], "t45-revision");

        // b) decode a real JPEG frame at a requested second.
        let frame = decode(&tools, &video, "t45-revision", Some(1.), &flag).expect("ffmpeg frame decode");
        assert!(frame["src"].as_str().unwrap_or("").starts_with("data:image/jpeg;base64,"),
            "thumbnail is not a JPEG data URL");
        assert_eq!(frame["time"].as_f64(), Some(1.));

        // c) audio-only input is refused as video.
        assert_eq!(decode(&tools, &audio, "t45-revision", None, &flag).err().as_deref(),
            Some("native-video-stream-missing"));

        // d) cancel before start, cancel while running, and timeout; none may
        //    leave a process behind. Realtime input keeps ffmpeg busy.
        let preset = AtomicBool::new(true);
        assert_eq!(decode(&tools, &video, "t45-revision", Some(2.), &preset).err().as_deref(),
            Some("native-video-preview-cancelled"));
        let marker = long.to_string_lossy().to_string();
        let slow = ["-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-i", &marker,
                    "-t", "20", "-f", "null", "-"].map(str::to_owned);
        let no_leak = |what: &str| {
            let mut leaked = process_mentions(&marker);
            for _ in 0..20 {
                if !leaked { break; }
                std::thread::sleep(Duration::from_millis(100));
                leaked = process_mentions(&marker);
            }
            assert!(!leaked, "a {what} tool process survived the process-group kill");
        };
        let running = std::sync::Arc::new(AtomicBool::new(false));
        let trigger = running.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            trigger.store(true, Ordering::Release);
        });
        let started = Instant::now();
        assert_eq!(run_before(&ffmpeg, &slow, &running, started + Duration::from_secs(15)).err().as_deref(),
            Some("native-video-preview-cancelled"));
        canceller.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5), "mid-run cancel was not prompt");
        no_leak("cancelled");
        let started = Instant::now();
        assert_eq!(run_before(&ffmpeg, &slow, &flag, started + Duration::from_millis(400)).err().as_deref(),
            Some("native-video-preview-timeout"));
        assert!(started.elapsed() < Duration::from_secs(5), "deadline was not prompt");
        no_leak("timed-out");

        // e) a write to a pinned, verified tool is refused before reuse, and
        //    the restored runtime is only trusted again after full verification.
        // Restores the tool even when an assertion below panics.
        struct Restore<'a>(&'a Path, Vec<u8>);
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                let _ = std::fs::write(self.0, &self.1);
            }
        }
        let restore = Restore(&ffprobe, std::fs::read(&ffprobe).expect("read verified tool"));
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&ffprobe)
                .expect("verified tool could not be opened for the tamper check");
            file.write_all(b"# tampered\n").expect("tamper write");
        }
        assert_eq!(tool_dir(&resources).err().as_deref(), Some("native-video-tools-changed"));
        assert_eq!(tool_dir(&resources).err().as_deref(), Some("The media resolver is unavailable"),
            "a tampered runtime was re-verified as trusted");
        drop(restore);
        assert_eq!(tool_dir(&resources).as_ref(), Ok(&tools), "restored runtime did not re-verify");
        assert_eq!(ACTIVE.load(Ordering::Acquire), 0);
    }
}
