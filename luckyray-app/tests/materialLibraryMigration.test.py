"""Execute the production migration DDL against disposable real SQLite files.

No access to a LuckyRay profile or media files. Each statement boundary is a
failure injection point; the schema transaction must restore the old database.
"""
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCHEMA = Path(__file__).parents[1] / 'src-tauri/src/materials/library_schema.sql'

def statements():
    pending = ''
    for line in SCHEMA.read_text(encoding='utf8').splitlines(True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    assert not pending.strip()

def fixture(path, count=20):
    c=sqlite3.connect(path)
    c.executescript('''
      CREATE TABLE asset(id TEXT PRIMARY KEY,name TEXT,original_path TEXT,library_path TEXT,storage_mode TEXT,content_hash TEXT,folder_id TEXT,description TEXT);
      CREATE INDEX idx_asset_content_hash ON asset(content_hash);
      CREATE TABLE folder(id TEXT PRIMARY KEY,scope TEXT,parent_id TEXT,name TEXT);
      CREATE TABLE tag(id TEXT PRIMARY KEY,name TEXT UNIQUE,color TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE item_tag(id TEXT PRIMARY KEY,item_type TEXT,item_id TEXT,tag_id TEXT);
      CREATE TABLE material_note_identity(asset_id TEXT PRIMARY KEY,canonical_path TEXT,file_identity TEXT,ordinary INTEGER NOT NULL CHECK(ordinary IN(0,1)));
      CREATE TABLE material_note_vault(asset_id TEXT,vault_id TEXT);
      CREATE TABLE material_note_ref(asset_id TEXT,vault_id TEXT,note_path TEXT,target TEXT);
      CREATE TABLE favorite_item(item_type TEXT,item_id TEXT,theme TEXT,copy TEXT,favorited_at TEXT,note_updated_at TEXT);
      CREATE TABLE smart_folder_definition(id TEXT PRIMARY KEY,name TEXT,source TEXT,criteria_json TEXT);
      CREATE TABLE asset_source_page(asset_id TEXT PRIMARY KEY,page_url TEXT);
      CREATE TABLE backend_schema_migration(version INTEGER PRIMARY KEY,name TEXT);
      CREATE TABLE material_change_state(singleton INTEGER PRIMARY KEY,version INTEGER);
      INSERT INTO material_change_state VALUES(1,0);
      INSERT INTO backend_schema_migration VALUES(23,'companion-services-v1');
      INSERT INTO folder VALUES('root','materials',NULL,'same'),('child','materials','root','child'),('note-folder','notes',NULL,'vault');
      INSERT INTO tag VALUES('t','共享','blue','before','before'),('lower','a',NULL,'before','before'),('upper','A',NULL,'before','before');
      INSERT INTO smart_folder_definition VALUES('smart','search','material','{"query":"existing"}');
    ''')
    for i in range(count):
        c.execute('INSERT INTO asset VALUES(?,?,?,?,?,?,?,?)',(f'a{i}',f'素材{i}',f'original:{i}',f'managed:{i}',('managed','linked','source')[i%3],'same-hash','child','原说明\n保持'))
        c.execute('INSERT INTO item_tag VALUES(?,?,?,?)',(f'it{i}','asset',f'a{i}','t'))
        c.execute('INSERT INTO asset_source_page VALUES(?,?)',(f'a{i}',f'https://example.test/{i}'))
    c.execute("INSERT INTO material_note_identity VALUES('a0','vault/private','file0',0)")
    c.execute("INSERT INTO material_note_identity VALUES('a1','vault/promoted','file1',1)")
    c.execute("INSERT INTO material_note_vault VALUES('a0','vault')")
    c.execute("INSERT INTO material_note_ref VALUES('a0','vault','note.md','private')")
    c.execute("INSERT INTO item_tag VALUES('note-rel','note','note.md','t')")
    c.commit()
    return c

def snapshot(c):
    tables=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {t: c.execute(f'SELECT * FROM "{t}" ORDER BY rowid').fetchall() for t in tables}

def migrate(c,fail=None):
    c.execute('BEGIN IMMEDIATE')
    try:
        for index,statement in enumerate(statements()):
            c.execute(statement)
            if index==fail: raise RuntimeError('injected')
        c.execute("INSERT OR IGNORE INTO backend_schema_migration VALUES(24,'material-libraries-r1')")
        c.commit()
    except Exception:
        c.rollback()
        raise

class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/'fixture.db'
    def tearDown(self): self.tmp.cleanup()

    def test_preserves_every_legacy_field_and_relation_and_excludes_private_attachment(self):
        c=fixture(self.path); before=snapshot(c);migrate(c)
        after=snapshot(c)
        for table,rows in before.items():
            if table!='backend_schema_migration': self.assertEqual(rows,after[table],table)
        legacy,active=c.execute('SELECT legacy_id,active_id FROM material_library_state').fetchone()
        self.assertEqual(legacy,active)
        self.assertEqual({f'a{i}' for i in range(1,20)}, {r[0] for r in c.execute('SELECT asset_id FROM material_library_asset WHERE library_id=?',(legacy,))})
        self.assertEqual({'root','child'},{r[0] for r in c.execute('SELECT folder_id FROM material_library_folder')})
        self.assertEqual({'t','lower','upper'},{r[0] for r in c.execute('SELECT id FROM material_library_tag')})
        c.close()

    def test_each_statement_failure_rolls_back_schema_and_records_and_retry_is_idempotent(self):
        for failure in range(len(list(statements()))):
            path=Path(self.tmp.name)/f'fault-{failure}.db'
            c=fixture(path); before=snapshot(c)
            with self.assertRaises(RuntimeError):migrate(c,failure)
            self.assertEqual(before,snapshot(c),str(failure))
            migrate(c);id1=c.execute('SELECT legacy_id FROM material_library_state').fetchone()
            migrated=snapshot(c);migrate(c)
            self.assertEqual(id1,c.execute('SELECT legacy_id FROM material_library_state').fetchone())
            self.assertEqual(migrated,snapshot(c))
            c.close()

    def test_large_metadata_set_uses_membership_index_and_keeps_all_rows(self):
        c=fixture(self.path,20000);migrate(c)
        self.assertEqual(19999,c.execute('SELECT COUNT(*) FROM material_library_asset').fetchone()[0])
        plan=c.execute('EXPLAIN QUERY PLAN SELECT asset_id FROM material_library_asset WHERE library_id=?',('id',)).fetchall()
        self.assertIn('material_library_asset_lookup',str(plan))
        c.close()

    def test_ordinary_promotion_and_delete_history_and_shared_knowledge_tag(self):
        c=fixture(self.path);migrate(c)
        c.execute("UPDATE material_note_identity SET ordinary=1 WHERE asset_id='a0'")
        self.assertEqual(1,c.execute("SELECT COUNT(*) FROM material_library_asset WHERE asset_id='a0'").fetchone()[0])
        c.execute("UPDATE material_library_tag SET name='素材改名' WHERE id='t'")
        self.assertEqual('共享',c.execute("SELECT name FROM tag WHERE id='t'").fetchone()[0])
        c.execute("DELETE FROM asset WHERE id='a2'")
        self.assertEqual(0,c.execute("SELECT COUNT(*) FROM material_library_asset WHERE asset_id='a2'").fetchone()[0])
        self.assertEqual(1,c.execute("SELECT COUNT(*) FROM material_library_asset_history WHERE asset_id='a2'").fetchone()[0])
        c.close()

if __name__=='__main__':unittest.main(verbosity=2)
