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
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use ring::signature::{Ed25519KeyPair, KeyPair};
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
                publisher_approved: false,
                expected_revision: 0,
            },
        )
        .unwrap()
    }
    fn sign(mut package: store::Package, seed: u8) -> store::Package {
        let key = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
        let mut bytes = b"luckyray-package-v1\0".to_vec();
        bytes.extend(serde_json::to_vec(&serde_json::json!({"manifest":package.manifest,"resource":package.resource})).unwrap());
        package.signature = Some(store::PackageSignature {
            version: 1,
            public_key: BASE64.encode(key.public_key().as_ref()),
            signature: BASE64.encode(key.sign(&bytes).as_ref()),
        });
        package
    }
    #[test]
    fn verified_publisher_continues_and_impostor_or_tampering_preserves_old_package() {
        let root = root("publisher");
        let first = sign(package(), 1);
        let req = |package, publisher_approved, expected_revision| store::Request::Install { package, publisher_approved, expected_revision };
        assert_eq!(store::manage(&root,"1.9.2",req(first.clone(),false,0)).unwrap_err(),"extension-publisher-approval-required");
        let state = store::manage(&root,"1.9.2",req(first.clone(),true,0)).unwrap();
        assert_eq!(state.packages[0].trusted_publisher.as_ref(), Some(&first.signature.as_ref().unwrap().public_key));
        let mut next = package(); next.manifest.version = "1.0.1".into();
        let next = sign(next,1);
        let state = store::manage(&root,"1.9.2",store::Request::Update { package: next.clone(), publisher_approved:false, expected_revision:state.revision }).unwrap();
        let mut forged = next.clone(); forged.manifest.version = "1.0.2".into();
        assert_eq!(store::manage(&root,"1.9.2",store::Request::Update { package: forged, publisher_approved:true, expected_revision:state.revision }).unwrap_err(),"extension-signature-invalid");
        let mut changed = package(); changed.manifest.version = "1.0.2".into();
        let changed = sign(changed,2);
        assert_eq!(store::manage(&root,"1.9.2",store::Request::Update { package: changed.clone(), publisher_approved:false, expected_revision:state.revision }).unwrap_err(),"extension-publisher-approval-required");
        let unchanged = store::manage(&root,"1.9.2",store::Request::List).unwrap();
        assert_eq!(serde_json::to_value(&state).unwrap(),serde_json::to_value(&unchanged).unwrap());
        let changed_state = store::manage(&root,"1.9.2",store::Request::Update { package: changed.clone(), publisher_approved:true, expected_revision:state.revision }).unwrap();
        assert_eq!(changed_state.packages[0].trusted_publisher.as_ref(),Some(&changed.signature.unwrap().public_key));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_update_requires_choice_and_retains_owned_data_without_inheriting_grants() {
        let root = root("legacy-publisher");
        let first: store::Package = serde_json::from_value(serde_json::json!({
            "manifest":{"schemaVersion":1,"apiVersion":1,"id":"test.legacy","name":"Fixture","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["materials"],"optionalModules":[]},
            "resource":{"code":"LuckyRay.register(()=>null)","requiredPermissions":["materials.read"],"optionalPermissions":[],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"panel"}]}
        })).unwrap();
        let state = store::manage(&root,"1.9.2",store::Request::Install { package:first.clone(),publisher_approved:false,expected_revision:0 }).unwrap();
        let state = store::manage(&root,"1.9.2",store::Request::Grant { id:"test.legacy".into(),grants:vec!["materials.read".into()],expected_revision:state.revision }).unwrap();
        let state = store::manage(&root,"1.9.2",store::Request::Enable { id:"test.legacy".into(),expected_revision:state.revision }).unwrap();
        let state = store::manage(&root,"1.9.2",store::Request::Data { id:"test.legacy".into(), data:store::PluginData { schema_version:1,revision:1,settings:serde_json::json!({"keep":true}),cache:serde_json::json!({}) }, expected_revision:state.revision }).unwrap();
        let mut next = first; next.manifest.version = "1.0.1".into();
        assert_eq!(store::manage(&root,"1.9.2",store::Request::Update { package:next.clone(),publisher_approved:false,expected_revision:state.revision }).unwrap_err(),"extension-publisher-approval-required");
        assert_eq!(serde_json::to_value(&state).unwrap(),serde_json::to_value(store::manage(&root,"1.9.2",store::Request::List).unwrap()).unwrap());
        let updated = store::manage(&root,"1.9.2",store::Request::Update { package:next,publisher_approved:true,expected_revision:state.revision }).unwrap();
        assert!(!updated.packages[0].enabled && updated.packages[0].grants.is_empty());
        assert_eq!(updated.packages[0].data.as_ref().unwrap().settings["keep"],true);
        std::fs::remove_dir_all(root).unwrap();
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
                    publisher_approved: true,
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
            let state = store::manage(&root,"1.9.2",store::Request::Install { package: package.clone(), publisher_approved:false, expected_revision:0 }).unwrap();
            package.manifest.version = "1.0.1".into();
            let state = store::manage(&root,"1.9.2",store::Request::Update { package, publisher_approved:true, expected_revision:state.revision }).unwrap();
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

#[cfg(test)]
mod desktop_packages {
 use super::store;
 fn package(version:&str)->store::Package{serde_json::from_value(serde_json::json!({"manifest":{"schemaVersion":2,"apiVersion":2,"type":"desktop","entry":"main.js","id":"test.desktop","name":"Trusted fixture","version":version,"minHostVersion":"1.9.8","requiredModules":["workspace"],"optionalModules":[]},"resource":{"code":"export function activate(api) {}","css":"","assets":{},"dataVersion":1,"contributions":[]}})).unwrap()}
 #[test] fn desktop_install_requires_full_trust_and_update_revokes_it(){
  let root=std::env::temp_dir().join(format!("lr-desktop-store-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
  let mut state=store::manage(&root,"1.9.8",store::Request::Install{package:package("1.0.0"),publisher_approved:false,expected_revision:0}).unwrap();
  assert!(!state.packages[0].enabled);assert!(state.packages[0].grants.is_empty());
  assert!(store::manage(&root,"1.9.8",store::Request::Enable{id:"test.desktop".into(),expected_revision:state.revision}).is_err());
  state=store::manage(&root,"1.9.8",store::Request::Grant{id:"test.desktop".into(),grants:vec!["desktop.fullTrust".into()],expected_revision:state.revision}).unwrap();
  state=store::manage(&root,"1.9.8",store::Request::Enable{id:"test.desktop".into(),expected_revision:state.revision}).unwrap();assert!(state.packages[0].enabled);
  state=store::manage(&root,"1.9.8",store::Request::Update{package:package("1.0.1"),publisher_approved:true,expected_revision:state.revision}).unwrap();assert!(!state.packages[0].enabled);assert!(state.packages[0].grants.is_empty());
  let _=std::fs::remove_dir_all(root);
 }
 #[test] fn desktop_resources_reject_path_escape_and_legacy_does_not_gain_modules(){
  let mut p=package("1.0.0");p.resource["assets"]=serde_json::json!({"../escape":{"mimeType":"text/plain","base64":""}});assert!(store::validate(&p).is_err());
  let mut p=package("1.0.0");p.manifest.kind="script".into();p.manifest.api_version=1;p.manifest.required_modules=vec!["filesystem".into()];assert!(!store::compatible(&p,"1.9.8"));
 }
 #[test]
 #[ignore = "requires two local, synthetic SDK-generated package paths"]
 fn sdk_generated_desktop_package_keeps_data_and_revokes_trust_on_update(){
  let read=|name:&str| -> store::Package {serde_json::from_slice(&std::fs::read(std::env::var(name).expect("synthetic fixture path")).unwrap()).unwrap()};
  let first=read("LUCKYRAY_API2_FIXTURE_V1");let next=read("LUCKYRAY_API2_FIXTURE_V2");
  assert_eq!(first.manifest.id,"test.api2-intake");assert_eq!(next.manifest.id,first.manifest.id);
  assert_eq!(first.manifest.version,std::env::var("LUCKYRAY_API2_FIXTURE_V1_VERSION").unwrap_or_else(|_|"1.0.0".into()));
  assert_eq!(next.manifest.version,std::env::var("LUCKYRAY_API2_FIXTURE_V2_VERSION").unwrap_or_else(|_|"1.0.1".into()));
  let root=std::env::temp_dir().join(format!("lr-sdk-api2-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
  std::fs::create_dir(&root).unwrap();
  let mut state=store::manage(&root,"1.9.8",store::Request::Install{package:first,publisher_approved:false,expected_revision:0}).unwrap();
  assert!(!state.packages[0].enabled && state.packages[0].grants.is_empty());
  assert!(store::manage(&root,"1.9.8",store::Request::Enable{id:"test.api2-intake".into(),expected_revision:state.revision}).is_err());
  state=store::manage(&root,"1.9.8",store::Request::Grant{id:"test.api2-intake".into(),grants:vec!["desktop.fullTrust".into()],expected_revision:state.revision}).unwrap();
  state=store::manage(&root,"1.9.8",store::Request::Enable{id:"test.api2-intake".into(),expected_revision:state.revision}).unwrap();
  state=store::manage(&root,"1.9.8",store::Request::Data{id:"test.api2-intake".into(),data:store::PluginData{schema_version:1,revision:1,settings:serde_json::json!({"synthetic":true}),cache:serde_json::json!({})},expected_revision:state.revision}).unwrap();
  assert!(store::manage(&root,"1.9.8",store::Request::Update{package:next.clone(),publisher_approved:false,expected_revision:state.revision}).is_err());
  let unchanged=store::manage(&root,"1.9.8",store::Request::List).unwrap();
  assert_eq!(unchanged.revision,state.revision);assert!(unchanged.packages[0].enabled);
  state=store::manage(&root,"1.9.8",store::Request::Update{package:next,publisher_approved:true,expected_revision:state.revision}).unwrap();
  assert!(!state.packages[0].enabled && state.packages[0].grants.is_empty());
  assert_eq!(state.packages[0].data.as_ref().unwrap().settings["synthetic"],true);
 }
}
