CREATE TABLE companion_service_grant_v27 (
                device_id TEXT NOT NULL REFERENCES companion_device(device_id) ON DELETE CASCADE,
                grant_class TEXT NOT NULL CHECK(grant_class IN ('content.read','content.write','ingest.write','desktop.open')),
                scope_kind TEXT NOT NULL CHECK(scope_kind IN ('catalog','vault')),
                scope_id TEXT NOT NULL,
                granted_at TEXT NOT NULL,
                PRIMARY KEY(device_id,grant_class,scope_kind,scope_id),
                CHECK(scope_kind='catalog' OR length(scope_id)>0)
             );
             INSERT INTO companion_service_grant_v27 SELECT * FROM companion_service_grant;
             DROP TABLE companion_service_grant;
             ALTER TABLE companion_service_grant_v27 RENAME TO companion_service_grant;
             CREATE INDEX idx_companion_service_grant_device ON companion_service_grant(device_id,scope_kind,scope_id);
             CREATE TABLE companion_manual_override (
                device_id TEXT NOT NULL REFERENCES companion_device(device_id) ON DELETE CASCADE,
                grant_class TEXT NOT NULL CHECK(grant_class IN ('content.read','content.write','ingest.write','desktop.open')),
                scope_kind TEXT NOT NULL CHECK(scope_kind IN ('catalog','vault')),
                scope_id TEXT NOT NULL,
                PRIMARY KEY(device_id,grant_class,scope_kind,scope_id)
             );
             CREATE TABLE companion_phone_policy (
                device_id TEXT NOT NULL PRIMARY KEY REFERENCES companion_device(device_id) ON DELETE CASCADE,
                mode TEXT NOT NULL CHECK(mode IN ('manual','trusted'))
             );
             CREATE TABLE companion_service_override (
                device_id TEXT NOT NULL REFERENCES companion_device(device_id) ON DELETE CASCADE,
                grant_class TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                enabled INTEGER NOT NULL CHECK(enabled=0),
                PRIMARY KEY(device_id,grant_class,scope_kind),
                CHECK((scope_kind IN ('catalog','vault') AND grant_class IN ('content.read','content.write','ingest.write','desktop.open')) OR (scope_kind='lsh' AND grant_class='lsh.remote'))
             );
             INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(27,'companion-explicit-phone-trust',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
