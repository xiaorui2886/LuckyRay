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
    _library: Library,
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
            let _ = symbol!("mpv_command", *mut c_void);
            let _ = symbol!("mpv_command_ret", *mut c_void);
            let _ = symbol!("mpv_free_node_contents", *mut c_void);
            let handle = create();
            if handle.is_null() {
                return Err("native-video-create-failed".into());
            }
            Ok(Self { handle, option, initialize, get, free, destroy, _library: library })
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
    /// Same hardened options as Windows minus the surface (`wid`, d3d11), with
    /// no video/audio output, then the same LGPL license-mode check.
    pub fn initialize_headless(&self) -> Result<()> {
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
            ("vo", "null"),
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
        check(unsafe { (self.initialize)(self.handle) })?;
        if !self.property("mpv-configuration").contains("-Dgpl=false") {
            return Err("native-video-runtime-license-mode-invalid".into());
        }
        Ok(())
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
}
