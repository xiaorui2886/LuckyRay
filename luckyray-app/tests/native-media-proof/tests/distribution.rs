//! Exercise the production build gate with synthetic files, never a user profile.
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::atomic::{AtomicUsize, Ordering}};
#[path = "../../../src-tauri/native_video_build.rs"]
#[allow(dead_code)]
mod gate;
fn sha256_file(path: &Path) -> String { format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())) }
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture { root: PathBuf, app: PathBuf, spec: serde_json::Value }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("luckyray-native-dist-{}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert!(!root.exists());
        let app = root.join("app/src-tauri");
        std::fs::create_dir_all(app.join("native-video/licenses")).unwrap();
        std::fs::create_dir_all(root.join("app/third_party/native-video")).unwrap();
        let mut files = serde_json::Map::new();
        for name in ["libmpv-2.dll", "README.md", "LICENSES.md", "RELINK.zh-CN.md", "build-lgpl.sh", "sources.tar.xz", "SOURCE-INDEX.json", "BUILD-INFO.json", "licenses/mpv-LGPL-2.1.txt", "licenses/FFmpeg-LGPL-3.0.txt", "licenses/GPL-3.0.txt"] {
            let path = app.join("native-video").join(name);
            std::fs::write(&path, format!("synthetic:{name}")).unwrap();
            files.insert(name.into(), serde_json::json!({"size":std::fs::metadata(&path).unwrap().len(),"sha256":sha256_file(&path)}));
        }
        let dll = files["libmpv-2.dll"].clone();
        let spec = serde_json::json!({"schemaVersion":2,"status":"audited-local-lgpl-build","redistributionApproved":true,"completeCorrespondingSource":true,"dll":dll,"files":files});
        let f = Self { root, app, spec }; f.save(); f
    }
    fn save(&self) {
        let bytes = serde_json::to_vec(&self.spec).unwrap();
        std::fs::write(self.app.join("native-video/runtime-manifest.json"), &bytes).unwrap();
        std::fs::write(self.root.join("app/third_party/native-video/manifest.json"), &bytes).unwrap();
    }
    fn rejected(&self) { assert!(std::panic::catch_unwind(|| gate::verify(&self.app, "release")).is_err()); }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self.root.file_name().unwrap().to_str().unwrap().starts_with("luckyray-native-dist-"));
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test] fn complete_hash_bound_release_is_accepted() { let f=Fixture::new(); assert_eq!(gate::verify(&f.app,"release").unwrap().1.len(),12); }
#[test] fn missing_corresponding_source_is_rejected() { let f=Fixture::new(); std::fs::remove_file(f.app.join("native-video/sources.tar.xz")).unwrap(); f.rejected(); }
#[test] fn mutated_license_is_rejected() { let f=Fixture::new(); std::fs::write(f.app.join("native-video/licenses/GPL-3.0.txt"),b"changed").unwrap(); f.rejected(); }
#[test] fn extra_runtime_dll_is_rejected() { let f=Fixture::new(); std::fs::write(f.app.join("native-video/extra.dll"),b"not-listed").unwrap(); f.rejected(); }
#[test] fn status_alone_cannot_admit_incomplete_inventory() { let mut f=Fixture::new(); f.spec["files"].as_object_mut().unwrap().remove("SOURCE-INDEX.json"); f.save(); f.rejected(); }
#[test] fn unreviewed_manifest_is_rejected() { let mut f=Fixture::new(); f.spec["redistributionApproved"]=false.into(); f.save(); f.rejected(); }
#[test] fn old_development_dll_cannot_enter_release() { let mut f=Fixture::new(); f.spec["schemaVersion"]=1.into(); f.spec["status"]="local-development-only".into(); f.spec["redistributionApproved"]=false.into(); f.save(); f.rejected(); }
#[test] fn changed_staged_manifest_is_rejected() { let f=Fixture::new(); std::fs::write(f.app.join("native-video/runtime-manifest.json"),b"{}").unwrap(); f.rejected(); }
#[test] fn missing_release_runtime_is_rejected() { let f=Fixture::new(); assert!(std::panic::catch_unwind(|| gate::verify(&f.root.join("missing"),"release")).is_err()); }
