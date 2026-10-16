//! Narrow, owned libmpv client. Used by the native worker and the composition proof.
//! Only callers inside this module can issue raw commands; web content cannot.
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_void, CStr, CString},
    fs::OpenOptions,
    io::Read,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    sync::{Mutex, OnceLock},
};
use windows::{
    core::{HSTRING, PCSTR},
    Win32::{
        Foundation::{FreeLibrary, HANDLE, HMODULE},
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
        System::LibraryLoader::*,
    },
};

pub const DLL_SHA256: &str = "1a51f1000450ce97ae99fa44b13bc312ab5335e511bc8ae28ae2d90c78069848";
pub const DLL_SIZE: u64 = 100_487_168;
type Result<T> = std::result::Result<T, String>;
type Handle = *mut c_void;
type Create = unsafe extern "C" fn() -> Handle;
type SetOption = unsafe extern "C" fn(Handle, *const i8, *const i8) -> i32;
type Initialize = unsafe extern "C" fn(Handle) -> i32;
type Command = unsafe extern "C" fn(Handle, *const *const i8) -> i32;
type CommandRet = unsafe extern "C" fn(Handle, *const *const i8, *mut Node) -> i32;
type GetString = unsafe extern "C" fn(Handle, *const i8) -> *mut i8;
type Free = unsafe extern "C" fn(*mut c_void);
type FreeNode = unsafe extern "C" fn(*mut Node);
type Destroy = unsafe extern "C" fn(Handle);
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
struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(self.0);
        }
    }
}
struct OwnedNode {
    node: Node,
    free: FreeNode,
}
impl Drop for OwnedNode {
    fn drop(&mut self) {
        unsafe {
            (self.free)(&mut self.node);
        }
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
// Intentionally !Send / !Sync. Construct, operate and drop on one worker.
pub struct Player {
    handle: Handle,
    _library: Library,
    option: SetOption,
    initialize: Initialize,
    command: Command,
    command_ret: CommandRet,
    get: GetString,
    free: Free,
    free_node: FreeNode,
    destroy: Destroy,
}
impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
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

// Cache verification, not the player. A retained no-write/no-delete file handle
// makes reuse safe by immutable Windows file identity, not path or timestamps.
// Each player still owns/destroys its decoder and unloads the DLL normally.
struct VerifiedRuntime {
    identity: (u32, u32, u32),
    _pin: std::fs::File,
}
static VERIFIED_RUNTIME: OnceLock<Mutex<Option<VerifiedRuntime>>> = OnceLock::new();

fn verify_runtime(file: &mut std::fs::File) -> Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| "native-video-runtime-identity-unavailable")?;
    let identity = (info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow);
    let mut cached = VERIFIED_RUNTIME.get_or_init(|| Mutex::new(None)).lock()
        .map_err(|_| "native-video-runtime-verification-unavailable")?;
    if cached.as_ref().is_some_and(|entry| entry.identity == identity) { return Ok(()); }
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|_| "native-video-runtime-unavailable")?;
        if n == 0 { break; }
        hash.update(&buf[..n]);
    }
    if format!("{:x}", hash.finalize()) != DLL_SHA256 {
        return Err("native-video-runtime-hash-invalid".into());
    }
    *cached = Some(VerifiedRuntime { identity, _pin: file.try_clone().map_err(|_| "native-video-runtime-pin-unavailable")? });
    Ok(())
}
impl Player {
    pub fn load(dll: &Path) -> Result<Self> {
        // Keep a no-write/no-delete handle through LoadLibrary to close the hash/load race.
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(dll)
            .map_err(|_| "native-video-runtime-unavailable")?;
        if file
            .metadata()
            .map_err(|_| "native-video-runtime-unavailable")?
            .len()
            != DLL_SIZE
        {
            return Err("native-video-runtime-size-invalid".into());
        }
        verify_runtime(&mut file)?;
        unsafe {
            let library = Library(
                LoadLibraryExW(
                    &HSTRING::from(dll.as_os_str()),
                    None,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
                .map_err(|_| "native-video-runtime-load-failed")?,
            );
            macro_rules! symbol {
                ($name:literal,$kind:ty) => {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(
                        GetProcAddress(library.0, PCSTR(concat!($name, "\0").as_ptr()))
                            .ok_or("native-video-api-missing")?,
                    )
                };
            }
            let create = symbol!("mpv_create", Create);
            let option = symbol!("mpv_set_option_string", SetOption);
            let initialize = symbol!("mpv_initialize", Initialize);
            let command = symbol!("mpv_command", Command);
            let command_ret = symbol!("mpv_command_ret", CommandRet);
            let get = symbol!("mpv_get_property_string", GetString);
            let free = symbol!("mpv_free", Free);
            let free_node = symbol!("mpv_free_node_contents", FreeNode);
            let destroy = symbol!("mpv_terminate_destroy", Destroy);
            let handle = create();
            if handle.is_null() {
                return Err("native-video-create-failed".into());
            }
            Ok(Self {
                handle,
                _library: library,
                option,
                initialize,
                command,
                command_ret,
                get,
                free,
                free_node,
                destroy,
            })
        }
    }
    fn option(&self, key: &str, value: &str) -> Result<()> {
        let k = c(key)?;
        let v = c(value)?;
        check(unsafe { (self.option)(self.handle, k.as_ptr(), v.as_ptr()) })
    }
    fn command(&self, args: &[&str]) -> Result<()> {
        let values: Vec<_> = args.iter().map(|v| c(v)).collect::<Result<_>>()?;
        let mut ptrs: Vec<_> = values.iter().map(|v| v.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        check(unsafe { (self.command)(self.handle, ptrs.as_ptr()) })
    }
    pub fn property(&self, key: &str) -> String {
        let Ok(key) = c(key) else {
            return String::new();
        };
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
    pub fn initialize(&self, host_window: usize, muted: bool) -> Result<()> {
        self.initialize_mode(host_window, muted, false)
    }
    fn initialize_mode(&self, host_window: usize, muted: bool, preview: bool) -> Result<()> {
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
            ("vo", "gpu-next"),
            ("gpu-api", "d3d11"),
            ("hwdec", "auto-safe"),
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("pause", "yes"),
            ("access-references", "no"),
        ] {
            self.option(k, v)?;
        }
        self.option("wid", &host_window.to_string())?;
        if preview {
            self.option("audio", "no")?;
            self.option("hwdec", "auto-copy")?;
            self.option("screenshot-sw", "yes")?;
            self.option("vf", "lavfi=[scale=512:512:force_original_aspect_ratio=decrease,fps=15]")?;
        }
        self.option("mute", if muted { "yes" } else { "no" })?;
        check(unsafe { (self.initialize)(self.handle) })?;
        if !self.property("mpv-configuration").contains("-Dgpl=false") {
            return Err("native-video-runtime-license-mode-invalid".into());
        }
        Ok(())
    }
    /// Bounded, silent card preview. Decode once; no full-file transcode/cache.
    pub fn initialize_preview(&self, host_window: usize) -> Result<()> {
        self.initialize_mode(host_window, true, true)
    }
    pub fn open_local(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() || !path.is_file() {
            return Err("native-video-local-source-required".into());
        }
        self.command(&["loadfile", &path.to_string_lossy(), "replace"])
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
        let number = |k| {
            self.property(k)
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
        };
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
    /// Capture the decoder's displayed frame, NOT a new approximate FFmpeg seek.
    /// Worker must first pause and wait for any outstanding seek to complete.
    pub fn capture(&self) -> Result<Frame> {
        let state = self.snapshot();
        if !state.paused || state.seeking || !state.configured {
            return Err("native-video-frame-not-settled".into());
        }
        self.preview_frame()
    }
    /// Read the currently decoded frame without changing play/pause state.
    pub fn preview_frame(&self) -> Result<Frame> {
        let state = self.snapshot();
        if !state.configured { return Err("native-video-frame-not-settled".into()); }
        let args = [c("screenshot-raw")?, c("video")?, c("rgba")?];
        let ptrs = [
            args[0].as_ptr(),
            args[1].as_ptr(),
            args[2].as_ptr(),
            std::ptr::null(),
        ];
        let mut result = OwnedNode {
            node: Node {
                value: NodeValue { integer: 0 },
                format: 0,
            },
            free: self.free_node,
        };
        check(unsafe { (self.command_ret)(self.handle, ptrs.as_ptr(), &mut result.node) })?;
        unsafe {
            let w = result.integer("w")?;
            let h = result.integer("h")?;
            let stride = result.integer("stride")?;
            if w <= 0
                || h <= 0
                || w.checked_mul(h).is_none_or(|n| n > 33_177_600)
                || stride.unsigned_abs() < w as u64 * 4
            {
                return Err("native-video-frame-size-invalid".into());
            }
            let format = result.field("format")?;
            if format.format != 1
                || format.value.string.is_null()
                || CStr::from_ptr(format.value.string).to_bytes() != b"rgba"
            {
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
            // Negative stride is documented, but cannot be safely addressed against
            // byte_array base without a defined bottom-row pointer. Refuse it.
            if stride < 0
                || extent > data.size as u64
                || extent > 256 * 1024 * 1024
                || data.data.is_null()
            {
                return Err("native-video-frame-stride-invalid".into());
            }
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            for y in 0..h {
                rgba.extend_from_slice(std::slice::from_raw_parts(
                    data.data.add((y * stride) as usize),
                    (w * 4) as usize,
                ));
            }
            Ok(Frame {
                time: state.time,
                width: w as u32,
                height: h as u32,
                rgba,
            })
        }
    }
}
