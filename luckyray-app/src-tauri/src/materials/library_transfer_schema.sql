-- R2 finite material operations. Same Catalog, never a second live database.
CREATE TABLE IF NOT EXISTS material_library_transfer(
 id TEXT PRIMARY KEY, anchor_library_id TEXT NOT NULL REFERENCES material_library(id),
 kind TEXT NOT NULL CHECK(kind IN('copy','export','restore','move')),
 phase TEXT NOT NULL CHECK(phase IN('prepared','running','failed','cancelled','completed')),
 payload_json TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS material_library_transfer_anchor ON material_library_transfer(anchor_library_id,created_at);
