CREATE TABLE asset (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, original_path TEXT NOT NULL,
                library_path TEXT, storage_mode TEXT NOT NULL DEFAULT 'linked', kind TEXT NOT NULL,
                mime_type TEXT, size_bytes INTEGER, thumbnail_url TEXT, description TEXT,
                rating INTEGER, dominant_color TEXT, folder_id TEXT, imported_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, content_hash TEXT
             );
             CREATE TABLE item_tag (
                id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
                tag_id TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE folder (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE tag (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE favorite_item(item_type TEXT,item_id TEXT,theme TEXT,copy TEXT,favorited_at TEXT,note_updated_at TEXT,PRIMARY KEY(item_type,item_id));
             CREATE TABLE smart_folder_definition(id TEXT PRIMARY KEY,name TEXT,source TEXT,criteria_version INTEGER,criteria_json TEXT,sort TEXT,created_at TEXT,updated_at TEXT);
