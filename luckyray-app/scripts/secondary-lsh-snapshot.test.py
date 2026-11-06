import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("secondary-lsh-snapshot.py")
spec = importlib.util.spec_from_file_location("secondary_lsh_snapshot", path)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        # The test-owned root is checked before TemporaryDirectory may clean it.
        self.parent = Path(os.environ["SECONDARY_SNAPSHOT_TEST_ROOT"]).resolve(strict=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="snapshot-test-", dir=self.parent)
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.assertEqual(self.root.parent, self.parent)
        self.roaming, self.local, self.output = (self.root / name for name in ("roaming", "local", "output"))
        for directory in (self.roaming, self.local, self.output):
            directory.mkdir()
        (self.roaming / "dsh-engine-updates").mkdir()
        (self.roaming / "dsh-engine-updates" / "writer.lock").write_bytes(b"")
        (self.roaming / "session.json").write_bytes(b"synthetic session")
        (self.local / "state.txt").write_bytes(b"synthetic state")
        connection = sqlite3.connect(self.roaming / "synthetic.sqlite3")
        connection.execute("CREATE TABLE synthetic(value TEXT)")
        connection.execute("INSERT INTO synthetic VALUES ('fixture')")
        connection.commit()
        connection.close()
        self.sources = {"roaming": self.roaming, "local": self.local}

    def tearDown(self):
        self.assertEqual(self.root.parent, self.parent)
        self.temporary.cleanup()

    def test_snapshot_verifies_files_and_sqlite_without_touching_sources(self):
        result = snapshot.snapshot_profiles(self.sources, self.output)
        self.assertEqual(result["files"], 3)
        self.assertEqual(result["sqlite"], 1)
        self.assertEqual((self.output / "profiles/roaming/session.json").read_bytes(), b"synthetic session")
        self.assertEqual((self.roaming / "session.json").read_bytes(), b"synthetic session")
        self.assertFalse((self.output / "profiles/roaming/dsh-engine-updates/writer.lock").exists())
        self.assertTrue((self.output / "manifest.json").is_file())

    def test_hardlinked_input_is_refused_and_no_success_manifest_is_written(self):
        os.link(self.roaming / "session.json", self.roaming / "other.json")
        with self.assertRaisesRegex(ValueError, "snapshot-file-unsafe"):
            snapshot.snapshot_profiles(self.sources, self.output)
        self.assertFalse((self.output / "manifest.json").exists())

    def junction(self, name, target):
        link = self.roaming / name
        self.assertTrue(link.parent.resolve().is_relative_to(self.roaming.resolve()))
        self.assertTrue(target.resolve().is_relative_to(self.root))
        result = subprocess.run([r'C:\Windows\System32\cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(target)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertEqual(result.returncode, 0, 'synthetic junction creation failed')
        return link

    def test_inspection_records_internal_cycle_without_following_or_allowing_snapshot(self):
        import json
        link = self.junction('synthetic-loop', self.roaming)
        try:
            result = snapshot.inspect_reparse(self.sources, self.output)
            self.assertEqual(result, {'entries': 1, 'internal': 1, 'external': 0, 'other': 0})
            report = json.loads((self.output / 'reparse-report.private.json').read_text(encoding='utf-8'))
            self.assertFalse(report['targetsFollowed'])
            self.assertFalse(report['profileFileContentsRead'])
            self.assertEqual(report['entries'][0]['relation'], 'same-root')
            self.assertEqual(report['entries'][0]['kind'], 'junction')
            with self.assertRaisesRegex(ValueError, 'snapshot-reparse-refused'):
                snapshot.snapshot_profiles(self.sources, self.output)
            self.assertFalse((self.output / 'manifest.json').exists())
        finally:
            os.rmdir(link)  # Remove only the test junction, never its target.

    def test_inspection_classifies_external_and_other_secondary_roots_without_traversal(self):
        import json
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'must-not-be-enumerated.txt').write_bytes(b'synthetic')
        external = self.junction('synthetic-external', outside)
        cross_root = self.junction('synthetic-local', self.local)
        try:
            result = snapshot.inspect_reparse(self.sources, self.output)
            self.assertEqual(result, {'entries': 2, 'internal': 1, 'external': 1, 'other': 0})
            report = json.loads((self.output / 'reparse-report.private.json').read_text(encoding='utf-8'))
            self.assertEqual({entry['relation'] for entry in report['entries']}, {'outside-secondary-roots', 'other-secondary-root'})
            self.assertEqual(report['regularFilesSeen'], 4)
        finally:
            os.rmdir(external)
            os.rmdir(cross_root)

    def test_unknown_reparse_is_recorded_without_readlink_or_file_contents(self):
        import contextlib
        import json
        from types import SimpleNamespace
        scan = os.scandir
        def metadata_scan(directory):
            if Path(directory) != self.roaming:
                return scan(directory)
            with scan(directory) as iterator:
                entries = list(iterator)
            wrapped = []
            for entry in entries:
                if entry.name == 'session.json':
                    wrapped.append(SimpleNamespace(name=entry.name, path=entry.path,
                        stat=lambda **_: SimpleNamespace(st_file_attributes=snapshot.REPARSE, st_reparse_tag=0x9000001A),
                        is_symlink=lambda: False))
                else:
                    wrapped.append(entry)
            return contextlib.nullcontext(wrapped)
        with patch.object(snapshot.os, 'scandir', metadata_scan), \
             patch.object(snapshot.os, 'readlink', side_effect=AssertionError('unknown target must not be read')), \
             patch.object(snapshot, 'locked_file', side_effect=AssertionError('profile contents must not be read')):
            result = snapshot.inspect_reparse(self.sources, self.output)
        self.assertEqual(result, {'entries': 1, 'internal': 0, 'external': 0, 'other': 1})
        report = json.loads((self.output / 'reparse-report.private.json').read_text(encoding='utf-8'))
        self.assertIsNone(report['entries'][0]['target'])
        self.assertEqual(report['entries'][0]['relation'], 'unclassified')

    def test_insufficient_disk_reserve_stops_before_copy(self):
        usage = type("Usage", (), {"free": snapshot.FREE_RESERVE_BYTES})()
        with patch.object(snapshot.shutil, "disk_usage", return_value=usage):
            with self.assertRaisesRegex(ValueError, "snapshot-disk-reserve"):
                snapshot.snapshot_profiles(self.sources, self.output)
        self.assertFalse((self.output / "profiles").exists())
        self.assertFalse((self.output / "manifest.json").exists())

    def reviewed_dependency(self):
        modules = self.roaming / 'deepseek-harness/native-state/rc8-v1/profiles/node_modules'
        modules.mkdir(parents=True)
        target = self.root / 'external-runtime-code'
        target.mkdir()
        (target / 'must-not-be-copied.txt').write_bytes(b'external runtime code')
        name = 'deepseek-harness/native-state/rc8-v1/profiles/node_modules/synthetic-package'
        # junction() also verifies that only test-owned paths can be used.
        link = self.junction(name, target)
        return link, target, [{'root': 'roaming', 'path': name, 'kind': 'junction',
                              'tag': '0xa0000003', 'target': os.readlink(link)}]

    def test_reviewed_dependency_links_are_preserved_as_metadata_without_following(self):
        link, target, links = self.reviewed_dependency()
        try:
            (link.parent / 'local-plugin').mkdir()
            (link.parent / 'local-plugin/index.js').write_bytes(b'synthetic local plugin')
            original = snapshot.locked_file
            def no_external_reads(path):
                self.assertFalse(Path(path).is_relative_to(target))
                self.assertNotIn('must-not-be-copied.txt', str(path))
                return original(path)
            with patch.object(snapshot, 'locked_file', no_external_reads):
                result = snapshot.snapshot_profiles(self.sources, self.output, reviewed_links=links)
            self.assertEqual(result['files'], 4)
            self.assertEqual(result['links'], 1)
            manifest = json.loads((self.output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['schema'], 2)
            self.assertEqual(manifest['reparseLinks'], links)
            self.assertFalse(manifest['externalLinkTargetsIncluded'])
            saved = self.output / 'profiles/roaming'
            self.assertFalse((saved / links[0]['path']).exists())
            self.assertEqual((saved / links[0]['path']).parent.joinpath('local-plugin/index.js').read_bytes(), b'synthetic local plugin')
            # Metadata round-trip in an isolated clone, never a live restore.
            restored = self.root / 'restored-link'
            result = subprocess.run([r'C:\Windows\System32\cmd.exe', '/d', '/c', 'mklink', '/J',
                                     str(restored), manifest['reparseLinks'][0]['target']],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            self.assertEqual(result.returncode, 0)
            try:
                self.assertEqual(os.readlink(restored), os.readlink(link))
                self.assertEqual((target / 'must-not-be-copied.txt').read_bytes(), b'external runtime code')
            finally:
                os.rmdir(restored)
        finally:
            os.rmdir(link)

    def test_reviewed_link_target_change_during_copy_is_refused(self):
        link, target, links = self.reviewed_dependency()
        other = self.root / 'different-code'
        other.mkdir()
        original = snapshot.copy_one
        changed = False
        def mutate(source, destination):
            nonlocal changed
            result = original(source, destination)
            if not changed:
                changed = True
                os.rmdir(link)
                self.junction(links[0]['path'], other)
            return result
        try:
            with patch.object(snapshot, 'copy_one', mutate):
                with self.assertRaisesRegex(ValueError, 'snapshot-reviewed-link-mismatch'):
                    snapshot.snapshot_profiles(self.sources, self.output, reviewed_links=links)
            self.assertFalse((self.output / 'manifest.json').exists())
        finally:
            os.rmdir(link)

    def test_link_review_does_not_authorize_other_paths_or_unknown_tags(self):
        link, target, links = self.reviewed_dependency()
        try:
            for field, value in [('path', 'personal-data'), ('path', links[0]['path'] + '/../escape'),
                                 ('root', 'local'), ('tag', '0x9000001a'), ('kind', 'symlink')]:
                record = dict(links[0], **{field: value})
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(ValueError, 'snapshot-reviewed-links-invalid'):
                        snapshot.validate_reviewed_links([record])
            with self.assertRaisesRegex(ValueError, 'snapshot-reviewed-links-invalid'):
                snapshot.validate_reviewed_links(links + links)
            with self.assertRaisesRegex(ValueError, 'snapshot-reviewed-link-missing'):
                record = dict(links[0], path=links[0]['path'] + '-missing')
                snapshot.inventory(self.sources, reviewed_links=links + [record])
        finally:
            os.rmdir(link)

    def test_changed_source_is_refused_after_copy(self):
        original = snapshot.copy_one
        def mutate(source, target):
            result = original(source, target)
            if source.name == "session.json":
                source.write_bytes(b"changed")
            return result
        with patch.object(snapshot, "copy_one", mutate):
            with self.assertRaisesRegex(ValueError, "snapshot-source-bytes-changed"):
                snapshot.snapshot_profiles(self.sources, self.output)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_wal_database_is_verified_with_its_uncheckpointed_content(self):
        # Simulate an interrupted process: the committed WAL remains, but no
        # live writer holds the synthetic file during the offline snapshot.
        program = ("import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                   "c.execute('PRAGMA journal_mode=WAL'); "
                   "c.execute(\"INSERT INTO synthetic VALUES ('wal-only')\"); c.commit(); os._exit(0)")
        subprocess.run([sys.executable, "-c", program, str(self.roaming / "synthetic.sqlite3")], check=True)
        self.assertTrue((self.roaming / "synthetic.sqlite3-wal").exists())
        result = snapshot.snapshot_profiles(self.sources, self.output)
        self.assertEqual(result["sqlite"], 1)
        checked = sqlite3.connect(self.output / "validation/sqlite-00000/database")
        try:
            self.assertEqual(checked.execute("SELECT count(*) FROM synthetic WHERE value='wal-only'").fetchone(), (1,))
        finally:
            checked.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
