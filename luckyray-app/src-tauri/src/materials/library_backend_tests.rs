//! Runs through the real BackendServices bootstrap using synthetic profiles only.
use super::*;
use crate::materials::{MaterialBytesInput, MaterialFilter, MaterialImportOptions};
use serde_json::{json, Value};

fn snapshot(connection: &Connection) -> Value {
    let names = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('backend_schema_migration','material_library_transfer') ORDER BY name").unwrap()
        .query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    let mut result = serde_json::Map::new();
    let schema = connection.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'material_library_transfer%' AND name <> 'reject_r2_migration' AND sql IS NOT NULL ORDER BY name").unwrap().query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    result.insert("__existing_schema".into(), json!(schema));
    for name in names {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement
            .query_map([], |r| {
                Ok((0..columns)
                    .map(|i| match r.get_ref(i).unwrap() {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(v) => json!(v),
                        rusqlite::types::ValueRef::Real(v) => json!(v),
                        rusqlite::types::ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                        rusqlite::types::ValueRef::Blob(v) => json!(v),
                    })
                    .collect::<Vec<_>>())
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows.sort_by_key(|v| serde_json::to_string(v).unwrap());
        result.insert(name, json!(rows));
    }
    Value::Object(result)
}

#[test]
fn material_library_r2_real_v24_bootstrap_rollback_upgrade_restart_and_drift() {
    let profile = tempfile::tempdir().unwrap();
    let backend = BackendServices::initialize(profile.path()).unwrap();
    let catalog = backend.material_catalog();
    let root = profile.path().join("第二库");
    std::fs::create_dir(&root).unwrap();
    let library = catalog.create_library("第二库", &root, "managed").unwrap();
    let scoped = catalog.for_library(&library.id).unwrap();
    let asset = scoped
        .import_bytes(
            vec![MaterialBytesInput {
                name: "旧图.png".into(),
                original_path: "https://example.test/old".into(),
                mime_type: "image/png".into(),
                bytes: b"schema24-existing-media".to_vec(),
                description: Some("旧数据".into()),
            }],
            &MaterialImportOptions::default(),
        )
        .unwrap()
        .value
        .assets
        .remove(0);
    catalog.select_library(&library.id).unwrap();
    let media = asset.library_path.clone().unwrap();
    let media_before = std::fs::read(&media).unwrap();
    let identity_before = std::fs::read(root.join("library.json")).unwrap();
    let mut connection = backend.open_write().unwrap();
    connection.execute_batch("DROP TABLE material_library_transfer; DELETE FROM backend_schema_migration WHERE version>=25;").unwrap();
    let before = snapshot(&connection);
    // Fail at the ledger insert, after the actual v25 DDL has run inside bootstrap.
    connection.execute_batch("CREATE TRIGGER reject_r2_migration BEFORE INSERT ON backend_schema_migration WHEN NEW.version=25 BEGIN SELECT RAISE(ABORT,'injected-r2-ledger-failure'); END;").unwrap();
    drop(connection);
    drop(scoped);
    drop(catalog);
    drop(backend);
    let failure = BackendServices::initialize(profile.path()).err().unwrap();
    assert_eq!(failure.code, "backend-migration-record-failed");
    connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT MAX(version) FROM backend_schema_migration",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        24
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='material_library_transfer'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(snapshot(&connection), before);
    connection
        .execute_batch("DROP TRIGGER reject_r2_migration")
        .unwrap();
    drop(connection);
    for _ in 0..2 {
        let upgraded = BackendServices::initialize(profile.path()).unwrap();
        assert_eq!(upgraded.status().schema_version, SCHEMA_VERSION);
        let connection = upgraded.open_read().unwrap();
        assert_eq!(snapshot(&connection), before);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM backend_schema_migration WHERE version=25 AND name='material-library-transfer-r2'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        crate::materials::verify_transfer_schema(&connection).unwrap();
        assert_eq!(
            upgraded.material_catalog().library_state().unwrap().1,
            library.id
        );
        assert!(upgraded
            .material_catalog()
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(
            upgraded
                .material_catalog()
                .for_library(&library.id)
                .unwrap()
                .get_assets(&[asset.id.clone()])
                .unwrap()[0],
            asset
        );
        assert_eq!(std::fs::read(&media).unwrap(), media_before);
        assert_eq!(
            std::fs::read(root.join("library.json")).unwrap(),
            identity_before
        );
    }
    let connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
    connection
        .execute_batch("ALTER TABLE material_library_transfer ADD COLUMN unexpected TEXT")
        .unwrap();
    drop(connection);
    let rejected = BackendServices::initialize(profile.path()).err().unwrap();
    assert_eq!(
        rejected.code,
        "backend-material-library-transfer-schema-invalid"
    );
    let connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
    assert_eq!(snapshot(&connection), before);
    assert_eq!(std::fs::read(media).unwrap(), media_before);
}

// Capture opaque ledger bytes and every explicit index/trigger: migration must
// preserve historical jobs without deserializing/reinterpreting their payloads.
fn transfer_snapshot(c: &Connection) -> Value {
    let schema = c.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='material_library_transfer' ORDER BY type,name").unwrap()
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    let rows = c.prepare("SELECT id,anchor_library_id,kind,phase,payload_json,result_json,created_at,updated_at FROM material_library_transfer ORDER BY id").unwrap()
        .query_map([], |r| (0..8).map(|i| r.get::<_,String>(i)).collect::<Result<Vec<_>,_>>()).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    json!({"schema":schema,"rows":rows})
}
fn downgrade_synthetic_transfer_to_v25(c: &Connection) {
    c.execute_batch("DROP TABLE material_library_transfer; DELETE FROM backend_schema_migration WHERE version>=26;").unwrap();
    c.execute_batch(include_str!("library_transfer_schema_v25.sql")).unwrap();
    c.execute_batch("CREATE INDEX material_library_transfer_existing_phase ON material_library_transfer(phase,updated_at);").unwrap();
    let legacy: String = c.query_row("SELECT legacy_id FROM material_library_state WHERE singleton=1", [], |r| r.get(0)).unwrap();
    for (kind, phase) in [("copy","prepared"),("export","failed"),("restore","completed")] {
        c.execute("INSERT INTO material_library_transfer VALUES(?1,?2,?3,?4,?5,?6,'旧时间','原时间')", rusqlite::params![format!("old-{kind}"),legacy,kind,phase,"{ \"opaque\": \"旧\\n值\" }", "{\"oldResult\":true}"]).unwrap();
    }
}
#[test]
fn material_library_r3_real_v25_upgrade_rolls_back_preserves_ledger_and_restarts() {
    let profile = tempfile::tempdir().unwrap();
    let backend = BackendServices::initialize(profile.path()).unwrap();
    let catalog = backend.material_catalog();
    let root = profile.path().join("真实启动合成第二库"); std::fs::create_dir(&root).unwrap();
    let library = catalog.create_library("升级资料", &root, "managed").unwrap();
    let scoped = catalog.for_library(&library.id).unwrap();
    let asset = scoped.import_bytes(vec![MaterialBytesInput { name:"升级.png".into(), original_path:"https://example.test/upgrade".into(), mime_type:"image/png".into(), bytes:b"v25-original-media".to_vec(), description:Some("原人工描述".into()) }], &MaterialImportOptions::default()).unwrap().value.assets.remove(0);
    catalog.select_library(&library.id).unwrap();
    let media = std::fs::read(asset.library_path.as_ref().unwrap()).unwrap();
    let identity = std::fs::read(root.join("library.json")).unwrap();
    let connection = backend.open_write().unwrap(); downgrade_synthetic_transfer_to_v25(&connection);
    let before = snapshot(&connection); let ledger = transfer_snapshot(&connection);
    connection.execute_batch("CREATE TRIGGER reject_r3_migration BEFORE INSERT ON backend_schema_migration WHEN NEW.version=26 BEGIN SELECT RAISE(ABORT,'injected-after-r3-rebuild'); END;").unwrap();
    drop(connection); drop(scoped); drop(catalog); drop(backend);
    let failure = BackendServices::initialize(profile.path()).err().unwrap();
    assert_eq!(failure.code, "backend-migration-record-failed");
    let connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
    assert_eq!(connection.query_row("SELECT MAX(version) FROM backend_schema_migration", [], |r| r.get::<_,i64>(0)).unwrap(),25);
    assert_eq!(transfer_snapshot(&connection), ledger, "failed v26 must restore old CHECK, rows and every index");
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name='material_library_transfer_r3'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    connection.execute_batch("DROP TRIGGER reject_r3_migration").unwrap();
    assert_eq!(snapshot(&connection), before); drop(connection);
    let mut migrated_schema = None;
    for _ in 0..2 {
        let upgraded = BackendServices::initialize(profile.path()).unwrap();
        assert_eq!(upgraded.status().schema_version,26);
        let connection = upgraded.open_read().unwrap();
        let upgraded_ledger = transfer_snapshot(&connection);
        assert_eq!(upgraded_ledger["rows"],ledger["rows"]);
        if let Some(schema) = &migrated_schema { assert_eq!(&upgraded_ledger["schema"],schema); }
        migrated_schema = Some(upgraded_ledger["schema"].clone());
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name='material_library_transfer_existing_phase'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM backend_schema_migration WHERE version=26 AND name='material-library-move-r3'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        crate::materials::verify_transfer_schema(&connection).unwrap();
        assert_eq!(snapshot(&connection),before);
        assert_eq!(upgraded.material_catalog().library_state().unwrap().1,library.id);
        assert_eq!(upgraded.material_catalog().for_library(&library.id).unwrap().get_assets(&[asset.id.clone()]).unwrap()[0],asset);
        assert_eq!(std::fs::read(asset.library_path.as_ref().unwrap()).unwrap(),media);
        assert_eq!(std::fs::read(root.join("library.json")).unwrap(),identity);
    }
    let connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
    connection.execute_batch("ALTER TABLE material_library_transfer RENAME TO quoted_transfer; ALTER TABLE quoted_transfer RENAME TO material_library_transfer;").unwrap();
    crate::materials::verify_transfer_schema(&connection).unwrap();
    connection.execute_batch("ALTER TABLE material_library_transfer ADD COLUMN unexpected TEXT").unwrap(); drop(connection);
    assert_eq!(BackendServices::initialize(profile.path()).err().unwrap().code,"backend-material-library-transfer-schema-invalid");
}
#[test]
fn material_library_r3_v25_unknown_drift_is_rejected_without_rebuilding_or_recording() {
    for drift in ["ALTER TABLE material_library_transfer ADD COLUMN unexpected TEXT", "DROP INDEX material_library_transfer_anchor; CREATE INDEX material_library_transfer_anchor ON material_library_transfer(kind)"] {
        let profile = tempfile::tempdir().unwrap();
        let backend = BackendServices::initialize(profile.path()).unwrap();
        let connection = backend.open_write().unwrap(); downgrade_synthetic_transfer_to_v25(&connection);
        connection.execute_batch(drift).unwrap(); let before = transfer_snapshot(&connection);
        drop(connection); drop(backend);
        assert_eq!(BackendServices::initialize(profile.path()).err().unwrap().code,"backend-material-library-transfer-migration-failed");
        let connection = open_bootstrap_connection(&profile.path().join("luckyray.db")).unwrap();
        assert_eq!(transfer_snapshot(&connection),before);
        assert_eq!(connection.query_row("SELECT MAX(version) FROM backend_schema_migration",[],|r|r.get::<_,i64>(0)).unwrap(),25);
    }
}
