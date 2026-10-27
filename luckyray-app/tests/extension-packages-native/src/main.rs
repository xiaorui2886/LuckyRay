#[path = "../../../src-tauri/src/extension_packages_store.rs"]
mod store;
fn main() {
    use std::io::{self, BufRead};
    let root = std::env::args().nth(1).expect("fixture root required");
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<store::Request>(&s).map_err(|e| e.to_string()))
            .and_then(|r| store::manage(std::path::Path::new(&root), "1.9.2", r));
        println!(
            "{}",
            match result {
                Ok(value) => serde_json::json!({"ok":value}),
                Err(error) => serde_json::json!({"error":error}),
            }
        );
    }
}

#[cfg(test)]
mod tests {
    use super::store;
    use rusqlite::Connection;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
        time::{SystemTime, UNIX_EPOCH},
    };
    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lr-package-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn package() -> store::Package {
        serde_json::from_str(include_str!(
            "../../../examples/extensions/paper-sage.lrpack.json"
        ))
        .unwrap()
    }
    fn install(root: &PathBuf) -> store::State {
        store::manage(
            root,
            "1.9.2",
            store::Request::Install {
                package: package(),
                expected_revision: 0,
            },
        )
        .unwrap()
    }
    #[test]
    fn actual_sqlite_write_failure_preserves_enabled_old_package_and_revision() {
        let root = root("rollback");
        install(&root);
        let before = store::manage(
            &root,
            "1.9.2",
            store::Request::Enable {
                id: package().manifest.id,
                expected_revision: 1,
            },
        )
        .unwrap();
        let db = Connection::open(root.join("extension-packages-v0/packages.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER reject_write BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'fixture disk write failure'); END;").unwrap();
        let mut next = package();
        next.manifest.version = "1.0.1".into();
        next.resource["tokens"]["--theme-app-bg"] = "#112233".into();
        assert_eq!(
            store::manage(
                &root,
                "1.9.2",
                store::Request::Update {
                    package: next,
                    expected_revision: 2
                }
            )
            .unwrap_err(),
            "extension-write-failed"
        );
        let after = store::manage(&root, "1.9.2", store::Request::List).unwrap();
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn non_script_update_and_legacy_epoch_remain_readable_without_list_writes() {
        for kind in ["theme", "template"] {
            let root = root(kind);
            let mut package = if kind == "theme" { package() } else {
                serde_json::from_value(serde_json::json!({
                    "manifest": {"schemaVersion":0,"apiVersion":0,"id":"test.template","name":"Template","version":"1.0.0","type":"template","entry":"template.json","minHostVersion":"1.9.2","requiredModules":["knowledge"],"optionalModules":[]},
                    "resource":{"markdown":"# Example","parameters":{}}
                })).unwrap()
            };
            let state = store::manage(&root,"1.9.2",store::Request::Install { package: package.clone(), expected_revision:0 }).unwrap();
            package.manifest.version = "1.0.1".into();
            let state = store::manage(&root,"1.9.2",store::Request::Update { package, expected_revision:state.revision }).unwrap();
            assert_eq!(state.packages[0].epoch,0);
            assert_eq!(store::manage(&root,"1.9.2",store::Request::List).unwrap().revision,state.revision);
            let db = Connection::open(root.join("extension-packages-v0/packages.sqlite3")).unwrap();
            let mut legacy = serde_json::to_value(&state).unwrap();
            legacy["packages"][0]["epoch"] = state.revision.into();
            let payload = serde_json::to_string(&legacy).unwrap();
            db.execute("UPDATE state SET payload=?1",[&payload]).unwrap();
            let read = store::manage(&root,"1.9.2",store::Request::List).unwrap();
            assert_eq!(read.packages[0].epoch,0);
            assert_eq!(read.packages[0].package.manifest.version,"1.0.1");
            let unchanged:String = db.query_row("SELECT payload FROM state",[],|row|row.get(0)).unwrap();
            assert_eq!(unchanged,payload,"List must not rewrite a legacy record");
            legacy["packages"][0]["epoch"] = (state.revision+1).into();
            db.execute("UPDATE state SET payload=?1",[serde_json::to_string(&legacy).unwrap()]).unwrap();
            assert_eq!(store::manage(&root,"1.9.2",store::Request::List).unwrap_err(),"extension-storage-corrupt");
            legacy["packages"][0]["epoch"] = state.revision.into();
            legacy["packages"][0]["grants"] = serde_json::json!(["materials.read"]);
            db.execute("UPDATE state SET payload=?1",[serde_json::to_string(&legacy).unwrap()]).unwrap();
            assert_eq!(store::manage(&root,"1.9.2",store::Request::List).unwrap_err(),"extension-storage-corrupt");
            legacy["packages"][0]["grants"] = serde_json::json!([]);
            legacy["packages"][0]["data"] = serde_json::json!({"schemaVersion":1,"revision":1,"settings":{}});
            db.execute("UPDATE state SET payload=?1",[serde_json::to_string(&legacy).unwrap()]).unwrap();
            assert_eq!(store::manage(&root,"1.9.2",store::Request::List).unwrap_err(),"extension-storage-corrupt");
            drop(db);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn corrupt_digest_fails_without_overwriting_database() {
        let root = root("integrity");
        install(&root);
        let db = Connection::open(root.join("extension-packages-v0/packages.sqlite3")).unwrap();
        let original: String = db
            .query_row("SELECT payload FROM state", [], |r| r.get(0))
            .unwrap();
        let mut corrupt: serde_json::Value = serde_json::from_str(&original).unwrap();
        corrupt["packages"][0]["digest"] = "tampered".into();
        let payload = serde_json::to_string(&corrupt).unwrap();
        db.execute("UPDATE state SET payload=?1", [&payload])
            .unwrap();
        assert_eq!(
            store::manage(&root, "1.9.2", store::Request::List).unwrap_err(),
            "extension-integrity-mismatch"
        );
        let actual: String = db
            .query_row("SELECT payload FROM state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(actual, payload);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn simultaneous_mutations_use_one_revision_winner() {
        let root = root("concurrent");
        install(&root);
        let gate = Arc::new(Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    store::manage(
                        &root,
                        "1.9.2",
                        store::Request::Enable {
                            id: package().manifest.id,
                            expected_revision: 1,
                        },
                    )
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| r
                    .as_ref()
                    .is_err_and(|e| e == "extension-revision-conflict"))
                .count(),
            1
        );
        assert_eq!(
            store::manage(&root, "1.9.2", store::Request::List)
                .unwrap()
                .revision,
            2
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
