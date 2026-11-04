//! V3 (T48) Linux slice of the owned libmpv client: verified dynamic load and the
//! same LGPL license-mode gate as `mpv.rs` on Windows. Playback/composition on
//! Linux is NOT wired yet (no GTK surface below the WebView), so the player
//! command keeps reporting `native-video-player-unported`. Nothing here takes
//! commands from web content.
//!
//! Mirrors Windows:
//! - exact size + SHA-256 pin of the bundled library (Windows: `DLL_SIZE`/`DLL_SHA256`;
//!   Linux: compile-time `LUCKYRAY_LINUX_LIBMPV_SHA256`/`_SIZE`, absent until V4 ships
//!   a pinned LGPL build, so production refuses with `native-video-runtime-unpinned`);
//! - the library is hashed through one held descriptor and loaded from that same
//!   descriptor (`/proc/self/fd/N`), closing the hash/load race like the Windows
//!   no-write share mode;
//! - the same error codes, the same hardened options, and the same
//!   `-Dgpl=false` check after `mpv_initialize`.
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_void, CStr, CString},
    fs::File,
    io::Read,
    os::unix::{ffi::OsStrExt, fs::MetadataExt, io::{AsRawFd, FromRawFd}},
    path::Path,
};

type Result<T> = std::result::Result<T, String>;
type Handle = *mut c_void;
type Create = unsafe extern "C" fn() -> Handle;
type SetOption = unsafe extern "C" fn(Handle, *const i8, *const i8) -> i32;
type Initialize = unsafe extern "C" fn(Handle) -> i32;
type GetString = unsafe extern "C" fn(Handle, *const i8) -> *mut i8;
type Free = unsafe extern "C" fn(*mut c_void);
type Destroy = unsafe extern "C" fn(Handle);
type Command = unsafe extern "C" fn(Handle, *const *const i8) -> i32;
type RenderCreate = unsafe extern "C" fn(*mut *mut c_void, Handle, *mut RenderParam) -> i32;
type RenderUpdate = unsafe extern "C" fn(*mut c_void) -> u64;
type RenderRender = unsafe extern "C" fn(*mut c_void, *mut RenderParam) -> i32;
type RenderFree = unsafe extern "C" fn(*mut c_void);
type CommandRet = unsafe extern "C" fn(Handle, *const *const i8, *mut Node) -> i32;
type FreeNode = unsafe extern "C" fn(*mut Node);
#[repr(C)]
union NodeValue {
    string: *mut i8,
    integer: i64,
    number: f64,
    list: *mut NodeList,
    bytes: *mut ByteArray,
}
#[repr(C)]
struct Node {
    value: NodeValue,
    format: i32,
}
#[repr(C)]
struct NodeList {
    count: i32,
    values: *mut Node,
    keys: *mut *mut i8,
}
#[repr(C)]
struct ByteArray {
    data: *mut u8,
    size: usize,
}
struct OwnedNode {
    node: Node,
    free: FreeNode,
}
impl Drop for OwnedNode {
    fn drop(&mut self) {
        unsafe { (self.free)(&mut self.node) }
    }
}
impl OwnedNode {
    unsafe fn field(&self, key: &str) -> Result<&Node> {
        if self.node.format != 8 || self.node.value.list.is_null() {
            return Err("native-video-capture-map-invalid".into());
        }
        let list = &*self.node.value.list;
        if !(1..=32).contains(&list.count) || list.values.is_null() || list.keys.is_null() {
            return Err("native-video-capture-map-invalid".into());
        }
        for i in 0..list.count as usize {
            let k = *list.keys.add(i);
            if !k.is_null() && CStr::from_ptr(k).to_bytes() == key.as_bytes() {
                return Ok(&*list.values.add(i));
            }
        }
        Err("native-video-capture-field-missing".into())
    }
    unsafe fn integer(&self, key: &str) -> Result<i64> {
        let n = self.field(key)?;
        if n.format != 4 {
            return Err("native-video-capture-integer-invalid".into());
        }
        Ok(n.value.integer)
    }
}
/// Same shapes as Windows `mpv::Frame` / `mpv::Snapshot`.
pub struct Frame {
    pub time: f64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
#[derive(Debug)]
pub struct Snapshot {
    pub time: f64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub paused: bool,
    pub seeking: bool,
    pub ended: bool,
    pub configured: bool,
    pub avsync: Option<f64>,
    pub hwdec: String,
}
#[repr(C)]
pub struct RenderParam {
    kind: i32,
    data: *mut c_void,
}
// mpv/render.h
const PARAM_INVALID: i32 = 0;
const PARAM_API_TYPE: i32 = 1;
const PARAM_SW_SIZE: i32 = 17;
const PARAM_SW_FORMAT: i32 = 18;
const PARAM_SW_STRIDE: i32 = 19;
const PARAM_SW_POINTER: i32 = 20;
const UPDATE_FRAME: u64 = 1;

/// Relative location inside the app resources, the Linux twin of
/// `native-video/libmpv-2.dll`.
pub const LIBRARY_RELATIVE: &str = "native-video/libmpv.so.2";

#[derive(Clone, Copy)]
pub struct Pin<'a> {
    pub sha256: &'a str,
    pub size: u64,
}

/// The production pin. Only a packaging build that ships a verified LGPL
/// libmpv sets these; otherwise there is no pin and nothing is loaded.
pub fn production_pin() -> Result<Pin<'static>> {
    let sha = option_env!("LUCKYRAY_LINUX_LIBMPV_SHA256").ok_or("native-video-runtime-unpinned")?;
    let size = option_env!("LUCKYRAY_LINUX_LIBMPV_SIZE")
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or("native-video-runtime-unpinned")?;
    if sha.len() != 64 || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("native-video-runtime-unpinned".into());
    }
    Ok(Pin { sha256: sha, size })
}

struct Library(*mut c_void);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            libc::dlclose(self.0);
        }
    }
}

/// Intentionally !Send / !Sync, like the Windows player.
pub struct Player {
    handle: Handle,
    option: SetOption,
    initialize: Initialize,
    get: GetString,
    free: Free,
    destroy: Destroy,
    command: Command,
    render_create: RenderCreate,
    render_update: RenderUpdate,
    render_render: RenderRender,
    render_free: RenderFree,
    command_ret: CommandRet,
    free_node: FreeNode,
    /// Player-owned software render context (freed before the core).
    render_ctx: std::cell::Cell<*mut c_void>,
    _library: Library,
}
/// Proof that `mpv_initialize` ran in render mode AND the LGPL gate passed.
/// Production code can only obtain it from `initialize_render`.
pub struct Licensed(());
impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            let ctx = self.render_ctx.replace(std::ptr::null_mut());
            if !ctx.is_null() {
                (self.render_free)(ctx);
            }
            (self.destroy)(self.handle);
        }
    }
}
fn c(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| "native-video-string-invalid".into())
}
fn check(code: i32) -> Result<()> {
    if code < 0 {
        Err(format!("native-video-engine-error:{code}"))
    } else {
        Ok(())
    }
}

/// Open without following links, then require a regular, non-setuid file owned
/// by root or us that nobody else can write and that carries no xattrs.
fn open_runtime(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err("native-video-runtime-unavailable".into());
    }
    let p = CString::new(path.as_os_str().as_bytes()).map_err(|_| "native-video-runtime-unavailable")?;
    let fd = unsafe { libc::open(p.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err("native-video-runtime-unavailable".into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| "native-video-runtime-unavailable")?;
    let euid = unsafe { libc::geteuid() };
    if !meta.file_type().is_file()
        || (meta.uid() != 0 && meta.uid() != euid)
        || meta.mode() & 0o6022 != 0
    {
        return Err("native-video-runtime-unavailable".into());
    }
    crate::linux_fs::no_attributes(&file).map_err(|_| "native-video-runtime-unavailable")?;
    Ok(file)
}

fn identity(file: &File) -> Result<(u64, u64, i64, i64, u64)> {
    let m = file.metadata().map_err(|_| "native-video-runtime-identity-unavailable")?;
    Ok((m.dev(), m.ino(), m.mtime(), m.ctime(), m.len()))
}

impl Player {
    pub fn load(path: &Path, pin: Pin<'_>) -> Result<Self> {
        let mut file = open_runtime(path)?;
        let before = identity(&file)?;
        if before.4 != pin.size {
            return Err("native-video-runtime-size-invalid".into());
        }
        let mut hash = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|_| "native-video-runtime-unavailable")?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        if format!("{:x}", hash.finalize()) != pin.sha256 {
            return Err("native-video-runtime-hash-invalid".into());
        }
        let via = c(&format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        let raw = unsafe { libc::dlopen(via.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if raw.is_null() {
            return Err("native-video-runtime-load-failed".into());
        }
        let library = Library(raw);
        // The object must be unchanged across hash and load.
        if identity(&file)? != before {
            return Err("native-video-runtime-hash-invalid".into());
        }
        unsafe {
            macro_rules! symbol {
                ($name:literal, $kind:ty) => {{
                    let s = libc::dlsym(library.0, concat!($name, "\0").as_ptr().cast());
                    if s.is_null() {
                        return Err("native-video-api-missing".into());
                    }
                    std::mem::transmute::<*mut c_void, $kind>(s)
                }};
            }
            let create = symbol!("mpv_create", Create);
            let option = symbol!("mpv_set_option_string", SetOption);
            let initialize = symbol!("mpv_initialize", Initialize);
            let get = symbol!("mpv_get_property_string", GetString);
            let free = symbol!("mpv_free", Free);
            let destroy = symbol!("mpv_terminate_destroy", Destroy);
            // Present on Windows' symbol list; required so the same client can grow
            // into playback without a different runtime contract.
            let command = symbol!("mpv_command", Command);
            let render_create = symbol!("mpv_render_context_create", RenderCreate);
            let render_update = symbol!("mpv_render_context_update", RenderUpdate);
            let render_render = symbol!("mpv_render_context_render", RenderRender);
            let render_free = symbol!("mpv_render_context_free", RenderFree);
            let command_ret = symbol!("mpv_command_ret", CommandRet);
            let free_node = symbol!("mpv_free_node_contents", FreeNode);
            let handle = create();
            if handle.is_null() {
                return Err("native-video-create-failed".into());
            }
            Ok(Self { handle, option, initialize, get, free, destroy, command, render_create, render_update, render_render, render_free, command_ret, free_node, render_ctx: std::cell::Cell::new(std::ptr::null_mut()), _library: library })
        }
    }
    fn option(&self, key: &str, value: &str) -> Result<()> {
        let k = c(key)?;
        let v = c(value)?;
        check(unsafe { (self.option)(self.handle, k.as_ptr(), v.as_ptr()) })
    }
    pub fn property(&self, key: &str) -> String {
        let Ok(key) = c(key) else { return String::new() };
        unsafe {
            let p = (self.get)(self.handle, key.as_ptr());
            if p.is_null() {
                return String::new();
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            (self.free)(p.cast());
            s
        }
    }
    fn hardened(&self, render: bool) -> Result<()> {
        self.hardened_mode(render, false)
    }
    fn hardened_mode(&self, render: bool, preview: bool) -> Result<()> {
        for (k, v) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("ytdl", "no"),
            ("sub-auto", "no"),
            ("audio-file-auto", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("input-cursor", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("terminal", "no"),
            // Render mode: frames only reach us through mpv_render_context (the
            // Linux twin of the Windows `wid` child); never a window of mpv's own.
            ("vo", if render { "libmpv" } else { "null" }),
            ("ao", "null"),
            ("audio", "no"),
            ("hwdec", "no"),
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("pause", "yes"),
            ("access-references", "no"),
            ("mute", "yes"),
        ] {
            self.option(k, v)?;
        }
        if preview {
            // Same bounded card preview filter as Windows.
            self.option("vf", "lavfi=[scale=512:512:force_original_aspect_ratio=decrease,fps=15]")?;
        }
        check(unsafe { (self.initialize)(self.handle) })?;
        if !self.property("mpv-configuration").contains("-Dgpl=false") {
            return Err("native-video-runtime-license-mode-invalid".into());
        }
        Ok(())
    }
    /// Same hardened options as Windows minus the surface (`wid`, d3d11), with
    /// no video/audio output, then the same LGPL license-mode check.
    pub fn initialize_headless(&self) -> Result<()> {
        self.hardened(false)
    }
    /// Render-API mode (`vo=libmpv`) for the GTK surface. Returns the only
    /// production path to a `Licensed` token.
    pub fn initialize_render(&self) -> Result<Licensed> {
        self.hardened(true).map(|()| Licensed(()))
    }
    /// Preview twin of Windows `initialize_preview` (silent, bounded).
    pub fn initialize_render_preview(&self) -> Result<Licensed> {
        self.hardened_mode(true, true).map(|()| Licensed(()))
    }
    fn command(&self, args: &[&str]) -> Result<()> {
        let values: Vec<_> = args.iter().map(|v| c(v)).collect::<Result<_>>()?;
        let mut ptrs: Vec<_> = values.iter().map(|v| v.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        check(unsafe { (self.command)(self.handle, ptrs.as_ptr()) })
    }
    /// Same contract as Windows `open_local`: absolute, existing local file only.
    pub fn open_local(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() || !path.is_file() {
            return Err("native-video-local-source-required".into());
        }
        self.command(&["loadfile", &path.to_string_lossy(), "replace"])
    }
    /// Software render context: the pixel source for the GTK surface. Works on
    /// X11, Wayland and headless alike (no GL context needed). Owned by the
    /// player so it is always freed before the core.
    pub fn software_surface(&self, _licensed: &Licensed) -> Result<SoftwareSurface<'_>> {
        if self.render_ctx.get().is_null() {
            let api = c("sw")?;
            let mut params = [
                RenderParam { kind: PARAM_API_TYPE, data: api.as_ptr() as *mut c_void },
                RenderParam { kind: PARAM_INVALID, data: std::ptr::null_mut() },
            ];
            let mut ctx = std::ptr::null_mut();
            check(unsafe { (self.render_create)(&mut ctx, self.handle, params.as_mut_ptr()) })
                .map_err(|_| "native-video-surface-create-failed".to_string())?;
            if ctx.is_null() {
                return Err("native-video-surface-create-failed".into());
            }
            self.render_ctx.set(ctx);
        }
        Ok(SoftwareSurface { player: self })
    }
    pub fn pause(&self, pause: bool) -> Result<()> {
        self.command(&["set", "pause", if pause { "yes" } else { "no" }])
    }
    pub fn seek(&self, time: f64) -> Result<()> {
        if !time.is_finite() || time < 0. || time > 31_536_000. {
            return Err("native-video-time-invalid".into());
        }
        self.command(&["seek", &format!("{time:.9}"), "absolute+exact"])
    }
    pub fn volume(&self, volume: f64, muted: bool) -> Result<()> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("native-video-volume-invalid".into());
        }
        self.command(&["set", "volume", &(volume * 100.).to_string()])?;
        self.command(&["set", "mute", if muted { "yes" } else { "no" }])
    }
    pub fn set_loop(&self, bounds: Option<(f64, f64)>) -> Result<()> {
        if let Some((a, b)) = bounds {
            if !a.is_finite() || !b.is_finite() || a < 0. || b <= a || b > 31_536_000. {
                return Err("native-video-range-invalid".into());
            }
        }
        self.command(&["set", "ab-loop-b", "no"])?;
        self.command(&["set", "ab-loop-a", "no"])?;
        if let Some((a, b)) = bounds {
            self.command(&["set", "ab-loop-a", &a.to_string()])?;
            self.command(&["set", "ab-loop-b", &b.to_string()])?;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        let number = |k| self.property(k).parse::<f64>().ok().filter(|v| v.is_finite());
        Snapshot {
            time: number("time-pos").unwrap_or(0.),
            duration: number("duration").unwrap_or(0.),
            width: number("video-out-params/dw").unwrap_or(0.) as u32,
            height: number("video-out-params/dh").unwrap_or(0.) as u32,
            paused: self.property("pause") == "yes",
            seeking: self.property("seeking") == "yes",
            ended: self.property("eof-reached") == "yes",
            configured: self.property("vo-configured") == "yes",
            avsync: number("avsync"),
            hwdec: self.property("hwdec-current"),
        }
    }
    /// Windows `capture`: the displayed decoder frame, only when settled.
    pub fn capture(&self) -> Result<Frame> {
        let state = self.snapshot();
        if !state.paused || state.seeking || !state.configured {
            return Err("native-video-frame-not-settled".into());
        }
        self.preview_frame()
    }
    /// Windows `preview_frame`: same `screenshot-raw video rgba` checks.
    pub fn preview_frame(&self) -> Result<Frame> {
        let state = self.snapshot();
        if !state.configured {
            return Err("native-video-frame-not-settled".into());
        }
        let args = [c("screenshot-raw")?, c("video")?, c("rgba")?];
        let ptrs = [args[0].as_ptr(), args[1].as_ptr(), args[2].as_ptr(), std::ptr::null()];
        let mut result = OwnedNode { node: Node { value: NodeValue { integer: 0 }, format: 0 }, free: self.free_node };
        check(unsafe { (self.command_ret)(self.handle, ptrs.as_ptr(), &mut result.node) })?;
        unsafe {
            let w = result.integer("w")?;
            let h = result.integer("h")?;
            let stride = result.integer("stride")?;
            if w <= 0 || h <= 0 || w.checked_mul(h).is_none_or(|n| n > 33_177_600) || stride.unsigned_abs() < w as u64 * 4 {
                return Err("native-video-frame-size-invalid".into());
            }
            let format = result.field("format")?;
            if format.format != 1 || format.value.string.is_null() || CStr::from_ptr(format.value.string).to_bytes() != b"rgba" {
                return Err("native-video-frame-format-invalid".into());
            }
            let node = result.field("data")?;
            if node.format != 9 || node.value.bytes.is_null() {
                return Err("native-video-frame-data-invalid".into());
            }
            let data = &*node.value.bytes;
            let extent = (h as u64 - 1)
                .checked_mul(stride.unsigned_abs())
                .and_then(|v| v.checked_add(w as u64 * 4))
                .ok_or("native-video-frame-size-invalid")?;
            if stride < 0 || extent > data.size as u64 || extent > 256 * 1024 * 1024 || data.data.is_null() {
                return Err("native-video-frame-stride-invalid".into());
            }
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h {
                rgba.extend_from_slice(std::slice::from_raw_parts(data.data.add((y * stride) as usize), (w * 4) as usize));
            }
            Ok(Frame { time: state.time, width: w as u32, height: h as u32, rgba })
        }
    }
}

/// Borrowed view of the player's render context.
pub struct SoftwareSurface<'a> {
    player: &'a Player,
}
/// Max surface the GTK side will ever ask for (same ceiling as capture).
const MAX_PIXELS: i64 = 33_177_600;
impl SoftwareSurface<'_> {
    /// True when mpv has a new frame to draw.
    pub fn frame_pending(&self) -> bool {
        unsafe { (self.player.render_update)(self.player.render_ctx.get()) & UPDATE_FRAME != 0 }
    }
    /// Draw the current frame into a tightly packed `bgr0` buffer (cairo RGB24 byte order on little endian).
    pub fn render(&self, width: i32, height: i32) -> Result<Vec<u8>> {
        if width < 1 || height < 1 || i64::from(width) * i64::from(height) > MAX_PIXELS {
            return Err("native-video-frame-size-invalid".into());
        }
        let mut size = [width, height];
        let format = c("bgr0")?;
        let mut stride: usize = width as usize * 4;
        let mut pixels = vec![0u8; stride * height as usize];
        let mut params = [
            RenderParam { kind: PARAM_SW_SIZE, data: size.as_mut_ptr().cast() },
            RenderParam { kind: PARAM_SW_FORMAT, data: format.as_ptr() as *mut c_void },
            RenderParam { kind: PARAM_SW_STRIDE, data: (&mut stride as *mut usize).cast() },
            RenderParam { kind: PARAM_SW_POINTER, data: pixels.as_mut_ptr().cast() },
            RenderParam { kind: PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        check(unsafe { (self.player.render_render)(self.player.render_ctx.get(), params.as_mut_ptr()) })?;
        Ok(pixels)
    }
}

/// Verify, load, initialize and license-check the runtime at `path`.
pub fn probe(path: &Path, pin: Pin<'_>) -> Result<()> {
    Player::load(path, pin)?.initialize_headless()
}

/// Production check used by the capability answer.
pub fn verify_bundled(resource_dir: &Path) -> Result<()> {
    let pin = production_pin()?;
    probe(&resource_dir.join(LIBRARY_RELATIVE), pin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const FAKE: &str = r#"
#include <stdlib.h>
#include <string.h>
static int inited;
void *mpv_create(void){ return calloc(1,1); }
int mpv_set_option_string(void*h,const char*k,const char*v){ (void)h;(void)k;(void)v; return 0; }
int mpv_initialize(void*h){ (void)h; inited=1; return 0; }
char *mpv_get_property_string(void*h,const char*k){ (void)h;
  if(inited && !strcmp(k,"mpv-configuration")) return strdup(CONFIG); return NULL; }
void mpv_free(void*p){ free(p); }
void mpv_terminate_destroy(void*h){ free(h); }
#ifndef MISSING
int mpv_command(void*h,const char**a){ (void)h;(void)a; return 0; }
#endif
int mpv_command_ret(void*h,const char**a,void*n){ (void)h;(void)a;(void)n; return 0; }
void mpv_free_node_contents(void*n){ (void)n; }
static int frames;
int mpv_render_context_create(void**c,void*h,void*p){ (void)h;(void)p; *c=calloc(1,1); return 0; }
unsigned long long mpv_render_context_update(void*c){ (void)c; return frames++ < 3 ? 1 : 0; }
typedef struct { int type; void *data; } P;
int mpv_render_context_render(void*c,P*p){ (void)c; int *sz=0; size_t *st=0; unsigned char *px=0;
  for(;p->type;p++){ if(p->type==17) sz=p->data; if(p->type==19) st=p->data; if(p->type==20) px=p->data; }
  if(!sz||!st||!px) return -18; for(int y=0;y<sz[1];y++) memset(px+y*(*st),0x7f,sz[0]*4); return 0; }
void mpv_render_context_free(void*c){ free(c); }
"#;

    fn root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).expect("mode");
        dir
    }
    fn build(dir: &Path, name: &str, config: &str, missing: bool) -> std::path::PathBuf {
        let src = dir.join(format!("{name}.c"));
        std::fs::write(&src, FAKE).expect("source");
        let out = dir.join(name);
        let mut cmd = Command::new("cc");
        cmd.args(["-shared", "-fPIC", "-o"]).arg(&out).arg(&src)
            .arg(format!("-DCONFIG=\"{config}\""));
        if missing {
            cmd.arg("-DMISSING");
        }
        assert!(cmd.status().expect("cc").success(), "synthetic libmpv must build");
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755)).expect("mode");
        out
    }
    fn pin_of(path: &Path) -> (String, u64) {
        let bytes = std::fs::read(path).expect("read");
        (format!("{:x}", Sha256::digest(&bytes)), bytes.len() as u64)
    }

    #[test]
    fn verified_lgpl_runtime_loads_and_passes_the_license_gate() {
        let dir = root();
        let lib = build(dir.path(), "lgpl.so", "-Dlibmpv=true -Dgpl=false", false);
        let (sha, size) = pin_of(&lib);
        probe(&lib, Pin { sha256: &sha, size }).expect("verified LGPL runtime");
    }

    #[test]
    fn gpl_runtime_is_refused_after_initialize_like_windows() {
        let dir = root();
        let lib = build(dir.path(), "gpl.so", "-Dlibmpv=true", false);
        let (sha, size) = pin_of(&lib);
        assert_eq!(probe(&lib, Pin { sha256: &sha, size }).unwrap_err(), "native-video-runtime-license-mode-invalid");
        let player = Player::load(&lib, Pin { sha256: &sha, size }).expect("load");
        assert_eq!(player.initialize_render().err().as_deref(), Some("native-video-runtime-license-mode-invalid"));
    }

    #[test]
    fn pin_mismatches_are_refused_before_anything_is_loaded() {
        let dir = root();
        let lib = build(dir.path(), "lgpl.so", "-Dgpl=false", false);
        let (sha, size) = pin_of(&lib);
        assert_eq!(probe(&lib, Pin { sha256: &sha, size: size + 1 }).unwrap_err(), "native-video-runtime-size-invalid");
        let wrong = "0".repeat(64);
        assert_eq!(probe(&lib, Pin { sha256: &wrong, size }).unwrap_err(), "native-video-runtime-hash-invalid");
    }

    #[test]
    fn missing_symbol_and_unsafe_files_are_refused() {
        let dir = root();
        let lib = build(dir.path(), "partial.so", "-Dgpl=false", true);
        let (sha, size) = pin_of(&lib);
        assert_eq!(probe(&lib, Pin { sha256: &sha, size }).unwrap_err(), "native-video-api-missing");

        let good = build(dir.path(), "good.so", "-Dgpl=false", false);
        let (sha, size) = pin_of(&good);
        let link = dir.path().join("link.so");
        std::os::unix::fs::symlink(&good, &link).expect("symlink");
        assert_eq!(probe(&link, Pin { sha256: &sha, size }).unwrap_err(), "native-video-runtime-unavailable");
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o775)).expect("mode");
        assert_eq!(probe(&good, Pin { sha256: &sha, size }).unwrap_err(), "native-video-runtime-unavailable");
        assert_eq!(probe(Path::new("relative.so"), Pin { sha256: &sha, size }).unwrap_err(), "native-video-runtime-unavailable");
    }

    #[test]
    fn licensed_runtime_renders_software_frames_and_validates_sizes() {
        let dir = root();
        let lib = build(dir.path(), "lgpl.so", "-Dgpl=false", false);
        let (sha, size) = pin_of(&lib);
        let player = Player::load(&lib, Pin { sha256: &sha, size }).expect("load");
        let licensed = player.initialize_render().expect("LGPL render mode");
        let surface = player.software_surface(&licensed).expect("surface");
        assert!(surface.frame_pending());
        let frame = surface.render(8, 4).expect("frame");
        assert_eq!(frame.len(), 8 * 4 * 4);
        assert!(frame.iter().all(|b| *b == 0x7f));
        assert_eq!(surface.render(0, 4).unwrap_err(), "native-video-frame-size-invalid");
        assert_eq!(surface.render(10_000, 10_000).unwrap_err(), "native-video-frame-size-invalid");
        assert_eq!(player.open_local(Path::new("relative.mp4")).unwrap_err(), "native-video-local-source-required");
        assert_eq!(player.open_local(&dir.path().join("absent.mp4")).unwrap_err(), "native-video-local-source-required");
    }

    #[test]
    fn production_has_no_pin_until_a_verified_lgpl_build_ships() {
        if option_env!("LUCKYRAY_LINUX_LIBMPV_SHA256").is_none() {
            assert_eq!(production_pin().err().as_deref(), Some("native-video-runtime-unpinned"));
            assert_eq!(verify_bundled(Path::new("/nonexistent")).unwrap_err(), "native-video-runtime-unpinned");
        }
    }

    /// Live (CI only): the pinned jammy distro libmpv (GPL build) must verify,
    /// load, resolve every symbol, initialize headless, and then be refused by
    /// the license gate exactly like Windows would refuse a GPL DLL.
    #[test]
    #[ignore]
    fn live_pinned_distro_libmpv_loads_and_is_refused_as_gpl() {
        let src = std::env::var_os("LUCKYRAY_LIVE_LIBMPV").expect("LUCKYRAY_LIVE_LIBMPV");
        let dir = root();
        let lib = dir.path().join("libmpv.so.1");
        std::fs::copy(&src, &lib).expect("copy");
        std::fs::set_permissions(&lib, std::fs::Permissions::from_mode(0o755)).expect("mode");
        let pin = Pin {
            sha256: "20bb08e98a4467432794bf1d1bb1aecd4ba5b53e8365da7179899bd047346d7d",
            size: 2_503_552,
        };
        let player = Player::load(&lib, pin).expect("verified distro runtime loads");
        assert_eq!(player.initialize_headless().unwrap_err(), "native-video-runtime-license-mode-invalid");
        assert!(player.property("mpv-version").starts_with("mpv 0.34.1"));
    }

    /// Live (CI only): the pinned distro libmpv renders a real frame of a
    /// synthetic clip through the software render API. The distro build is GPL,
    /// so `initialize_render` MUST refuse it; only this test then mints the
    /// token by hand to exercise the render path. Production never can.
    #[test]
    #[ignore]
    fn live_pinned_distro_libmpv_renders_a_synthetic_frame() {
        let src = std::env::var_os("LUCKYRAY_LIVE_LIBMPV").expect("LUCKYRAY_LIVE_LIBMPV");
        let clip = std::env::var_os("LUCKYRAY_LIVE_CLIP").expect("LUCKYRAY_LIVE_CLIP");
        let dir = root();
        let lib = dir.path().join("libmpv.so.1");
        std::fs::copy(&src, &lib).expect("copy");
        std::fs::set_permissions(&lib, std::fs::Permissions::from_mode(0o755)).expect("mode");
        let pin = Pin {
            sha256: "20bb08e98a4467432794bf1d1bb1aecd4ba5b53e8365da7179899bd047346d7d",
            size: 2_503_552,
        };
        let player = Player::load(&lib, pin).expect("verified distro runtime loads");
        assert_eq!(player.initialize_render().err().as_deref(), Some("native-video-runtime-license-mode-invalid"));
        let licensed = Licensed(());
        let surface = player.software_surface(&licensed).expect("software surface");
        player.open_local(Path::new(&clip)).expect("open synthetic clip");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut lit = 0usize;
        while std::time::Instant::now() < deadline && lit == 0 {
            if surface.frame_pending() {
                let frame = surface.render(64, 48).expect("render");
                lit = frame.chunks(4).filter(|p| p[0] | p[1] | p[2] != 0).count();
            } else {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        assert!(lit > 64 * 48 / 4, "a real testsrc frame must light most pixels, got {lit}");
    }
}
