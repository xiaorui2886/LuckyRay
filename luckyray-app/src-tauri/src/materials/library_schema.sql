-- Applied inside the backend's IMMEDIATE schema transaction. No media IO.
CREATE TABLE IF NOT EXISTS material_library(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT,
 storage_mode TEXT NOT NULL DEFAULT 'managed' CHECK(storage_mode IN ('managed','linked','source')),
 visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','creating')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, preferences_json TEXT NOT NULL DEFAULT '{}',
 version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS material_library_root ON material_library(root_path) WHERE root_path IS NOT NULL;
-- Commit intent before the identity file. Restart finishes only this owned job.
CREATE TABLE IF NOT EXISTS material_library_creation(
 library_id TEXT PRIMARY KEY REFERENCES material_library(id),root_path TEXT NOT NULL UNIQUE
);
-- A transaction carries new object scope; it never reads active_id. The insert
-- trigger consumes intent atomically, so no provisional default-library event.
CREATE TABLE IF NOT EXISTS material_library_write_intent(
 kind TEXT NOT NULL CHECK(kind IN('asset','folder')),object_id TEXT NOT NULL,
 library_id TEXT REFERENCES material_library(id),PRIMARY KEY(kind,object_id)
);
CREATE TABLE IF NOT EXISTS material_library_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), legacy_id TEXT NOT NULL REFERENCES material_library(id),
 active_id TEXT NOT NULL REFERENCES material_library(id)
);
INSERT INTO material_library(id,name,created_at,updated_at)
 SELECT 'library-' || lower(hex(randomblob(16))), '默认素材库', strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM material_library_state);
INSERT OR IGNORE INTO material_library_state SELECT 1,id,id FROM material_library ORDER BY created_at,id LIMIT 1;
CREATE TABLE IF NOT EXISTS material_library_asset(
 asset_id TEXT PRIMARY KEY REFERENCES asset(id), library_id TEXT NOT NULL REFERENCES material_library(id)
);
CREATE INDEX IF NOT EXISTS material_library_asset_lookup ON material_library_asset(library_id,asset_id);
CREATE TABLE IF NOT EXISTS material_library_asset_history(asset_id TEXT PRIMARY KEY,library_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS material_library_folder(
 folder_id TEXT PRIMARY KEY REFERENCES folder(id), library_id TEXT NOT NULL REFERENCES material_library(id)
);
CREATE INDEX IF NOT EXISTS material_library_folder_lookup ON material_library_folder(library_id,folder_id);
-- Separate mutable material tag definitions preserve legacy IDs and knowledge tags.
CREATE TABLE IF NOT EXISTS material_library_tag(
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES material_library(id),name TEXT NOT NULL,color TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS material_library_tag_name ON material_library_tag(library_id,name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS material_library_smart_folder(
 definition_id TEXT PRIMARY KEY,library_id TEXT NOT NULL REFERENCES material_library(id)
);
CREATE INDEX IF NOT EXISTS material_library_smart_lookup ON material_library_smart_folder(library_id,definition_id);
INSERT OR IGNORE INTO material_library_asset
 SELECT a.id,s.legacy_id FROM asset a CROSS JOIN material_library_state s
 WHERE NOT EXISTS(SELECT 1 FROM material_note_identity n WHERE n.asset_id=a.id AND n.ordinary=0);
INSERT OR IGNORE INTO material_library_folder SELECT f.id,s.legacy_id FROM folder f CROSS JOIN material_library_state s WHERE f.scope='materials';
INSERT OR IGNORE INTO material_library_asset_history SELECT asset_id,library_id FROM material_library_asset;
INSERT OR IGNORE INTO material_library_tag SELECT t.id,s.legacy_id,t.name,t.color,t.created_at,t.updated_at FROM tag t CROSS JOIN material_library_state s;
INSERT OR IGNORE INTO material_library_smart_folder SELECT f.id,s.legacy_id FROM smart_folder_definition f CROSS JOIN material_library_state s WHERE f.source='material';
CREATE TRIGGER IF NOT EXISTS material_library_smart_cleanup AFTER DELETE ON smart_folder_definition BEGIN
 DELETE FROM material_library_smart_folder WHERE definition_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_smart_version_insert AFTER INSERT ON material_library_smart_folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id=NEW.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_smart_version_update AFTER UPDATE ON smart_folder_definition BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_smart_folder WHERE definition_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_smart_version_delete AFTER DELETE ON material_library_smart_folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id=OLD.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_favorite_version_insert AFTER INSERT ON favorite_item WHEN NEW.item_type='material' BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=NEW.item_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_favorite_version_update AFTER UPDATE ON favorite_item WHEN NEW.item_type='material' BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=NEW.item_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_favorite_version_delete AFTER DELETE ON favorite_item WHEN OLD.item_type='material' BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=OLD.item_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_default AFTER INSERT ON asset BEGIN
 INSERT INTO material_library_asset SELECT NEW.id,
 CASE WHEN EXISTS(SELECT 1 FROM material_library_write_intent WHERE kind='asset' AND object_id=NEW.id)
 THEN (SELECT library_id FROM material_library_write_intent WHERE kind='asset' AND object_id=NEW.id) ELSE legacy_id END
 FROM material_library_state WHERE NOT EXISTS(SELECT 1 FROM material_library_write_intent WHERE kind='asset' AND object_id=NEW.id AND library_id IS NULL);
 DELETE FROM material_library_write_intent WHERE kind='asset' AND object_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_cleanup AFTER DELETE ON asset BEGIN
 DELETE FROM material_library_asset WHERE asset_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_default AFTER INSERT ON folder WHEN NEW.scope='materials' BEGIN
 INSERT INTO material_library_folder SELECT NEW.id,COALESCE((SELECT library_id FROM material_library_write_intent WHERE kind='folder' AND object_id=NEW.id),legacy_id) FROM material_library_state;
 DELETE FROM material_library_write_intent WHERE kind='folder' AND object_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_cleanup AFTER DELETE ON folder BEGIN
 DELETE FROM material_library_folder WHERE folder_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_attachment_insert AFTER INSERT ON material_note_identity WHEN NEW.ordinary=0 BEGIN
 DELETE FROM material_library_asset WHERE asset_id=NEW.asset_id;
 DELETE FROM material_library_asset_history WHERE asset_id=NEW.asset_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_attachment_update AFTER UPDATE OF ordinary ON material_note_identity BEGIN
 DELETE FROM material_library_asset WHERE asset_id=NEW.asset_id AND NEW.ordinary=0;
 DELETE FROM material_library_asset_history WHERE asset_id=NEW.asset_id AND NEW.ordinary=0;
 INSERT OR IGNORE INTO material_library_asset SELECT NEW.asset_id,legacy_id FROM material_library_state WHERE NEW.ordinary=1;
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_version_insert AFTER INSERT ON material_library_asset BEGIN
 INSERT OR REPLACE INTO material_library_asset_history VALUES(NEW.asset_id,NEW.library_id);
 UPDATE material_library SET version=version+1 WHERE id=NEW.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_version_rebind AFTER UPDATE OF library_id ON material_library_asset BEGIN
 INSERT OR REPLACE INTO material_library_asset_history VALUES(NEW.asset_id,NEW.library_id);
 UPDATE material_library SET version=version+1 WHERE id IN (OLD.library_id,NEW.library_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_version_delete AFTER DELETE ON material_library_asset BEGIN
 UPDATE material_library SET version=version+1 WHERE id=OLD.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_asset_version_update AFTER UPDATE ON asset BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_tag_version_insert AFTER INSERT ON material_library_tag BEGIN
 UPDATE material_library SET version=version+1 WHERE id=NEW.library_id;
 UPDATE material_change_state SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER IF NOT EXISTS material_library_tag_version_update AFTER UPDATE ON material_library_tag BEGIN
 UPDATE material_library SET version=version+1 WHERE id=NEW.library_id;
 UPDATE material_change_state SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER IF NOT EXISTS material_library_tag_version_delete AFTER DELETE ON material_library_tag BEGIN
 UPDATE material_library SET version=version+1 WHERE id=OLD.library_id;
 UPDATE material_change_state SET version=version+1 WHERE singleton=1;
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_version_insert AFTER INSERT ON material_library_folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id=NEW.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_version_rebind AFTER UPDATE ON material_library_folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id IN(NEW.library_id,OLD.library_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_version_update AFTER UPDATE ON folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_folder WHERE folder_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_folder_version_delete AFTER DELETE ON material_library_folder BEGIN
 UPDATE material_library SET version=version+1 WHERE id=OLD.library_id;
END;
CREATE TRIGGER IF NOT EXISTS material_library_tag_relation_insert AFTER INSERT ON item_tag WHEN NEW.item_type='asset' BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=NEW.item_id);
END;
CREATE TRIGGER IF NOT EXISTS material_library_tag_relation_delete AFTER DELETE ON item_tag WHEN OLD.item_type='asset' BEGIN
 UPDATE material_library SET version=version+1 WHERE id=(SELECT library_id FROM material_library_asset WHERE asset_id=OLD.item_id);
END;
