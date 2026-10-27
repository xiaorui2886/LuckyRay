//! Native notifications only. Saving stays in Catalog; no new import worker or cache.
use super::*;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, OnceLock}};

struct Registration {
    _watcher: RecommendedWatcher,
    database: PathBuf,
    library: Option<String>,
    alive: Arc<Mutex<bool>>,
}
impl Drop for Registration {
    fn drop(&mut self) { if let Ok(mut alive) = self.alive.lock() { *alive = false; } }
}
fn registrations() -> &'static Mutex<HashMap<String, Registration>> {
    static WATCHES: OnceLock<Mutex<HashMap<String, Registration>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

pub(crate) fn start_library_root_watch(
    catalog: &MaterialCatalog, expected_root: &std::path::Path,
    send: impl Fn(Value) + Send + Sync + 'static,
) -> Result<String, String> {
    let root = catalog.library_watch_root().map_err(|e| e.message)?;
    if root != expected_root { return Err("library-watch-root-changed".into()); }
    let watched_root = root.clone();
    let alive = Arc::new(Mutex::new(true));
    let callback_alive = alive.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        // Stop/replacement synchronizes with a callback already inspecting paths,
        // not just callbacks which have not entered yet.
        let Ok(alive) = callback_alive.lock() else { return; };
        if !*alive { return; }
        match result {
            Ok(event) => {
                // Read/access notifications must never cause a feedback loop.
                if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) { return; }
                let rescan = event.need_rescan();
                let paths: Vec<_> = event.paths.iter()
                    .filter(|path| super::library_auto_import::is_library_source_path(&watched_root, path))
                    .map(|p| p.to_string_lossy().into_owned()).collect();
                if rescan || !paths.is_empty() {
                    send(json!({"paths": paths, "rescan": rescan, "detectedAt": chrono::Utc::now().timestamp_millis()}));
                }
            }
            Err(_) => send(json!({"error":"library-watch-notification-failed", "rescan":true, "paths":[]})),
        }
    }).map_err(|e| format!("library-watch-start-failed: {e}"))?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| format!("library-watch-start-failed: {e}"))?;
    let token = format!("{:032x}", rand::random::<u128>());
    let mut watches = registrations().lock().map_err(|_| "library-watch-lock-failed")?;
    // The Main WebView can reload without shutting down the native process.
    // Replace its previous owner registration, never accumulate orphan watchers.
    watches.retain(|_, watch| watch.database != catalog.db_path || watch.library != catalog.library_id);
    watches.insert(token.clone(), Registration {
        _watcher: watcher, database: catalog.db_path.clone(), library: catalog.library_id.clone(), alive,
    });
    Ok(token)
}

pub(crate) fn stop_library_root_watch(catalog: &MaterialCatalog, library_id: &str, token: &str) -> Result<(), String> {
    let mut watches = registrations().lock().map_err(|_| "library-watch-lock-failed")?;
    if let Some(watch) = watches.get(token) {
        if watch.database != catalog.db_path || watch.library.as_deref() != Some(library_id) {
            return Err("library-watch-owner-mismatch".into());
        }
    }
    // Idempotent; never stop a replacement registration by root alone.
    watches.remove(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::{Duration, Instant}};

    #[test]
    fn library_watch_events_real_files_batch_dedupe_stop_and_idle() {
        let base = MaterialCatalog::new_for_test();
        let root = base.app_data_dir().join("事件 中文 空格");
        std::fs::create_dir_all(&root).unwrap();
        let lib = base.create_library("事件测试", &root, "managed").unwrap();
        let catalog = base.for_library(&lib.id).unwrap();
        let root = catalog.library_watch_root().unwrap();
        let (tx,rx) = mpsc::channel();
        let token = start_library_root_watch(&catalog, &root, move |event| { let _=tx.send(event); }).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(900)).is_err(), "idle watcher emits no scan ticks");
        let clock = Instant::now();
        std::fs::write(root.join("single.txt"), "synthetic-one").unwrap();
        let copy_finished = clock.elapsed().as_millis();
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let detected = clock.elapsed().as_millis();
        assert!(!event["paths"].as_array().unwrap().is_empty());
        let paths=vec![root.join("single.txt").to_string_lossy().into_owned()];
        let (first,deferred,_) = catalog.import_stable_library_files(&root,Some(&paths)).unwrap();
        let committed = clock.elapsed().as_millis();
        assert_eq!(first.value.imported_count,1);assert!(deferred.is_empty());
        println!("WATCH_TIMING {{\"case\":\"single\",\"copyFinishedMs\":{copy_finished},\"detectedMs\":{detected},\"committedMs\":{committed}}}");
        let mut batch = Vec::new();
        for i in 0..20 { let path=root.join(format!("batch-{i}.txt"));std::fs::write(&path,format!("batch unique {i}")).unwrap();batch.push(path.to_string_lossy().into_owned()); }
        let batch_start=Instant::now();
        let (result,deferred,_) = catalog.import_stable_library_files(&root,Some(&batch)).unwrap();
        assert_eq!(result.value.imported_count,20);assert!(deferred.is_empty());
        println!("WATCH_TIMING {{\"case\":\"batch20\",\"importMs\":{}}}",batch_start.elapsed().as_millis());
        let (again,_,_)=catalog.import_stable_library_files(&root,Some(&batch)).unwrap();
        assert_eq!(again.value.imported_count,0);assert_eq!(again.value.skipped_duplicate_count,20);assert!(again.change.is_none());
        std::fs::copy(root.join("single.txt"),root.join("duplicate.txt")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/single.txt"),"different content same name").unwrap();
        let names=vec![root.join("duplicate.txt").to_string_lossy().into_owned(),root.join("sub/single.txt").to_string_lossy().into_owned()];
        let (names_result,_,_)=catalog.import_stable_library_files(&root,Some(&names)).unwrap();
        assert_eq!(names_result.value.imported_count,1);assert_eq!(names_result.value.skipped_duplicate_count,1);
        assert_eq!(catalog.list_assets(&Default::default()).unwrap().len(),22);
        // Source containment checks apply even when event paths are supplied by JS.
        assert!(!super::super::library_auto_import::is_library_source_path(&root,&root.join("../outside.txt")));
        assert!(!super::super::library_auto_import::is_library_source_path(&root,&root.join("assets/generated.txt")));
        assert!(stop_library_root_watch(&base,"other-library",&token).is_err());
        let (replacement_tx, replacement_rx) = mpsc::channel();
        let replacement = start_library_root_watch(&catalog, &root, move |event| { let _ = replacement_tx.send(event); }).unwrap();
        // A stale frontend dispose must not stop the replacement watcher.
        stop_library_root_watch(&base,&lib.id,&token).unwrap();while rx.try_recv().is_ok() {}
        std::fs::write(root.join("replacement.txt"),"replacement notification").unwrap();
        assert!(replacement_rx.recv_timeout(Duration::from_secs(3)).is_ok());
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        stop_library_root_watch(&base,&lib.id,&replacement).unwrap();
        while replacement_rx.try_recv().is_ok() {}
        std::fs::write(root.join("off.txt"),"not imported").unwrap();
        let late = replacement_rx.recv_timeout(Duration::from_millis(900));
        assert!(late.is_err(), "notification after completed stop: {late:?}");
        assert_eq!(catalog.list_assets(&Default::default()).unwrap().len(),22);
    }

    #[test]
    #[cfg(windows)]
    fn library_watch_events_wait_for_large_copy_writer_even_during_pause() {
        use std::io::Write;
        let base=MaterialCatalog::new_for_test();let root=base.app_data_dir().join("large-copy");
        std::fs::create_dir_all(&root).unwrap();
        let lib=base.create_library("copy",&root,"managed").unwrap();let catalog=base.for_library(&lib.id).unwrap();
        let root=catalog.library_watch_root().unwrap();
        let path=root.join("large.bin");let paths=vec![path.to_string_lossy().into_owned()];
        let mut writer=std::fs::File::create(&path).unwrap();
        let chunk=vec![0x43u8;4*1024*1024];writer.write_all(&chunk).unwrap();writer.flush().unwrap();
        for _ in 0..2 {
            let (result,pending,_)=catalog.import_stable_library_files(&root,Some(&paths)).unwrap();
            assert_eq!(result.value.imported_count,0);assert_eq!(pending,paths);
            assert!(catalog.list_assets(&Default::default()).unwrap().is_empty());
        }
        for _ in 0..15 {writer.write_all(&chunk).unwrap();}writer.sync_all().unwrap();drop(writer);
        let finished=Instant::now();
        let (result,pending,_)=catalog.import_stable_library_files(&root,Some(&paths)).unwrap();
        assert_eq!(result.value.imported_count,1);assert!(pending.is_empty());
        assert_eq!(result.value.assets[0].size_bytes,Some(64*1024*1024));
        println!("WATCH_TIMING {{\"case\":\"large64MiB\",\"copyCompleteToCommitMs\":{}}}",finished.elapsed().as_millis());
        let (again,_,_)=catalog.import_stable_library_files(&root,Some(&paths)).unwrap();
        assert_eq!(again.value.imported_count,0);assert_eq!(again.value.skipped_duplicate_count,1);
    }
}
