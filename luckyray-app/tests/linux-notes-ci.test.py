"""Offline evidence-gate and owned fixture tests. No GUI/Runner PASS is implied."""
import ast
import copy
import errno
import hashlib
import importlib.util
import io
import http.client
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("notes_ci", Path(__file__).with_name("linux-notes-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def component_unit_payload(source, scripts):
    """Contract input only: never a rendered/native result."""
    raw = {"schemaVersion": 1, "scope": ci.media_layout.SCOPE, "status": "PASS", "source": source,
        "attempts": 1, "browserLaunches": 1, "userNamespaceExitCode": 0, "scriptSha256": scripts["layoutAudit"],
        "fixtureSha256": "a" * 64, "fixtureSourceMatches": True, "mainProductAcceptance": "NOT_RUN", "javascriptError": "NONE",
        "browser": {"version": "Chromium 156.0.8078.0", "sha256": "b" * 64, "bytes": 526511200, "elf": True},
        "sandbox": {"status": "PASS", "namespace": "Yes", "pidNamespaces": "Yes", "networkNamespaces": "Yes", "seccompBpf": "Yes",
            "adequatelySandboxed": True, "securityDisablingFlags": [], "source": "ACTUAL_CHROME_SANDBOX_PAGE"},
        "cleanup": {"processGone": True, "exitCode": 0, "signal": None}, "observations": [], "observationOverflow": False}
    for case in ci.media_layout.CASES:
        for viewport in ci.media_layout.VIEWPORTS:
            for mode in ci.media_layout.MODES:
                raw["observations"].append({"case": case, "mode": mode, "viewport": viewport,
                    "naturalWidth": 32 if case.endswith("small") else 320, "naturalHeight": 24 if case.endswith("small") else 240,
                    "displayWidth": 32 if case.endswith("small") else 320, "displayHeight": 24 if case.endswith("small") else 240,
                    "displaySizeValid": True, "hoverApplied": mode == "hover", "focusWithin": mode == "focus", "controlFocused": mode == "focus",
                    **{name: True for name in ci.media_layout.FLAGS}, "clickedOnce": True, "clickAttempts": 1})
    return {"status": "PASS", "source": source, "scripts": scripts, "attempts": 1, "childExitCode": 0,
            "fixtureSha256": "a" * 64, "observations": raw}


def passing_maintenance():
    """Literal T11 evidence; deliberately not derived from the validator."""
    return {"noteRename": {"method": "REAL_SETTINGS_UI", "inputMethod": "DOM_VALUE_EVENT", "reviewShown": True, "statusComplete": True,
                           "newFileDigestMatches": True, "oldPathGone": True, "noteLinkRewritten": True, "noteOtherwiseUnchanged": True,
                           "productionResolved": True, "materialAssetNoteOnly": True, "newRecords": 1, "tombstones": 1,
                           "materialAssetIdShape": {"before": "NULL", "first": "NULL", "final": "NULL", "waitedSeconds": 20}},
            "rollback": {"method": "REAL_RECOVERY_UI", "recordListed": True, "statusRolledBack": True, "oldFileRestored": True,
                         "noteBytesRestored": True, "renamedCopyRetained": True, "productionResolved": True, "tombstones": 0},
            "materialRename": {"method": "REAL_MATERIAL_CONTEXT_MENU", "inputMethod": "DOM_VALUE_EVENT", "importModeChosenInUi": True,
                               "storageModeSource": True, "oldPathGone": True, "newDigestMatches": True, "sameInode": True,
                               "catalogPathUpdated": True},
            "materialDelete": {"method": "REAL_MATERIAL_CONTEXT_MENU", "choice": "DELETE_SOURCE_FILE", "physicalChoiceOffered": True,
                               "fileGone": True, "catalogRecordGone": True, "quarantineLeftovers": 0},
            "notRun": {"deleteQuarantineIntermediate": "OFFLINE_ONLY", "crashResume": "OFFLINE_ONLY", "legacyConversion": "NOT_RUN",
                       "noteMove": "NOT_RUN", "materialCrossDirectoryMove": "NOT_RUN", "materialInsertCopyPublish": "NOT_RUN"}}


class AttachmentMaintenanceEvidenceTests(unittest.TestCase):
    def setUp(self):
        fixture = EvidenceTests("validate")
        fixture.setUp()
        self.fixture = fixture

    def rejects(self, mutate, code="attachment-maintenance-ui-evidence-missing"):
        raw = copy.deepcopy(self.fixture.raw)
        mutate(raw["attachmentMaintenance"])
        with self.assertRaisesRegex(RuntimeError, code):
            self.fixture.validate(raw)

    def test_full_literal_evidence_passes_and_projection_is_identity(self):
        self.fixture.validate(self.fixture.raw)
        self.assertEqual(ci.bounded_report(self.fixture.raw)["attachmentMaintenance"], passing_maintenance())
        self.assertEqual(ci.expected_maintenance(), passing_maintenance())

    def test_every_flag_false_or_missing_fails(self):
        for section, values in passing_maintenance().items():
            for key, value in values.items():
                if value is True:
                    self.rejects(lambda m, s=section, k=key: m[s].__setitem__(k, False))
                    self.rejects(lambda m, s=section, k=key: m[s].pop(k))
                    self.rejects(lambda m, s=section, k=key: m[s].__setitem__(k, 1))

    def test_counts_and_methods_are_exact(self):
        for section, key, value in (("noteRename", "newRecords", 2), ("noteRename", "newRecords", 0), ("noteRename", "tombstones", 2),
                                    ("noteRename", "tombstones", 0), ("rollback", "tombstones", 1), ("materialDelete", "quarantineLeftovers", 1),
                                    ("noteRename", "method", "SCRIPTED_IPC"), ("materialDelete", "choice", "REMOVE_RECORD_ONLY"),
                                    ("notRun", "noteMove", "PASS"), ("notRun", "crashResume", "NOT_RUN")):
            self.rejects(lambda m, s=section, k=key, v=value: m[s].__setitem__(k, v))
        self.rejects(lambda m: m.pop("rollback"))
        self.rejects(lambda m: m.clear())

    def test_projection_drops_paths_and_unknown_fields(self):
        raw = copy.deepcopy(self.fixture.raw)
        raw["attachmentMaintenance"]["noteRename"]["path"] = "/home/runner/secret"
        raw["attachmentMaintenance"]["noteRename"]["tombstones"] = 10 ** 6
        raw["attachmentMaintenance"]["leak"] = {"token": "x"}
        projected = ci.bounded_report(raw)["attachmentMaintenance"]
        text = json.dumps(projected)
        self.assertNotIn("secret", text)
        self.assertNotIn("leak", projected)
        self.assertIsNone(projected["noteRename"]["tombstones"])
        with self.assertRaisesRegex(RuntimeError, "notes-report-shape-invalid"):
            ci.validate_notes(raw, self.fixture.build, self.fixture.source, self.fixture.scripts)

    def test_smoke_template_starts_unproven(self):
        template = ci.smoke.maintenance_template()
        self.assertNotEqual(ci.bounded_report({"attachmentMaintenance": template})["attachmentMaintenance"], passing_maintenance())
        for name in ci.smoke.MAINTENANCE_FIELDS:
            self.assertFalse(ci.smoke.maintenance_passed(template, name))
            self.assertTrue(ci.smoke.maintenance_passed(passing_maintenance(), name))

    def test_new_checks_phases_actions_and_codes_are_declared(self):
        for name in ("attachmentRenameRewritesNote", "attachmentRenameRollbackUi", "materialFileRenamed", "materialDeleteSourceRemoved"):
            self.assertIn(name, ci.smoke.CHECKS)
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        for phase in set(re.findall(r'phase = "([a-z-]+)"', source)):
            self.assertIn(phase, ci.PHASES)
        for action in set(re.findall(r'action = "([a-z-]+)"', source)):
            self.assertIn(action, ci.smoke.ACTIONS)
        for code in set(re.findall(r'"((?:maintenance|recovery|attachment|material)-[a-z-]+)"\)', source)):
            self.assertIn(code, ci.FAILURES)

    def test_smoke_uses_real_ui_controls_and_reads_only_for_state(self):
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        body = source[source.index('phase = "attachment-rename"'):source.index('phase = "quit"')]
        for text in ("检查引用更新", "确认执行", "回滚引用", "删除源文件并移除", "重命名真实文件",
                     "data-material-context-action=renameFile", "data-material-context-action=delete"):
            self.assertIn(text, body)
        invoked = set(re.findall(r'invoke\("([a-z_]+)"', source[source.index("def resolve(destination)"):source.index("def verify_image_copy")] + body))
        self.assertEqual(invoked, {"knowledge_resolve_attachment", "knowledge_attachment_recovery_summary", "material_catalog_list_assets",
                                   "knowledge_list_attachment_operations"})
        self.assertNotIn(":has(", source)
        self.assertNotIn("/value", body)

    def test_t11_clicks_are_real_guarded_and_open_the_right_sections(self):
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        body = source[source.index('phase = "attachment-rename"'):source.index('phase = "quit"')]
        self.assertIsNone(re.search(r"(?<![_a-z])click\(", body), "T11 must use the guarded real click")
        self.assertNotIn(".click()", source[source.index("CONTROL_PROBE"):source.index("HIT_KINDS")])
        self.assertIn("scrollIntoView({block:'center'", ci.smoke.CONTROL_PROBE)
        self.assertIn('/element/{target}/displayed"', source)
        self.assertLess(body.index("[data-material-submenu=organize]"), body.index("data-material-context-action=renameFile"))
        self.assertLess(body.index(".notes-vault-dialog .editorial-dialog-close"), body.index("location.hash='#materials'"))
        guarded = source[source.index("def guarded("):source.index("def ui_click(")]
        self.assertEqual(guarded.count("command()"), 1)
        self.assertIn("control-not-interactable", ci.FAILURES)

    def test_control_readiness_requires_every_condition(self):
        ready = {"found": True, "displayed": True, "enabled": True, "inViewport": True, "styleVisible": True, "hit": "SELF"}
        self.assertTrue(ci.smoke.control_ready(ready))
        self.assertTrue(ci.smoke.control_ready({**ready, "hit": "DESCENDANT"}))
        for key, value in (("found", False), ("displayed", False), ("displayed", None), ("enabled", False), ("inViewport", False),
                           ("styleVisible", False), ("hit", "BACKDROP"), ("hit", "OTHER_CONTROL"), ("hit", "ANCESTOR"), ("hit", "NONE")):
            self.assertFalse(ci.smoke.control_ready({**ready, key: value}))

    def test_interactability_diagnostic_is_redacted_and_bounded(self):
        state = ci.smoke.interactability({"element": {"x": 1}, "enabled": True, "inViewport": False, "hitKind": "<b>secret</b>",
                                          "styleVisible": True, "text": "/home/runner/x"}, True)
        self.assertEqual(state, {"found": True, "displayed": True, "enabled": True, "inViewport": False, "styleVisible": True, "hit": "NONE",
                                 "hitLabel": "NONE", "hitDialog": "NONE", "geometry": None})
        raw = copy.deepcopy(self.fixture.raw)
        raw["status"] = "FAIL"
        raw["failure"] = {"phase": "attachment-rename", "action": "maintenance-plan", "code": "control-not-interactable",
                          "interactability": {**state, "inViewport": "yes", "path": "/home/runner/secret", "hit": "BACKDROP"}}
        projected = ci.bounded_report(raw)["failure"]
        self.assertEqual(projected["interactability"], {"found": True, "displayed": True, "enabled": True, "inViewport": None,
                                                         "styleVisible": True, "hit": "BACKDROP", "hitLabel": "NONE",
                                                         "hitDialog": "NONE", "geometry": None})
        self.assertEqual(projected["code"], "control-not-interactable")
        self.assertNotIn("secret", json.dumps(projected))

    def test_hit_label_and_dialog_are_fixed_labels(self):
        canary = "/home/runner/secret-canary"
        state = ci.smoke.interactability({"element": {}, "enabled": True, "inViewport": True, "hitKind": "OTHER", "styleVisible": True,
                                          "hitLabel": "MATERIAL_VIEWER", "hitDialog": "素材详情查看器"}, True)
        self.assertEqual((state["hitLabel"], state["hitDialog"]), ("MATERIAL_VIEWER", "VIEWER_DETAIL"))
        state = ci.smoke.interactability({"element": {}, "hitKind": "OTHER", "hitLabel": canary, "hitDialog": canary}, True)
        self.assertEqual((state["hitLabel"], state["hitDialog"]), ("NONE", "OTHER"))
        raw = copy.deepcopy(self.fixture.raw)
        raw["status"] = "FAIL"
        raw["failure"] = {"phase": "material-maintenance", "action": "materials-context", "code": "control-not-interactable",
                          "interactability": {"found": True, "hit": "OTHER", "hitLabel": canary, "hitDialog": canary}}
        projected = ci.bounded_report(raw)["failure"]["interactability"]
        self.assertEqual((projected["hitLabel"], projected["hitDialog"]), ("NONE", "NONE"))
        self.assertNotIn(canary, json.dumps(projected, ensure_ascii=False))
        self.assertIn("hitLabel", ci.smoke.CONTROL_PROBE)
        self.assertNotIn("%s", ci.smoke.CONTROL_PROBE)
        self.assertIn("PAGE_OTHER", ci.smoke.HIT_LABELS)
        # Only visible dialogs count as open.
        self.assertIn("getClientRects().length>0", ci.smoke.DIAGNOSTIC_PROBE)
        # The control is still only ready on SELF/DESCENDANT; labels never relax readiness.
        ready = {"found": True, "displayed": True, "enabled": True, "inViewport": True, "styleVisible": True}
        self.assertFalse(ci.smoke.control_ready({**ready, "hit": "OTHER", "hitLabel": "CONTEXT_MENU"}))

    def test_material_viewer_is_closed_via_its_real_close_button(self):
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        helper = source[source.index("def dismiss_material_viewer("):source.index("def maintenance_status(")]
        self.assertIn('ui_click(".material-viewer-react .qp-close-react")', helper)
        self.assertIn("return !document.querySelector('.material-viewer-react');", helper)
        self.assertNotIn(".click()", helper)
        body = source[source.index('action = "materials-context"'):]
        self.assertEqual(body.count("dismiss_material_viewer()\n        checked_context_click(card)"), 2)
        app = Path(__file__).resolve().parents[1] / "src" / "features" / "materials" / "MaterialsPage.tsx"
        text = app.read_text(encoding="utf-8")
        self.assertIn('className="qp-close-react" onClick={onClose}', text)
        self.assertIn('className={`material-viewer-react ${mode}`}', text)

    def test_context_gesture_viewer_is_a_distinct_failure_with_passive_tap(self):
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        tap = ci.smoke.CONTEXT_GESTURE_TAP
        self.assertIn("passive:true", tap)
        for forbidden in ("preventDefault", "stopPropagation", ".click(", "dispatchEvent"):
            self.assertNotIn(forbidden, tap)
        helper = source[source.index("def checked_context_click("):source.index("def maintenance_status(")]
        self.assertIn("context_click(selector)", helper)
        self.assertIn('"material-viewer-opened-by-context-gesture"', helper)
        self.assertNotIn(".click()", helper)
        self.assertIn("material-viewer-opened-by-context-gesture", ci.FAILURES)
        bounded = ci.smoke.bounded_observed({"viewerOpenedAfter": "CARD_CLICK", "gestureCardClicks": 1, "gestureMenuClicks": 99,
                                             "gestureAuxclicks": "1", "gestureContextmenus": 1, "secret": "/home/x"})
        self.assertEqual(bounded, {"viewerOpenedAfter": "CARD_CLICK", "gestureCardClicks": 1, "gestureMenuClicks": None,
                                   "gestureAuxclicks": None, "gestureContextmenus": 1})
        self.assertEqual(ci.smoke.bounded_observed({"viewerOpenedAfter": "/tmp/leak"}), {"viewerOpenedAfter": "INVALID"})

    def test_context_gesture_is_right_button_only_and_released_off_the_card(self):
        source = Path(__file__).with_name("linux-notes-attachments-smoke.py").read_text()
        helper = source[source.index("    def context_click(selector):"):source.index("    def dismiss_material_viewer():")]
        self.assertIn('{"type": "pointerDown", "button": 2}', helper)
        self.assertIn('{"type": "pointerUp", "button": 2}', helper)
        self.assertNotIn('"button": 0', helper)
        self.assertLess(helper.index('"pointerDown"'), helper.index('"origin": "viewport"'))
        self.assertLess(helper.index('"origin": "viewport"'), helper.index('"pointerUp"'))
        for forbidden in (".click()", "dispatchEvent", "context_click(", "ActionChains"):
            self.assertNotIn(forbidden, helper.replace("def context_click(", ""))
        point = ci.smoke.CONTEXT_RELEASE_POINT
        self.assertIn("!e.contains(h)", point)
        self.assertIn(".asset-ctx-react,[role=dialog]", point)
        for forbidden in (".click(", "dispatchEvent", "focus("):
            self.assertNotIn(forbidden, point)
        self.assertIn("context-release-point-unavailable", ci.FAILURES)
        # The viewer check and passive tap still wrap every context gesture.
        checked = source[source.index("def checked_context_click("):source.index("def maintenance_status(")]
        self.assertIn("CONTEXT_GESTURE_TAP", checked)
        self.assertIn('"material-viewer-opened-by-context-gesture"', checked)
        app = (Path(__file__).resolve().parents[1] / "src" / "features" / "materials" / "MaterialsPage.tsx").read_text(encoding="utf-8")
        self.assertIn("onClick={(event) => onClick(asset, event)}", app)
        self.assertIn("onContextMenu={(event) => onContextMenu(event, asset)}", app)

    def test_asset_id_shape_is_closed_and_redacted(self):
        shape = ci.smoke.asset_id_shape
        self.assertEqual(shape({"materialAssetId": None}, "asset-1"), "NULL")
        self.assertEqual(shape({}, "asset-1"), "NULL")
        self.assertEqual(shape({"materialAssetId": "asset-1"}, "asset-1"), "SAME_AS_ORIGINAL")
        self.assertEqual(shape({"materialAssetId": "asset-2"}, "asset-1"), "NEW_ASSET_PREFIX")
        self.assertEqual(shape({"materialAssetId": "/home/runner/secret"}, "asset-1"), "OTHER")
        bounded = ci.smoke.bounded_asset_id_shape({"first": "asset-9", "final": "NULL", "waitedSeconds": 999, "x": 1})
        self.assertEqual(bounded, {"before": "INVALID", "first": "INVALID", "final": "NULL", "waitedSeconds": None})
        projected = ci.bounded_maintenance({"noteRename": {"materialAssetIdShape": {"first": "SAME_AS_ORIGINAL", "final": "SAME_AS_ORIGINAL", "waitedSeconds": 0}}})
        self.assertNotEqual(projected, ci.expected_maintenance())

    def test_note_only_precondition_requires_pre_rename_null(self):
        # v1.9.9: a dropped image is note-only before the rename too; a string pre-id must fail the expectation.
        expected = ci.expected_maintenance()
        self.assertEqual(expected["noteRename"]["materialAssetIdShape"]["before"], "NULL")
        for before in ("OTHER", "SAME_AS_ORIGINAL"):
            raw = passing_maintenance()
            raw["noteRename"]["materialAssetIdShape"]["before"] = before
            self.assertNotEqual(ci.bounded_maintenance(raw), expected)
        smoke_src = Path(ci.smoke.__file__).read_text()
        self.assertIn('rename["materialAssetNoteOnly"] = (image_identity["materialAssetId"] is None', smoke_src)

    def test_failure_diagnostics_are_closed_and_redacted(self):
        canary = "/home/runner/secret-canary"
        raw = {"maintenanceStatus": "回滚引用变更 · 引用变更已回滚", "openDialog": canary, "oldFile": "MATCH", "newFile": canary,
               "maintenanceAlert": "yes", "recordOptionPresent": True, "recordCount": 99, "tombstones": 1, "path": canary,
               "storageMode": "source", "catalogLibraryPath": canary, "quarantineLeftovers": 0}
        bounded = ci.smoke.bounded_observed(raw)
        self.assertEqual(bounded, {"maintenanceStatus": "INVALID", "openDialog": "INVALID", "storageMode": "source",
                                   "catalogLibraryPath": "INVALID", "oldFile": "MATCH", "newFile": "INVALID",
                                   "maintenanceAlert": None, "recordOptionPresent": True, "recordCount": None,
                                   "tombstones": 1, "quarantineLeftovers": 0})
        self.assertNotIn(canary, json.dumps(bounded, ensure_ascii=False))
        report = {"schemaVersion": 1, "status": "FAIL", "failure": {"phase": "attachment-rollback", "action": "recovery-rollback",
                  "code": "attachment-rollback-not-confirmed", "observed": dict(raw, maintenanceStatus="ROLLBACK_PARTIAL")}}
        projected = ci.bounded_report(report)["failure"]["observed"]
        self.assertEqual(projected["maintenanceStatus"], "ROLLBACK_PARTIAL")
        self.assertNotIn(canary, json.dumps(projected, ensure_ascii=False))
        self.assertEqual(ci.smoke.MAINTENANCE_STATUS_LABELS["回滚引用变更 · 引用变更已回滚"], "ROLLED_BACK")

    def test_maintenance_panel_excludes_portability_details(self):
        # Both <details> carry .vault-attachment-maintenance; the portability one comes first in the DOM.
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "features", "notes", "AttachmentPortabilitySection.tsx"), encoding="utf-8") as stream:
            src = stream.read()
        self.assertIn('className=\"vault-attachment-maintenance attachment-portability\"', src)
        self.assertIn(":not(.attachment-portability)", ci.smoke.MAINTENANCE_PANEL)

    def test_geometry_diagnostic_is_closed_integer_only(self):
        geometry = {"viewportWidth": 1440, "viewportHeight": 900.0, "screenWidth": 1440, "screenHeight": 900, "outerWidth": "1440",
                    "outerHeight": 10 ** 9, "rectLeft": 600, "rectTop": 1210, "rectWidth": 96, "rectHeight": 30, "title": "/home/runner/x",
                    "containers": [{"role": "notes-vault-page", "overflowY": "auto", "clientHeight": 400, "scrollHeight": 1200,
                                    "scrollTop": 0, "top": 160, "bottom": 560, "clipsControl": True, "text": "secret"},
                                   {"role": "<i>secret</i>", "overflowY": "expression(x)", "clientHeight": True, "clipsControl": "yes"}] * 6}
        state = ci.smoke.interactability({"element": {}, "enabled": True, "inViewport": False, "hitKind": "NONE", "styleVisible": True,
                                          "geometry": geometry}, True)
        raw = copy.deepcopy(self.fixture.raw)
        raw["status"] = "FAIL"
        raw["failure"] = {"phase": "attachment-rename", "action": "maintenance-plan", "code": "control-not-interactable",
                          "interactability": state}
        projected = ci.bounded_report(raw)["failure"]["interactability"]["geometry"]
        self.assertEqual(len(projected["containers"]), 8)
        self.assertEqual(projected["containers"][0], {"role": "notes-vault-page", "overflowY": "auto", "clientHeight": 400,
                                                      "scrollHeight": 1200, "scrollTop": 0, "top": 160, "bottom": 560, "clipsControl": True})
        self.assertEqual(projected["containers"][1], {"role": "OTHER", "overflowY": "OTHER", "clientHeight": None, "scrollHeight": None,
                                                      "scrollTop": None, "top": None, "bottom": None, "clipsControl": None})
        self.assertEqual((projected["viewportHeight"], projected["outerWidth"], projected["outerHeight"], projected["rectTop"]),
                         (900, None, None, 1210))
        self.assertNotIn("secret", json.dumps(projected))
        self.assertNotIn("/home", json.dumps(projected))

    def test_image_link_parser_is_exact(self):
        self.assertEqual(ci.smoke.image_link("x ![synthetic PNG](<attachments/改名 图.png>) y"), "attachments/改名 图.png")
        self.assertEqual(ci.smoke.image_link("![synthetic PNG](a.png)"), "a.png")
        self.assertIsNone(ci.smoke.image_link("![synthetic PNG](a.png) ![synthetic PNG](b.png)"))
        self.assertIsNone(ci.smoke.image_link("no image"))


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "1" * 40, "tree": "2" * 40}
        self.build = {"application": {"sha256": "3" * 64}}
        self.scripts = {"smoke": "4" * 64, "webdriver": "5" * 64, "layoutAudit": "6" * 64,
                        "driverPrep": "7" * 64, "driverDiagnostic": "8" * 64}
        self.driver_source = {"kind": ci.driver_source.KIND, "version": ci.driver_source.VERSION,
            "archiveSha256": ci.driver_source.ARCHIVE_SHA, "lockSha256": ci.driver_source.LOCK_SHA,
            "prepScriptSha256": self.scripts["driverPrep"], "diagnosticSha256": self.scripts["driverDiagnostic"],
            "patchedMainSha256": "9" * 64, "patchedServerSha256": "a" * 64, "sourceClosureSha256": "b" * 64}
        self.raw = {"schemaVersion": 1, "status": "PASS", "scope": ci.SCOPE, "commit": self.source["commit"],
            "applicationSha256": "3" * 64, "scriptSha256": "4" * 64, "helperSha256": "5" * 64,
            "flowCount": 1, "appSessions": 2, "checks": {name: "PASS" for name in ci.smoke.CHECKS},
            "drop": {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 1,
                "inputNotes": 2, "retainedNotes": 2, "collisionRenameObserved": True,
                "originalCaseSpellingsBothRetained": False, "destinationNames": ["Note.md", "note (1).md"]},
            "dropHit": {"insideNotes": True, "rootTarget": True},
            "dropTargets": {"upperExists": True, "lowerExists": True},
            "dropTrace": {"state": "OBSERVED", "readBytes": 1200, "truncated": False,
                "records": [{"stage": stage, "count": count, "overflow": False, "hit": True}
                    for stage, count in (("native-import-start", 2), ("native-source-active", 0), ("native-import-ok", 2), ("native-import-failed", 0))]},
            "attachmentOpen": {"state": "OBSERVED", "readBytes": 640, "truncated": False,
                "records": [{"route": "MATERIAL_DETAIL", "status": "NONE", "opener": "NOT_ATTEMPTED", "exitCode": None,
                             "sha256": None, "elapsedMs": 0},
                            {"route": "MATERIAL_DETAIL", "status": "NONE", "opener": "LAUNCHED", "exitCode": None,
                             "sha256": hashlib.sha256(ci.smoke.png_bytes()).hexdigest(), "elapsedMs": 42}]},
            "attachmentPolicy": {"selected": "copy", "readBack": "copy", "method": "PRODUCTION_PREFERENCE_IPC"},
            "mediaOpen": {"method": "WEBDRIVER_POINTER_MOVE", "clickAttempts": 1, **{name: True for name in ci.smoke.MEDIA_OPEN_FLAGS}},
            "imageCopies": [{"session": n, "pngCount": 1, "matchingDigestCount": 1,
                "pngOverflow": False, "matchingDigestOverflow": False, "scanComplete": True, "nameMatchesPolicy": True,
                "noteLinkRewritten": True, "sourceImageUnchanged": True, "sourceNotesUnchanged": True, "productionResolved": True} for n in (1, 2)],
            "previews": [{"session": n, "naturalWidth": 32, "naturalHeight": 24, "sampled": 5, "matched": 5,
                "visible": True, "method": "WEBVIEW_SCREENSHOT_PIXELS"} for n in (1, 2)],
            "previewGeometry": [{"session": n, "found": True, "replaced": n == 2, "hit": "SELF", "centerInViewport": True} for n in (1, 2)],
            "clipboard": {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True},
            "handoff": {"kind": "OWNED_XDG_RECEIVER_READBACK", "exactExpectedFile": True,
                "uiRoute": "NOTE_PREVIEW_OPEN",
                "bytes": len(ci.smoke.png_bytes()), "sha256": hashlib.sha256(ci.smoke.png_bytes()).hexdigest(),
                "externalApplicationDisplay": "NOT_RUN"},
            "quitRequests": [{"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"}] * 2,
            **{name: "NOT_RUN" for name in ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer")},
            "attachmentMaintenance": passing_maintenance(),
            "canvasStorage": {"canvasLeftovers": 0, "attachmentLeftovers": 0,
                              "workspaceLeftovers": 0, "moveLeftovers": 0,
                              "directoriesScanned": 5},
            "directorWebgl": {"directorCanvasPresent": True, "contextKind": "webgl2",
                              "rendererClass": "software", "contextLost": False,
                              "canvasWidth": 640, "canvasHeight": 360,
                              "probeDrawn": True, "probeNonBlack": True, "probeColors": 1},
            "canvasFlow": {"homeRendered": True, "editorOpened": True, "nodeAdded": True,
                           "savedOnDisk": True, "reopened": True, "nodePresentAfterReopen": True,
                           "documentNodes": 1, "temporaryLeftovers": 0}}

    def validate(self, raw):
        ci.validate_notes(ci.bounded_report(raw), self.build, self.source, self.scripts)

    def test_complete_unit_payload_is_accepted(self):
        self.validate(self.raw)

    def test_missing_required_observation_cannot_pass(self):
        for name in ci.smoke.CHECKS:
            with self.subTest(name=name):
                raw = copy.deepcopy(self.raw)
                raw["checks"][name] = "NOT_RUN"
                with self.assertRaises(RuntimeError):
                    self.validate(raw)

    def test_false_coverage_pixels_handoff_and_stale_identity_are_rejected(self):
        changes = [lambda r: r.update(commit="6" * 40), lambda r: r.update(scope="another-flow"),
            lambda r: r.update(appSessions=3), lambda r: r["drop"].update(nativePointerDrag="PASS"),
            lambda r: r["drop"].update(retainedNotes=1), lambda r: r["drop"].update(originalCaseSpellingsBothRetained=True),
            lambda r: r["previews"][0].update(matched=0), lambda r: r["previews"].append(r["previews"][0]),
            lambda r: r["handoff"].update(kind="OPENER_RETURNED_OK"), lambda r: r["handoff"].pop("sha256"),
            lambda r: r["handoff"].update(uiRoute="INSPECTOR_OPENED_ONLY"),
            lambda r: r["quitRequests"].append(r["quitRequests"][0]), lambda r: r.update(externalApplicationDisplay="PASS"),
            lambda r: r.update(trimmedFilenameEndToEnd="PASS"), lambda r: r.update(cleanup="UNCONFIRMED")]
        changes.append(lambda r: r["dropTargets"].update(lowerExists=False))
        changes.append(lambda r: r["attachmentPolicy"].update(readBack=None))
        changes.extend([lambda r: r["mediaOpen"].update(method="JS_CLICK"), lambda r: r["mediaOpen"].update(clickAttempts=2)])
        for field in ci.smoke.MEDIA_OPEN_FLAGS:
            changes.append(lambda r, field=field: r["mediaOpen"].update({field: False}))
        changes.extend([lambda r: r.pop("imageCopies"), lambda r: r["imageCopies"].pop(),
                        lambda r: r["imageCopies"][1].update(session=1)])
        for field in ("pngCount", "matchingDigestCount", "pngOverflow", "matchingDigestOverflow", "scanComplete", "nameMatchesPolicy",
                      "noteLinkRewritten", "sourceImageUnchanged", "sourceNotesUnchanged", "productionResolved"):
            changes.append(lambda r, field=field: r["imageCopies"][0].update({field: None}))
        changes.extend([lambda r: r["dropTrace"]["records"][2].update(stage="native-import-partial"),
                        lambda r: r["dropTrace"].update(state="NOT_OBSERVED", records=[]),
                        lambda r: r["dropTrace"].update(truncated=True)])
        changes.extend([lambda r: r["attachmentOpen"].update(state="UNAVAILABLE", records=[]),
                        lambda r: r["attachmentOpen"].update(records=[]),
                        lambda r: r["attachmentOpen"].update(truncated=True),
                        lambda r: r["attachmentOpen"]["records"][0].update(route="NOTE_JUMP"),
                        lambda r: r.pop("attachmentOpen")])
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                raw = copy.deepcopy(self.raw)
                change(raw)
                with self.assertRaises(RuntimeError):
                    self.validate(raw)

    def test_projection_exports_no_free_text_private_canary(self):
        canary = "hunter2"
        raw = copy.deepcopy(self.raw)
        raw.update(profile=canary, environment={"secret": canary}, failure={"phase": canary, "code": canary})
        raw["clipboard"]["value"] = canary
        raw["handoff"]["path"] = canary
        raw["previews"][0]["src"] = canary
        raw["imageCopies"][0]["path"] = canary
        raw["imageCopies"][0]["name"] = canary
        raw["mediaOpen"]["path"] = canary
        raw["mediaOpen"]["rectangle"] = canary
        projected = ci.bounded_report(raw)
        self.assertNotIn(canary, json.dumps(projected))
        self.assertEqual(projected["failure"], {"phase": "unknown", "action": "unknown", "code": "unexpected-error"})
        for failure in ({"phase": [], "code": {}}, "arbitrary error"):
            raw["failure"] = failure
            self.assertNotIn(canary, json.dumps(ci.bounded_report(raw)))

    def test_finish_rejects_missing_step_nonzero_child_and_extra_artifact(self):
        for case in ("complete-unit-payload", "step-skipped", "child-failed", "extra-artifact",
                     "native-step-skipped", "native-report-failed"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="notes-gate-offline-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.evidence = Path(temporary)
                run.source = lambda: self.source
                run.scripts = lambda: self.scripts
                for name in ci.EXPORTS[:-1]:
                    body = {"status": "PASS", "source": self.source, "scope": ci.SCOPE}
                    if name == "build.json":
                        body.update(**self.build, scripts=self.scripts)
                    if name == "nativeMessaging.json" and case == "native-report-failed":
                        body["status"] = "FAIL"
                    if name == "notes.json":
                        body.update(attempts=1, flowCount=1, childExitCode=1 if case == "child-failed" else 0,
                                    observations=ci.bounded_report(self.raw), componentLayout=component_unit_payload(self.source, self.scripts),
                                    driver={"source": self.driver_source})
                    ci.write_json(run.evidence / name, body)
                if case == "extra-artifact":
                    (run.evidence / "private.log").write_text("unit-only")
                env = {"CI_" + name: "success" for name in ci.STEPS}
                if case == "step-skipped":
                    env["CI_NOTES"] = "skipped"
                if case == "native-step-skipped":
                    env["CI_NATIVE_MESSAGING"] = "skipped"
                with mock.patch.dict(os.environ, env):
                    if case == "complete-unit-payload":
                        run.finish()
                    else:
                        with self.assertRaises(RuntimeError):
                            run.finish()
                result = ci.read_json(run.evidence / "result.json")
                self.assertEqual(result["status"], "PASS" if case == "complete-unit-payload" else "FAIL")
                self.assertEqual(result["excluded"]["chromiumConsent"], "NOT_RUN")
                # The excluded label is measured now, never a permanent NOT_RUN.
                self.assertEqual(result["excluded"]["nativeMessaging"],
                                 "NOT_RUN" if case == "native-report-failed" else "REGISTRATION_AND_ROUND_TRIP_PASS")
                self.assertIn("nativeMessaging.json", result["artifactAllowlist"])

    def test_a_second_flow_attempt_is_rejected_before_any_process_launch(self):
        with tempfile.TemporaryDirectory(prefix="notes-attempt-offline-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.private = run.evidence = Path(temporary)
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            ci.write_json(run.evidence / "notes.json", {"componentLayout": component_unit_payload(self.source, self.scripts)})
            with self.assertRaises(RuntimeError):
                run.notes()
            with mock.patch.object(ci.subprocess, "run") as process, self.assertRaises(FileExistsError):
                run.notes()
            process.assert_not_called()

    def test_drop_log_projection_is_closed_and_never_exports_free_text(self):
        with tempfile.TemporaryDirectory(prefix="notes-trace-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            prefix = b"hunter2 /private/not-a-trace\n"
            body = (b"[notes-drop] stage=listener-ready count=0 hit=true\n"
                    b"[notes-drop] stage=drop count=2 hit=false\n"
                    b"[notes-drop] stage=native-source-active count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-source-inactive count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-write-unsupported count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-name-conflict count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-revision-conflict count=0 hit=false\n"
                    b"[notes-drop] stage=native-error-permissions-unsupported count=0 hit=false\n"
                    b"[notes-drop] stage=hunter2 count=2 hit=true\n"
                    b"[notes-drop] stage=drop count=999999 hit=true\n"
                    b"error hunter2 /private/personal-file\n"
                    b"[notes-drop] stage=drop count=2 hit=true")
            log.write_bytes(prefix + body)
            report = ci.smoke.read_drop_trace(log, len(prefix))
            self.assertEqual([item["stage"] for item in report["records"]],
                ["listener-ready", "drop", "native-source-active", "native-error-source-inactive", "native-error-write-unsupported",
                 "native-error-name-conflict", "native-error-revision-conflict", "native-error-permissions-unsupported"])
            self.assertNotIn("hunter2", json.dumps(report))
            self.assertNotIn("/private", json.dumps(report))
            self.assertEqual(ci.bounded_drop_trace(report), report)
            raw = copy.deepcopy(self.raw)
            raw["dropTrace"] = {**report, "path": "hunter2", "records": report["records"] + [{"stage": "hunter2", "count": 0, "hit": True}]}
            raw["dropHit"]["arbitrary"] = "hunter2"
            raw["dropTargets"]["path"] = "hunter2"
            self.assertNotIn("hunter2", json.dumps(ci.bounded_report(raw)))

    def test_drop_trace_read_and_record_counts_are_bounded(self):
        with tempfile.TemporaryDirectory(prefix="notes-trace-limit-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            log.write_bytes(b"[notes-drop] stage=classified count=100000 hit=true\n" * 2000)
            report = ci.smoke.read_drop_trace(log, 0)
            self.assertEqual(report["readBytes"], 65536)
            self.assertEqual(len(report["records"]), 32)
            self.assertTrue(report["truncated"])
            self.assertTrue(all(item["count"] == 2 and item["overflow"] for item in report["records"]))
            self.assertEqual(ci.smoke.read_drop_trace(log, None)["state"], "UNAVAILABLE")
            self.assertEqual(ci.smoke.read_drop_trace(log, -1)["state"], "UNAVAILABLE")

    def test_attachment_open_trace_projection_is_closed_and_never_exports_free_text(self):
        with tempfile.TemporaryDirectory(prefix="notes-attachment-trace-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            prefix = b"hunter2 /home/real-user/notes\n"
            digest = hashlib.sha256(ci.smoke.png_bytes()).hexdigest()
            body = ("[notes-attachment-open] route=MATERIAL_DETAIL status=NONE opener=NOT_ATTEMPTED "
                    "exit=NOT_EXPOSED sha256=none elapsedMs=0\n"
                    "[notes-attachment-open] route=MATERIAL_DETAIL status=NONE opener=LAUNCHED "
                    "exit=NOT_EXPOSED sha256=" + digest + " elapsedMs=42\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=MATERIAL_OPENED opener=LAUNCHED "
                    "exit=7 sha256=none elapsedMs=1200\n"
                    "[notes-attachment-open] route=hunter2 status=NONE opener=LAUNCHED exit=NOT_EXPOSED sha256=none elapsedMs=1\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=hunter2 opener=LAUNCHED exit=NOT_EXPOSED sha256=none elapsedMs=1\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=hunter2 exit=NOT_EXPOSED sha256=none elapsedMs=1\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=LAUNCHED "
                    "exit=NOT_EXPOSED sha256=/home/real-user/hunter2.png elapsedMs=1\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=LAUNCHED exit=NOT_EXPOSED sha256=none\n"
                    "error hunter2 /home/real-user/private.png\n"
                    "[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=FAILED exit=NOT_EXPOSED sha256=none elapsedMs=1")
            log.write_bytes(prefix + body.encode())
            report = ci.smoke.read_attachment_open_trace(log, len(prefix))
            self.assertEqual([(item["route"], item["status"], item["opener"], item["exitCode"], item["elapsedMs"])
                              for item in report["records"]],
                [("MATERIAL_DETAIL", "NONE", "NOT_ATTEMPTED", None, 0), ("MATERIAL_DETAIL", "NONE", "LAUNCHED", None, 42),
                 ("SYSTEM_OPEN", "MATERIAL_OPENED", "LAUNCHED", 7, 1200)])
            self.assertEqual(report["records"][1]["sha256"], digest)
            self.assertIsNone(report["records"][0]["sha256"])
            self.assertEqual(report["state"], "OBSERVED")
            self.assertFalse(report["truncated"])
            self.assertNotIn("hunter2", json.dumps(report))
            self.assertNotIn("/home", json.dumps(report))
            self.assertEqual(ci.bounded_attachment_open_trace(report), report)
            raw = copy.deepcopy(self.raw)
            raw["attachmentOpen"] = {**report, "path": "hunter2", "records": report["records"] + [
                {"route": "hunter2", "status": "NONE", "opener": "LAUNCHED", "sha256": None, "exitCode": None, "elapsedMs": 0}]}
            self.assertNotIn("hunter2", json.dumps(ci.bounded_report(raw)))
            self.assertEqual(ci.smoke.read_attachment_open_trace(log, None)["state"], "UNAVAILABLE")
            self.assertEqual(ci.smoke.read_attachment_open_trace(log, -1)["state"], "UNAVAILABLE")
            self.assertEqual(ci.smoke.read_attachment_open_trace(Path(temporary) / "absent.log", 0)["state"], "UNAVAILABLE")

    def test_attachment_open_trace_reads_and_records_are_bounded(self):
        with tempfile.TemporaryDirectory(prefix="notes-attachment-limit-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            log.write_bytes(b"[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=NOT_ATTEMPTED "
                            b"exit=NOT_EXPOSED sha256=none elapsedMs=0\n" * 2000)
            report = ci.smoke.read_attachment_open_trace(log, 0)
            self.assertEqual(report["readBytes"], 65536)
            self.assertEqual(len(report["records"]), 8)
            self.assertTrue(report["truncated"])
            self.assertEqual(ci.bounded_attachment_open_trace(report)["truncated"], True)
            overflow = {"state": "OBSERVED", "readBytes": 10, "truncated": False,
                        "records": [{"route": "SYSTEM_OPEN", "status": "NONE", "opener": "LAUNCHED",
                                     "exitCode": 400, "sha256": "z" * 64, "elapsedMs": 99999}] * 9}
            projected = ci.bounded_attachment_open_trace(overflow)
            self.assertTrue(projected["truncated"])
            self.assertEqual(len(projected["records"]), 8)
            self.assertEqual(projected["records"][0], {"route": "SYSTEM_OPEN", "status": "NONE", "opener": "LAUNCHED",
                                                       "exitCode": None, "sha256": None, "elapsedMs": 0})

    def test_attachment_open_trace_offset_past_the_owned_log_is_unavailable(self):
        with tempfile.TemporaryDirectory(prefix="notes-attachment-offset-offline-") as temporary:
            log = Path(temporary) / "owned-driver.log"
            log.write_bytes(b"[notes-attachment-open] route=SYSTEM_OPEN status=NONE opener=LAUNCHED "
                            b"exit=NOT_EXPOSED sha256=none elapsedMs=1\n")
            self.assertEqual(ci.smoke.read_attachment_open_trace(log, log.stat().st_size + 1)["state"], "UNAVAILABLE")

    def test_drop_target_probe_reads_only_the_two_owned_targets(self):
        with tempfile.TemporaryDirectory(prefix="notes-targets-offline-") as temporary:
            vault = Path(temporary)
            (vault / "Note.md").write_text("synthetic")
            self.assertEqual(ci.smoke.drop_targets(vault), {"upperExists": True, "lowerExists": False})
            (vault / "note (1).md").write_text("synthetic lower")
            self.assertEqual(ci.smoke.drop_targets(vault), {"upperExists": True, "lowerExists": True})

    def test_editor_actions_release_modifiers_before_text_and_emit_one_save(self):
        text, cursor, held, saves = "existing\n", 0, set(), 0
        for command in ("append", "save"):
            sequence = ci.smoke.editor_key_actions(command)["actions"]
            self.assertEqual(len(sequence), 1)
            self.assertEqual(sequence[0]["type"], "key")
            for event in sequence[0]["actions"]:
                key = event["value"]
                self.assertEqual(len(key), 1)
                self.assertNotEqual(key, "\ue000")
                if event["type"] == "keyUp":
                    self.assertIn(key, held)
                    held.remove(key)
                    continue
                self.assertEqual(event["type"], "keyDown")
                self.assertNotIn(key, held)
                held.add(key)
                if key == "\ue009":
                    continue
                if key == "\ue010":
                    self.assertIn("\ue009", held)
                    cursor = len(text)
                elif "\ue009" in held:
                    self.assertEqual(key, "s")
                    saves += 1
                else:
                    char = "\n" if key == "\ue007" else key
                    text = text[:cursor] + char + text[cursor:]
                    cursor += len(char)
            self.assertEqual(held, set())
        self.assertEqual(text, "existing\n" + ci.smoke.EDITOR_APPEND)
        self.assertEqual(saves, 1)

    def test_driver_http_classification_is_bounded_closed_and_does_not_retry_post(self):
        for body, expected in (({"value": {"error": "element click intercepted", "message": "hunter2", "stacktrace": "private/path"}}, "element click intercepted"),
                               ({"value": {"error": "invalid element state", "message": "hunter2"}}, "invalid element state"),
                               ({"value": {"error": "hunter2", "message": "private/path"}}, "unknown-standard-error"),
                               ({"value": {"error": ["hunter2"]}}, "unknown-standard-error")):
            stream = io.BytesIO(json.dumps(body).encode())
            error = urllib.error.HTTPError("http://127.0.0.1/session/owned/element/owned/click", 400, "hunter2", {}, stream)
            opener = mock.Mock()
            opener.open.side_effect = error
            request = urllib.request.Request(error.url, data=b"{}", method="POST")
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.webdriver_command(opener, request, 1)
            self.assertEqual(opener.open.call_count, 1)
            observed = raised.exception.observation
            self.assertEqual({key: value for key, value in observed.items() if key != "elapsedMs"},
                             {"kind": "HTTP_ERROR", "operation": "click", "error": expected, "httpStatus": 400,
                              "transport": "NOT_APPLICABLE", "responseState": "HTTP_ERROR_RECEIVED"})
            self.assertTrue(type(observed["elapsedMs"]) is int and 0 <= observed["elapsedMs"] <= 60000)
            self.assertNotIn("hunter2", str(raised.exception))
            raw = copy.deepcopy(self.raw)
            raw["failure"] = {"phase": "edit-save", "action": "source-toggle", "code": str(raised.exception),
                              "webdriver": {**raised.exception.observation, "message": "hunter2", "body": "private/path"}}
            projected = ci.bounded_report(raw)
            self.assertNotIn("hunter2", json.dumps(projected))
            self.assertNotIn("private/path", json.dumps(projected))
            self.assertEqual(projected["failure"]["action"], "source-toggle")
        body = io.BytesIO(b"x" * 100000)
        reads = []
        original_read = body.read
        def read(limit=-1):
            reads.append(limit)
            return original_read(limit)
        body.read = read
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError("http://127.0.0.1/session/owned/actions", 500, "hunter2", {}, body)
        with self.assertRaises(ci.smoke.DriverFailure) as raised:
            ci.smoke.webdriver_command(opener, urllib.request.Request(opener.open.side_effect.url, data=b"{}", method="POST"), 1)
        self.assertEqual(reads, [65537])
        self.assertEqual(raised.exception.observation["error"], "unknown-standard-error")
        self.assertEqual(opener.open.call_count, 1)

    def test_uncertain_driver_mutations_are_not_replayed_and_invalid_response_is_closed(self):
        for method in ("POST", "DELETE"):
            opener = mock.Mock()
            opener.open.side_effect = http.client.RemoteDisconnected("hunter2")
            request = urllib.request.Request("http://127.0.0.1/session/owned/actions", method=method)
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.webdriver_command(opener, request, 1)
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(raised.exception.observation["kind"], "TRANSPORT_ERROR")
            self.assertNotIn("hunter2", str(raised.exception))
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(b"hunter2")
        with self.assertRaises(ci.smoke.DriverFailure) as raised:
            ci.smoke.webdriver_command(opener, urllib.request.Request("http://127.0.0.1/session/owned/execute/sync", data=b"{}", method="POST"), 1)
        self.assertEqual(raised.exception.observation["kind"], "INVALID_RESPONSE")

    def test_status_readiness_waits_for_real_delayed_listen_and_bounds_persistent_refusal(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"value":{"ready":true}}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        for delayed in (True, False):
            with self.subTest(delayed=delayed):
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler, bind_and_activate=False)
                server.server_bind()
                thread = None
                if delayed:
                    def serve():
                        time.sleep(.25)
                        server.server_activate()
                        server.serve_forever(poll_interval=.01)
                    thread = threading.Thread(target=serve, daemon=True)
                    thread.start()
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                driver = mock.Mock(); driver.poll.return_value = None
                attempts, refusals = [], []
                def wd(method, suffix, timeout):
                    attempts.append((method, suffix, timeout))
                    request = urllib.request.Request("http://127.0.0.1:" + str(server.server_port) + suffix, method=method)
                    try:
                        return ci.smoke.webdriver_command(opener, request, timeout)
                    except ci.smoke.DriverFailure as error:
                        refusals.append(error.observation["transport"])
                        raise
                began = time.monotonic()
                try:
                    self.assertEqual(ci.smoke.wait_driver_ready(wd, driver, 2 if delayed else .25), delayed)
                    elapsed = time.monotonic() - began
                    self.assertTrue(refusals and all(code == "CONNECTION_REFUSED" for code in refusals))
                    self.assertTrue(all(method == "GET" and suffix == "/status" for method, suffix, _ in attempts))
                    self.assertTrue(all(0 < timeout <= 1 for _, _, timeout in attempts))
                    if not delayed:
                        self.assertTrue(.25 <= elapsed < 1)
                finally:
                    if thread is not None:
                        server.shutdown()
                    server.server_close()
                    if thread is not None:
                        thread.join(timeout=2)
                        self.assertFalse(thread.is_alive())

    def test_status_readiness_exited_process_never_sends_a_request(self):
        wd = mock.Mock()
        with subprocess.Popen([sys.executable, "-c", "pass"]) as driver:
            self.assertEqual(driver.wait(timeout=2), 0)
            self.assertFalse(ci.smoke.wait_driver_ready(wd, driver, 20))
        wd.assert_not_called()
        driver = mock.Mock(); driver.poll.side_effect = [None, 1]
        wd = mock.Mock(return_value={"ready": True})
        self.assertFalse(ci.smoke.wait_driver_ready(wd, driver, 20))
        wd.assert_called_once_with("GET", "/status", timeout=1)

    def test_status_readiness_does_not_swallow_protocol_or_other_transport_failures(self):
        failures = [ci.smoke.DriverFailure("HTTP_ERROR", "other", status=500),
                    ci.smoke.DriverFailure("INVALID_RESPONSE", "other")]
        failures.extend(ci.smoke.DriverFailure("TRANSPORT_ERROR", "other", transport=code)
                        for code in ci.smoke.TRANSPORT_CODES if code != "CONNECTION_REFUSED")
        failures.append(ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="CONNECTION_REFUSED"))
        failures.append(OSError("hunter2"))
        driver = mock.Mock(); driver.poll.return_value = None
        for failure in failures:
            with self.subTest(kind=type(failure).__name__):
                wd = mock.Mock(side_effect=failure)
                with self.assertRaises(type(failure)) as raised:
                    ci.smoke.wait_driver_ready(wd, driver, 20)
                self.assertIs(raised.exception, failure)
                wd.assert_called_once_with("GET", "/status", timeout=1)

    def test_status_readiness_has_one_deadline_caps_probe_and_sleep_and_rejects_late_ready(self):
        driver = mock.Mock(); driver.poll.return_value = None
        for ready in (True, False):
            clock, timeouts, sleeps = [0.0], [], []
            def wd(method, suffix, timeout):
                self.assertEqual((method, suffix), ("GET", "/status"))
                timeouts.append(timeout)
                clock[0] += timeout
                return {"ready": ready}
            def sleep(seconds):
                sleeps.append(seconds); clock[0] += seconds
            with mock.patch.object(ci.smoke.time, "monotonic", side_effect=lambda: clock[0]), \
                 mock.patch.object(ci.smoke.time, "sleep", side_effect=sleep):
                self.assertFalse(ci.smoke.wait_driver_ready(wd, driver, .25))
            self.assertEqual(timeouts, [.25])
            self.assertEqual(sleeps, [])
            self.assertEqual(clock[0], .25)
        clock, sleeps = [0.0], []
        def sleep(seconds):
            sleeps.append(seconds); clock[0] += seconds
        wd = mock.Mock(return_value={"ready": False})
        with mock.patch.object(ci.smoke.time, "monotonic", side_effect=lambda: clock[0]), \
             mock.patch.object(ci.smoke.time, "sleep", side_effect=sleep):
            self.assertFalse(ci.smoke.wait_driver_ready(wd, driver, .25))
        self.assertAlmostEqual(sum(sleeps), .25)
        self.assertTrue(all(0 < value <= .1 for value in sleeps))

    def test_status_probe_has_one_attempt_and_invalid_schema_fails_closed(self):
        for method in ("GET", "POST", "DELETE"):
            request = urllib.request.Request("http://127.0.0.1/status", method=method)
            opener = mock.Mock(); opener.open.side_effect = http.client.RemoteDisconnected("hunter2")
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.webdriver_command(opener, request, .25)
            opener.open.assert_called_once_with(request, timeout=.25)
            self.assertEqual(raised.exception.observation["transport"], "REMOTE_DISCONNECT")
        driver = mock.Mock(); driver.poll.return_value = None
        for value in (None, [], {}, {"ready": "true"}, {"ready": 1}):
            wd = mock.Mock(return_value=value)
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.wait_driver_ready(wd, driver)
            self.assertEqual(raised.exception.observation["kind"], "INVALID_RESPONSE")
            self.assertEqual(wd.call_count, 1)

    def test_startup_upstream_refusal_requires_one_exact_untruncated_typed_cause(self):
        trace = {"state": "OBSERVED", "readBytes": 248, "truncated": False, "legacy": [],
                 "typed": [{"connect": True, "hyper": "NONE", "io": "CONNECTION_REFUSED", "depth": 3, "truncated": False}]}
        def failure(value):
            error = ci.smoke.DriverFailure("TRANSPORT_ERROR", "other", transport="REMOTE_DISCONNECT")
            error.observation["forwarding"] = value
            return error
        self.assertTrue(ci.smoke.startup_refusal(failure(trace)))
        changes = [lambda v: v.update(state="NOT_OBSERVED"), lambda v: v.update(readBytes=0),
                   lambda v: v.update(readBytes=True), lambda v: v.update(truncated=True),
                   lambda v: v.update(legacy=["SEND_REQUEST"]), lambda v: v.update(typed=[]),
                   lambda v: v["typed"].append(copy.deepcopy(v["typed"][0]))]
        for key, value in (("connect", False), ("connect", 1), ("hyper", "OTHER"), ("io", "CONNECTION_RESET"),
                           ("depth", 4), ("depth", 3.0), ("truncated", True), ("reason", "hunter2")):
            changes.append(lambda v, key=key, value=value: v["typed"][0].update({key: value}))
        driver = mock.Mock(); driver.poll.return_value = None
        for change in changes:
            value = copy.deepcopy(trace); change(value); error = failure(value)
            self.assertFalse(ci.smoke.startup_refusal(error))
            wd = mock.Mock(side_effect=error)
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.wait_driver_ready(wd, driver, .25)
            self.assertIs(raised.exception, error)
            self.assertEqual(wd.call_count, 1)

    def test_stale_prefix_or_different_current_hyper_cannot_make_status_retryable(self):
        prefix = b"[luckyray-forward-v1] connect=true hyper=NONE io=CONNECTION_REFUSED depth=3 truncated=false\n"
        different = b"[luckyray-forward-v1] connect=false hyper=INCOMPLETE_MESSAGE io=NONE depth=2 truncated=false\n"
        with tempfile.TemporaryDirectory(prefix="status-offset-unit-") as temporary:
            path = Path(temporary) / "owned.log"
            for current in (b"", different):
                path.write_bytes(prefix + current); path.chmod(0o600)
                trace = ci.smoke.read_forwarding_trace(path, len(prefix))
                self.assertEqual(trace["readBytes"], len(current))
                error = ci.smoke.DriverFailure("TRANSPORT_ERROR", "other", transport="REMOTE_DISCONNECT")
                error.observation["forwarding"] = trace
                self.assertFalse(ci.smoke.startup_refusal(error))
            path.write_bytes(prefix + prefix)
            error.observation["forwarding"] = ci.smoke.read_forwarding_trace(path, len(prefix))
            self.assertEqual(len(error.observation["forwarding"]["typed"]), 1)
            self.assertTrue(ci.smoke.startup_refusal(error))

    def test_startup_native_identity_is_held_and_exit_or_replacement_stops_wait(self):
        anchors = {"driver": None, "app": {}, "nativeDriver": {}}
        fresh = {"driver": "held-driver", "app": {}, "nativeDriver": {"456": "held-native"}}
        driver = mock.Mock(pid=123); driver.poll.return_value = None
        def identity(pid):
            return {"123": "held-driver", "456": "held-native"}[str(pid)]
        with mock.patch.object(ci.smoke, "capture_processes", return_value=fresh), \
             mock.patch.object(ci.smoke.helpers, "live_identity", side_effect=identity):
            self.assertTrue(ci.smoke.startup_processes_alive(driver, Path("/owned/no-main"), anchors))
        self.assertEqual(anchors, fresh)
        replacement = {"driver": "held-driver", "app": {}, "nativeDriver": {"789": "new-native"}}
        for current in (None, "changed-native"):
            def changed(pid):
                return "held-driver" if str(pid) == "123" else current
            with mock.patch.object(ci.smoke, "capture_processes", return_value=replacement), \
                 mock.patch.object(ci.smoke.helpers, "live_identity", side_effect=changed):
                self.assertFalse(ci.smoke.startup_processes_alive(driver, Path("/owned/no-main"), anchors))
            self.assertEqual(anchors["nativeDriver"], {"456": "held-native"})
        native_alive = mock.Mock(side_effect=[True, False])
        wd = mock.Mock(return_value={"ready": False})
        self.assertFalse(ci.smoke.wait_driver_ready(wd, driver, 20, native_alive=native_alive))
        self.assertEqual(wd.call_count, 1)

    def test_failure_action_and_protocol_projection_reject_arbitrary_fields(self):
        raw = copy.deepcopy(self.raw)
        raw["failure"] = {"phase": "edit-save", "action": "hunter2", "code": "webdriver-command-failed",
                          "webdriver": {"kind": "hunter2", "operation": "hunter2", "error": "hunter2", "httpStatus": "hunter2"}}
        failure = ci.bounded_report(raw)["failure"]
        self.assertNotIn("hunter2", json.dumps(failure))
        self.assertEqual(failure["action"], "unknown")
        self.assertEqual(failure["webdriver"], {"kind": "UNKNOWN", "operation": "other", "error": "unknown-standard-error", "httpStatus": None,
                                                "transport": "UNKNOWN", "responseState": "UNKNOWN", "elapsedMs": None})

    def test_image_copy_probe_distinguishes_missing_duplicate_digest_name_and_link_failures(self):
        for case in ("complete", "missing", "duplicate", "different-extra", "digest", "name", "link", "source"):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="notes-image-copy-offline-") as temporary:
                root = Path(temporary)
                vault, incoming = root / "vault", root / "incoming"
                (vault / "attachments").mkdir(parents=True)
                incoming.mkdir()
                source = incoming / ci.smoke.SOURCE_IMAGE_NAME
                source.write_bytes(ci.smoke.png_bytes())
                copied = vault / ci.smoke.COPIED_IMAGE_RELATIVE
                copied.write_bytes(ci.smoke.png_bytes())
                expected = "SYNTHETIC_UPPER_v1\n\n" + ci.smoke.COPIED_IMAGE_REFERENCE + "\n"
                actual = expected
                if case == "missing":
                    copied.unlink()
                elif case in ("duplicate", "different-extra"):
                    copied.with_name("duplicate.png").write_bytes(ci.smoke.png_bytes() if case == "duplicate" else b"other")
                elif case == "digest":
                    copied.write_bytes(b"changed")
                elif case == "name":
                    copied.rename(copied.with_name(ci.smoke.SOURCE_IMAGE_NAME))
                elif case == "link":
                    actual = expected.replace(ci.smoke.COPIED_IMAGE_REFERENCE, ci.smoke.SOURCE_IMAGE_REFERENCE)
                elif case == "source":
                    source.write_bytes(b"source changed")
                observed = ci.smoke.image_copy_probe(vault, source, actual, expected)
                observed["sourceNotesUnchanged"] = True
                self.assertEqual(ci.smoke.image_copy_retained(observed), case == "complete")
                if case == "missing":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (0, 0))
                elif case == "duplicate":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (2, 2))
                elif case == "different-extra":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (2, 1))
                elif case == "digest":
                    self.assertEqual((observed["pngCount"], observed["matchingDigestCount"]), (1, 0))
                elif case == "name":
                    self.assertFalse(observed["nameMatchesPolicy"])
                elif case == "link":
                    self.assertFalse(observed["noteLinkRewritten"])
                elif case == "source":
                    self.assertFalse(observed["sourceImageUnchanged"])

    def test_desktop_launcher_paths_are_bare_and_reject_ambiguous_exec_arguments(self):
        for value in ("/usr/bin/python3", "/tmp/owned-notes_123/receiver-config.json"):
            self.assertEqual(ci.smoke.desktop_arg(Path(value)), value)
        for value in ("relative.py", "/tmp/with space/script.py", "/tmp/#hash.py", "/tmp/100%.py",
                      '/tmp/"quote.py', "/tmp/$variable.py", "/tmp/`command`.py", "/tmp/line\nbreak.py", "/tmp/中文.py"):
            with self.subTest(value=value), self.assertRaises(ci.smoke.SmokeFailure) as raised:
                ci.smoke.desktop_arg(Path(value))
            self.assertEqual(str(raised.exception), "owned-desktop-association-unavailable")

    def test_owned_generic_desktop_launcher_executes_real_receiver_with_exact_special_name_png(self):
        xdg = Path("/usr/bin/xdg-open")
        if sys.platform != "linux" or not xdg.is_file():
            self.skipTest("Installed Linux generic launcher is required for this local argument test")
        functions = []
        source = xdg.read_text()
        for name in ("get_key", "first_word", "last_word", "search_desktop_file"):
            matches = re.findall(r"^" + name + r"\(\)\n\{\n[\s\S]*?^\}\n", source, re.M)
            self.assertEqual(len(matches), 1, "Installed generic launcher function is required")
            functions.append(matches[0])
        launcher = "\n".join(functions) + '\nDEBUG() { :; }\nexit_success() { exit 0; }\nsearch_desktop_file "$1" "$2" "$3"\n'
        with tempfile.TemporaryDirectory(prefix="owned-desktop-args-") as temporary:
            root = Path(temporary)
            vault = root / "Vault 中文 #100%"; vault.mkdir(mode=0o700)
            image = vault / ci.smoke.COPIED_IMAGE_RELATIVE; image.parent.mkdir(mode=0o700)
            image.write_bytes(ci.smoke.png_bytes())
            config = root / "receiver-config.json"; config.write_text(json.dumps({"expected": str(image.resolve())})); config.chmod(0o600)
            applications = root / "applications"; applications.mkdir(mode=0o700)
            desktop = applications / "owned-notes-receiver.desktop"
            script = Path(ci.smoke.__file__).resolve()
            desktop.write_text('[Desktop Entry]\nType=Application\nName=Owned PNG receiver\nTerminal=false\nMimeType=image/png;\nExec=/usr/bin/python3 '
                + ci.smoke.desktop_arg(script) + ' --receive-image ' + ci.smoke.desktop_arg(config) + ' %f\n')
            result = subprocess.run(["/bin/sh", "-c", launcher, "owned-generic", desktop.name, str(applications), str(image)],
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root)}, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            receipt = json.loads((root / "receiver.json").read_text())
            self.assertEqual(receipt["sha256"], hashlib.sha256(ci.smoke.png_bytes()).hexdigest())
            self.assertTrue(receipt["exactExpectedFile"])
            self.assertEqual(receipt["externalApplicationDisplay"], "NOT_RUN")

    def test_owned_receiver_checks_the_exact_png_and_rejects_other_files(self):
        with tempfile.TemporaryDirectory(prefix="notes-receiver-offline-") as temporary:
            root = Path(temporary)
            vault = root / "Vault 中文 #100%"
            vault.mkdir(mode=0o700)
            image = vault / "素材 图 #100%.png"
            image.write_bytes(ci.smoke.png_bytes())
            config = root / "receiver-config.json"
            config.write_text(json.dumps({"expected": str(image)}))
            config.chmod(0o600)
            ci.smoke.receive_image(config, image)
            receipt = json.loads((root / "receiver.json").read_text())
            self.assertEqual(receipt["sha256"], hashlib.sha256(ci.smoke.png_bytes()).hexdigest())
            self.assertEqual(receipt["externalApplicationDisplay"], "NOT_RUN")
            (root / "receiver.json").unlink()
            image.write_bytes(b"wrong image")
            with self.assertRaises(ci.smoke.SmokeFailure):
                ci.smoke.receive_image(config, image)
            self.assertFalse((root / "receiver.json").exists())
            outside = root / "outside.png"
            outside.write_bytes(ci.smoke.png_bytes())
            with self.assertRaises(ci.smoke.SmokeFailure):
                ci.smoke.receive_image(config, outside)

    def test_production_media_action_geometry_and_cleanup_contract(self):
        result = subprocess.run(["node", "--experimental-strip-types", "--test", str(Path(__file__).with_name("noteMediaActions.test.mjs"))],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_setup_failure_is_reported_without_raw_text_or_starting_main(self):
        with tempfile.TemporaryDirectory(prefix="notes-setup-failure-offline-") as temporary:
            root = Path(temporary)
            fake = root / "never-executed-unit-elf"
            fake.write_bytes(b"\x7fELF")
            output = root / "output"
            arguments = [ci.smoke.__file__, "--application", str(fake), "--driver", str(fake), "--output", str(output)]
            previous_mask = os.umask(0o077)
            try:
                with mock.patch.object(sys, "argv", arguments), mock.patch.object(ci.smoke.subprocess, "run", side_effect=OSError("hunter2")), mock.patch.object(ci.smoke.subprocess, "Popen") as launcher:
                    with self.assertRaises(OSError):
                        ci.smoke.main()
                launcher.assert_not_called()
            finally:
                os.umask(previous_mask)
            raw = json.loads((output / "report.json").read_text())
            self.assertEqual(raw["failure"], {"phase": "desktop-association", "action": "setup", "code": "unexpected-error"})
            self.assertNotIn("hunter2", json.dumps(raw))
            self.assertEqual(raw["status"], "FAIL")

    def test_png_fixture_and_embedded_webdriver_javascript_are_valid_offline(self):
        image = ci.smoke.png_bytes()
        self.assertEqual(struct.unpack(">II", image[16:24]), (32, 24))
        offset, blocks = 8, {}
        while offset < len(image):
            count = struct.unpack(">I", image[offset:offset + 4])[0]
            kind, body = image[offset + 4:offset + 8], image[offset + 8:offset + 8 + count]
            self.assertEqual(struct.unpack(">I", image[offset + 8 + count:offset + 12 + count])[0], zlib.crc32(kind + body))
            blocks[kind] = body
            offset += 12 + count
        self.assertEqual(zlib.decompress(blocks[b"IDAT"]), (b"\0" + bytes(ci.smoke.COLOR) * 32) * 24)
        source = Path(ci.smoke.__file__).read_text()
        scripts = [node.args[0].value for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
                   and isinstance(node.func, ast.Name) and node.func.id in ("execute", "until") and node.args
                   and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)]
        self.assertGreater(len(scripts), 10)
        scripts.append(ci.smoke.MEDIA_OPEN_PROBE)
        # The Director probe references WebGL constants a bare parser cannot know,
        # but its syntax must still compile in the same engine check.
        scripts.append(ci.smoke.DIRECTOR_PROBE)
        result = subprocess.run(["node", "-e", "for(const s of JSON.parse(require('fs').readFileSync(0,'utf8')))new Function(s)"],
                                input=json.dumps(scripts), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_existing_workflow_selects_only_this_flow_and_exact_json_files(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/linux-desktop-preflight.yml"
        text = workflow.read_text()
        jobs = re.findall(r"^  ([a-z0-9-]+):$", text.split("jobs:\n", 1)[1], re.M)
        self.assertEqual(jobs, ["linux-notes-attachments-validation"])
        self.assertNotIn("linux-browser-ci.py", text)
        # The host is built only by the native-messaging step; the notes flow
        # still runs against the Main binary alone.
        self.assertEqual(text.count("--bin luckyray-native-host"), 1)
        native = text.index("id: native-messaging")
        self.assertGreater(text.index("--bin luckyray-native-host"), native)
        self.assertNotIn("--no-sandbox", text)
        self.assertEqual(re.findall(r"/evidence/([A-Za-z.]+)", text), list(ci.EXPORTS))
        for stage in ("init", "layout", "binaries", "resources", "notes", "native-messaging", "finish"):
            self.assertIn("linux-notes-ci.py " + stage, text)
        self.assertLess(text.index("        id: frontend"), text.index("        id: layout"))
        self.assertLess(text.index("        id: layout"), text.index("        id: dependencies"))
        self.assertLess(text.index("        id: layout"), text.index("        id: build"))
        self.assertIn("CI_LAYOUT: ${{ steps.layout.outcome }}", text)
        self.assertEqual(text.count("if: ${{ success() && steps.layout.outcome == 'success' }}"), 2)


class TransportEvidenceTests(unittest.TestCase):
    def test_typed_transport_categories_never_read_private_reason_text(self):
        cases = [(TimeoutError("hunter2"), "TIMEOUT"), (http.client.RemoteDisconnected("hunter2"), "REMOTE_DISCONNECT"),
            (ConnectionResetError("hunter2"), "CONNECTION_RESET"), (ConnectionRefusedError("hunter2"), "CONNECTION_REFUSED"),
            (ConnectionAbortedError("hunter2"), "CONNECTION_ABORTED"), (BrokenPipeError("hunter2"), "BROKEN_PIPE"),
            (http.client.IncompleteRead(b"hunter2"), "INCOMPLETE_RESPONSE"), (http.client.BadStatusLine("hunter2"), "HTTP_PROTOCOL_ERROR"),
            (OSError(errno.ENETUNREACH, "hunter2"), "NETWORK_UNREACHABLE"),
            (urllib.error.URLError("hunter2"), "UNKNOWN"), (OSError("hunter2"), "IO_ERROR")]
        for error, expected in cases:
            for wrapped in (error, urllib.error.URLError(error)):
                with self.subTest(category=expected):
                    opener = mock.Mock()
                    opener.open.side_effect = wrapped
                    request = urllib.request.Request("http://127.0.0.1/session/owned/element/owned/click", method="POST", data=b"{}")
                    with self.assertRaises(ci.smoke.DriverFailure) as raised:
                        ci.smoke.webdriver_command(opener, request, 1)
                    self.assertEqual(opener.open.call_count, 1)
                    self.assertEqual(raised.exception.observation["transport"], expected)
                    self.assertEqual(raised.exception.observation["responseState"], "UNCONFIRMED")
                    self.assertEqual(ci.bounded_driver(raised.exception.observation), raised.exception.observation)
                    self.assertNotIn("hunter2", json.dumps(raised.exception.observation))

    def test_real_loopback_post_disconnect_reset_and_timeout_are_not_replayed(self):
        # http.client sends the headers and the POST body in two send() calls.
        # Closing while any body byte is still unread makes the Linux kernel
        # answer with RST instead of FIN, so "close" could surface as
        # CONNECTION_RESET depending on segment timing. Consume exactly the
        # declared body first; only "reset" then forces RST via SO_LINGER=0.
        # "late-body" pins the timing that previously produced the RST.
        real_send = http.client.HTTPConnection.send
        def late_body_send(connection, data):
            if data == b"{}":
                threading.Event().wait(.01)
            return real_send(connection, data)
        for mode, expected in (("close", "REMOTE_DISCONNECT"), ("late-body", "REMOTE_DISCONNECT"),
                               ("reset", "CONNECTION_RESET"), ("delay", "TIMEOUT")):
            requests = []
            bodies = []
            class Handler(BaseHTTPRequestHandler):
                def do_POST(self):
                    requests.append(self.command)
                    length = self.headers.get("Content-Length")
                    if length is None or not length.isdigit() or int(length) > 65536:
                        raise AssertionError("synthetic fixture expects one bounded declared body")
                    bodies.append(self.rfile.read(int(length)))
                    if mode == "delay":
                        threading.Event().wait(.2)
                    elif mode == "late-body":
                        # Without the read above, the late body would now sit unread.
                        threading.Event().wait(.03)
                    elif mode == "reset":
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    self.close_connection = True
                    self.connection.close()
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
            worker.start()
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/session/owned/element/owned/click", method="POST", data=b"{}")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                timeout = .5 if mode == "late-body" else .05
                with mock.patch.object(http.client.HTTPConnection, "send", late_body_send if mode == "late-body" else real_send), \
                        self.assertRaises(ci.smoke.DriverFailure) as raised:
                    ci.smoke.webdriver_command(opener, request, timeout)
                self.assertEqual(raised.exception.observation["transport"], expected, mode)
                self.assertEqual(raised.exception.observation["responseState"], "UNCONFIRMED")
                self.assertEqual(requests, ["POST"])
                self.assertEqual(bodies, [b"{}"])
            finally:
                server.shutdown(); server.server_close(); worker.join(timeout=1)

    def test_single_lost_preview_click_is_reconciled_before_any_retry(self):
        # 41521642741 lost exactly one click at the transport layer: the request
        # never produced a response, so the click was unconfirmed rather than
        # applied. Only that shape may be reconsidered, and only after re-reading
        # the preview state; webdriver_command itself still never replays a POST.
        retriable = {"kind": "TRANSPORT_ERROR", "operation": "click", "responseState": "UNCONFIRMED",
                     "transport": "CONNECTION_RESET", "elapsedMs": 1}
        self.assertTrue(ci.smoke.preview_toggle_retriable(retriable))
        for key, replacement in (("kind", "HTTP_ERROR"), ("kind", "INVALID_RESPONSE"),
                                 ("operation", "execute"), ("operation", "actions"),
                                 ("operation", "element"), ("responseState", "HTTP_ERROR_RECEIVED")):
            value = dict(retriable); value[key] = replacement
            self.assertFalse(ci.smoke.preview_toggle_retriable(value), (key, replacement))
        for missing in ("kind", "operation", "responseState"):
            value = dict(retriable); value.pop(missing)
            self.assertFalse(ci.smoke.preview_toggle_retriable(value), missing)
        self.assertFalse(ci.smoke.preview_toggle_retriable(None))
        self.assertFalse(ci.smoke.preview_toggle_retriable(["hunter2"]))
        self.assertFalse(ci.smoke.preview_toggle_retriable("hunter2"))

        # The record is closed, bounded to two attempts and idempotent; no value
        # from outside the closed sets is exported.
        raw = [{"attempt": 1, "transport": "CONNECTION_RESET", "elapsedMs": 1, "stateAfterFailure": "SOURCE"},
               {"attempt": 2, "transport": None, "elapsedMs": None, "stateAfterFailure": None}]
        self.assertEqual(ci.bounded_preview_toggle(raw), raw)
        self.assertEqual(ci.bounded_preview_toggle(ci.bounded_preview_toggle(raw)), raw)
        self.assertEqual(ci.bounded_preview_toggle([{}] * 3), [])
        self.assertEqual(ci.bounded_preview_toggle([{"attempt": 7, "transport": "hunter2", "elapsedMs": -5,
                                                     "stateAfterFailure": "hunter2"}]),
                         [{"attempt": 1, "transport": None, "elapsedMs": None, "stateAfterFailure": None}])
        self.assertNotIn("hunter2", json.dumps(ci.bounded_report({"previewToggle": [{"transport": "hunter2"}]})))
        self.assertEqual(ci.bounded_report({"previewToggle": [{"attempt": 1, "transport": "CONNECTION_RESET",
                                                               "elapsedMs": 1, "stateAfterFailure": "PREVIEW"}]})["previewToggle"],
                         [{"attempt": 1, "transport": "CONNECTION_RESET", "elapsedMs": 1, "stateAfterFailure": "PREVIEW"}])

        # The retry is bounded to two attempts and the click is still followed by
        # the preview assertion it always had.
        source = Path(ci.smoke.__file__).read_text()
        self.assertIn("if attempts >= 2 or not preview_toggle_retriable(observation):", source)
        self.assertIn("applied = helpers.wait_until(preview_state, 20)", source)
        self.assertIn('"previewToggle": []', source)
        preview = source.split("def preview():", 1)[1].split("def verify_image_copy", 1)[0]
        self.assertIn("toggle_preview(", preview)
        self.assertIn('action = "preview-ready"', preview)
        self.assertIn("e.complete&&e.naturalWidth===32", preview)

    def test_single_read_clipboard_probe_is_bounded_readonly_and_never_returns_contents(self):
        expected = "/owned/SyntheticNote.md"
        real_popen = subprocess.Popen
        for mode in ("match", "different", "oversize", "timeout", "missing"):
            with self.subTest(mode=mode):
                def launch(command, **kwargs):
                    self.assertEqual(command, ["xclip", "-selection", "clipboard", "-o"])
                    if mode == "missing":
                        raise FileNotFoundError("hunter2")
                    program = {"match": "import sys;sys.stdout.buffer.write(" + repr(expected.encode()) + ")",
                        "different": "import sys;sys.stdout.buffer.write(b'hunter2')",
                        "oversize": "import sys;sys.stdout.buffer.write(b'x'*9000)",
                        "timeout": "import time;time.sleep(1)"}[mode]
                    return real_popen([sys.executable, "-c", program], **kwargs)
                with mock.patch.object(ci.smoke.subprocess, "Popen", side_effect=launch) as process:
                    value = ci.smoke.clipboard_read_once({}, expected, timeout=.1)
                self.assertEqual(process.call_count, 1)
                self.assertEqual(value["attempts"], 1)
                self.assertEqual(value["state"], {"match": "READ", "different": "READ", "oversize": "SIZE_LIMIT", "timeout": "TIMEOUT", "missing": "IO_ERROR"}[mode])
                self.assertEqual(value["exactAbsolutePath"], True if mode == "match" else False if mode == "different" else None)
                self.assertLessEqual(value["readBytes"], 8193)
                self.assertEqual(value, ci.bounded_clipboard_probe(value))
                self.assertNotIn("hunter2", json.dumps(value))
                self.assertNotIn(expected, json.dumps(value))

    def test_uncertain_copy_effect_match_does_not_confirm_response_or_pass_the_flow(self):
        fixture = EvidenceTests(methodName="runTest")
        fixture.setUp()
        anchors = {"driver": None, "app": {}, "nativeDriver": {}}
        report = copy.deepcopy(fixture.raw)
        failure = ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="REMOTE_DISCONNECT", elapsed=1)
        wd = mock.Mock(side_effect=failure)
        probe = {"attempts": 1, "method": "XCLIP_READONLY_ONCE", "state": "READ", "exactAbsolutePath": True, "readBytes": 23,
                 "overflow": False, "exit": {"state": "EXITED", "exitCode": 0, "signal": None}}
        with mock.patch.object(ci.smoke, "clipboard_read_once", return_value=probe) as reader:
            with self.assertRaises(ci.smoke.DriverFailure) as raised:
                ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None, anchors, report)
        self.assertIs(raised.exception, failure)
        wd.assert_called_once_with("POST", "/session/owned/element/owned/click", {})
        reader.assert_called_once()
        self.assertEqual(report["unconfirmedCopy"]["responseState"], "UNCONFIRMED")
        self.assertTrue(report["unconfirmedCopy"]["clipboard"]["exactAbsolutePath"])
        self.assertEqual(report["unconfirmedCopy"], ci.bounded_unconfirmed_copy(report["unconfirmedCopy"]))
        # Even spoofing all success checks cannot turn an unconfirmed response green.
        with self.assertRaisesRegex(RuntimeError, "copy-response-not-confirmed"):
            ci.validate_notes(ci.bounded_report(report), fixture.build, fixture.source, fixture.scripts)
        for kind in ("HTTP_ERROR", "INVALID_RESPONSE"):
            wd = mock.Mock(side_effect=ci.smoke.DriverFailure(kind, "click"))
            report = {}
            with mock.patch.object(ci.smoke, "clipboard_read_once", return_value=probe) as reader:
                with self.assertRaises(ci.smoke.DriverFailure):
                    ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None, anchors, report)
            self.assertEqual(reader.call_count, 0 if kind == "HTTP_ERROR" else 1)
            self.assertEqual(wd.call_count, 1)

    def test_diagnostic_failure_never_masks_original_uncertain_command(self):
        wd = mock.Mock(side_effect=ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="TIMEOUT"))
        report = {}
        with mock.patch.object(ci.smoke, "clipboard_read_once", side_effect=RuntimeError("hunter2")):
            with self.assertRaises(ci.smoke.DriverFailure):
                ci.smoke.copy_click_once(wd, "/session/owned/element/owned/click", {}, Path("/owned/SyntheticNote.md"), None,
                                        {"driver": None, "app": {}, "nativeDriver": {}}, report)
        self.assertEqual(report["unconfirmedCopy"]["state"], "UNAVAILABLE")
        self.assertEqual(wd.call_count, 1)
        self.assertNotIn("hunter2", json.dumps(ci.bounded_unconfirmed_copy(report["unconfirmedCopy"])))

    def test_uncertain_quit_is_marked_before_dispatch_and_cannot_be_replayed(self):
        for effect in (ci.smoke.DriverFailure("TRANSPORT_ERROR", "execute", transport="CONNECTION_RESET"), None):
            state = {"attempted": False, "ipcReplyObserved": False}
            close = mock.Mock(side_effect=effect)
            if effect is not None:
                with self.assertRaises(ci.smoke.DriverFailure):
                    ci.smoke.quit_once(state, close)
            else:
                ci.smoke.quit_once(state, close)
            with self.assertRaisesRegex(ci.smoke.SmokeFailure, "quit-already-attempted"):
                ci.smoke.quit_once(state, close)
            self.assertEqual(close.call_count, 1)
            self.assertEqual(state, {"attempted": True, "ipcReplyObserved": effect is None})

    def test_owned_process_snapshot_distinguishes_cleanup_signal_without_exporting_ids(self):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(10)"], start_new_session=True)
        try:
            identity = ci.smoke.helpers.live_identity(child.pid)
            self.assertIsNotNone(identity)
            anchors = {"driver": identity, "app": {str(child.pid): identity}, "nativeDriver": {}}
            before = ci.smoke.observe_processes(child, anchors)
            self.assertEqual(before["driver"]["state"], "RUNNING")
            self.assertEqual(before["app"]["running"], 1)
            stopped = ci.smoke.terminate_driver(child)
            after = ci.smoke.observe_processes(child, anchors)
            self.assertTrue(stopped["termRequested"])
            self.assertFalse(stopped["killRequested"])
            self.assertEqual(stopped["exit"], {"state": "SIGNALED", "exitCode": None, "signal": signal.SIGTERM})
            self.assertEqual(after["app"]["gone"], 1)
            self.assertEqual(after["app"]["exitStatus"], "NOT_OBSERVED")
            self.assertEqual(after, ci.bounded_processes(after))
            self.assertNotIn(str(child.pid), json.dumps(after))
            fake = mock.Mock(pid=child.pid)
            fake.poll.return_value = None
            with mock.patch.object(ci.smoke.helpers, "live_identity", return_value="new-private-identity"):
                changed = ci.smoke.observe_processes(fake, anchors)
            self.assertEqual(changed["driver"]["state"], "IDENTITY_CHANGED")
            self.assertEqual(changed["app"]["identityChanged"], 1)
            self.assertNotIn("new-private-identity", json.dumps(changed))
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=2)

    def test_backend_exit_during_capture_does_not_discard_independent_app_identity(self):
        driver = mock.Mock(pid=123)
        with mock.patch.object(ci.smoke.helpers, "live_identity", return_value="owned-driver"), \
             mock.patch.object(ci.smoke.helpers, "app_pids", side_effect=[{"456": "owned-backend"}, {"789": "owned-app"}]), \
             mock.patch.object(ci.smoke.os, "getpgid", side_effect=ProcessLookupError):
            anchors = ci.smoke.capture_processes(driver, Path("/owned/Main"))
        self.assertEqual(anchors, {"driver": "owned-driver", "nativeDriver": {}, "app": {"789": "owned-app"}})

    def test_all_new_transport_process_clipboard_and_cleanup_projections_are_closed(self):
        value = {"kind": "TRANSPORT_ERROR", "transport": "hunter2", "responseState": "hunter2", "elapsedMs": True,
                 "pid": "hunter2", "path": "hunter2", "stdout": "hunter2", "reason": "hunter2"}
        for project in (ci.bounded_driver, ci.bounded_exit, ci.bounded_processes, ci.bounded_clipboard_probe, ci.bounded_unconfirmed_copy, ci.bounded_cleanup, ci.bounded_preview_toggle):
            self.assertNotIn("hunter2", json.dumps(project(value)))
            self.assertNotIn("hunter2", json.dumps(project(["hunter2"])))
        fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
        fixture.raw.update(unconfirmedCopy={"action": "context-copy", "clipboard": {**value, "exactAbsolutePath": True},
            "atUnconfirmedResponse": {"driver": value, "app": value}, "afterClipboardRead": {"nativeDriver": value}},
            cleanupEvidence={"quitFailure": value, "driverTermination": {**value, "exit": value}, "beforeDriverTermination": {"app": value}})
        self.assertNotIn("hunter2", json.dumps(ci.bounded_report(fixture.raw)))


class ForwardingDiagnosticsTests(unittest.TestCase):
    def test_only_exact_closed_driver_tags_after_this_request_are_exported(self):
        with tempfile.TemporaryDirectory(prefix="forward-log-unit-") as temporary:
            path = Path(temporary) / "owned.log"
            prefix = b"hunter2 /private/previous-request\n"
            body = (b"[luckyray-forward-v1] connect=false hyper=INCOMPLETE_MESSAGE io=NONE depth=2 truncated=false\n"
                    b"Error serving connection: hyper::Error(User(Service), client error (SendRequest))\n"
                    b"[luckyray-forward-v1] connect=false hyper=hunter2 io=NONE depth=2 truncated=false\n"
                    b"[luckyray-forward-v1] connect=true hyper=NONE io=CONNECTION_REFUSED depth=3 truncated=false reason=hunter2\n"
                    b"private body hunter2\n")
            path.write_bytes(prefix + body); path.chmod(0o600)
            value = ci.smoke.read_forwarding_trace(path, len(prefix))
            self.assertEqual(value, {"state": "OBSERVED", "readBytes": len(body), "truncated": False,
                "typed": [{"connect": False, "hyper": "INCOMPLETE_MESSAGE", "io": "NONE", "depth": 2, "truncated": False}], "legacy": ["SEND_REQUEST"]})
            self.assertEqual(value, ci.bounded_forwarding(value))
            self.assertNotIn("hunter2", json.dumps(value))
            for offset in (None, True, -1, len(prefix + body) + 1):
                self.assertEqual(ci.smoke.read_forwarding_trace(path, offset)["state"], "UNAVAILABLE")
            linked = Path(temporary) / "linked.log"; linked.symlink_to(path)
            self.assertEqual(ci.smoke.read_forwarding_trace(linked, 0)["state"], "UNAVAILABLE")

    def test_forwarding_bytes_records_and_depth_are_bounded_without_raw_values(self):
        with tempfile.TemporaryDirectory(prefix="forward-limit-unit-") as temporary:
            path = Path(temporary) / "owned.log"
            line = b"[luckyray-forward-v1] connect=false hyper=CANCELED io=NONE depth=2 truncated=false\n"
            path.write_bytes(line * 2000); path.chmod(0o600)
            result = ci.smoke.read_forwarding_trace(path, 0)
            self.assertEqual(result["readBytes"], 65536)
            self.assertEqual(len(result["typed"]), 2)
            self.assertTrue(result["truncated"])
        raw = {"state": "hunter2", "readBytes": True, "path": "hunter2", "typed": [{"connect": "hunter2", "hyper": "hunter2",
                "io": "hunter2", "depth": 999, "reason": "hunter2"}] * 3, "legacy": ["hunter2", {"secret": "hunter2"}, "CONNECT"]}
        value = ci.bounded_forwarding(raw)
        self.assertNotIn("hunter2", json.dumps(value))
        self.assertTrue(value["truncated"])
        self.assertIsNone(value["typed"][0]["depth"])

    def test_any_unconfirmed_action_observes_processes_before_cleanup_and_preserves_failure(self):
        failure = ci.smoke.DriverFailure("TRANSPORT_ERROR", "click", transport="REMOTE_DISCONNECT", elapsed=1)
        anchors = {"driver": "held-driver", "app": {"456": "held-app"}, "nativeDriver": {"789": "held-native"}}
        driver = mock.Mock(pid=123); driver.poll.return_value = None
        def identity(pid):
            return {"123": "held-driver", "456": "held-app", "789": "held-native"}[str(pid)]
        trace = {"state": "OBSERVED", "readBytes": 90, "truncated": False,
                 "typed": [{"connect": False, "hyper": "OTHER", "io": "CONNECTION_RESET", "depth": 3, "truncated": False}], "legacy": ["SEND_REQUEST"]}
        with mock.patch.object(ci.smoke.helpers, "live_identity", side_effect=identity), mock.patch.object(ci.smoke, "read_forwarding_trace", return_value=trace) as reader:
            ci.smoke.observe_unconfirmed_failure(failure, Path("/owned/log"), 100, driver, anchors)
        reader.assert_called_once_with(Path("/owned/log"), 100)
        self.assertEqual(failure.observation["processesAtResponse"]["app"]["running"], 1)
        self.assertEqual(failure.observation["processesAtResponse"]["nativeDriver"]["running"], 1)
        self.assertEqual(failure.observation["processesAtResponse"]["driver"]["state"], "RUNNING")
        self.assertEqual(failure.observation["transport"], "REMOTE_DISCONNECT")
        self.assertEqual(failure.observation["responseState"], "UNCONFIRMED")
        self.assertEqual(failure.observation, ci.bounded_driver(failure.observation))
        self.assertNotIn("held-", json.dumps(failure.observation))
        self.assertNotIn("456", json.dumps(failure.observation))
        with mock.patch.object(ci.smoke, "observe_processes", side_effect=RuntimeError("hunter2")), \
             mock.patch.object(ci.smoke, "read_forwarding_trace", side_effect=RuntimeError("hunter2")):
            ci.smoke.observe_unconfirmed_failure(failure, Path("/owned/log"), 100, driver, anchors)
        self.assertEqual(failure.observation["forwarding"]["state"], "UNAVAILABLE")
        self.assertEqual(str(failure), "webdriver-command-failed")
        self.assertNotIn("hunter2", json.dumps(ci.bounded_driver(failure.observation)))

    def test_prepared_driver_identity_is_distinct_pinned_and_rejects_stale_source(self):
        fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
        ci.validate_driver_source(fixture.driver_source, fixture.scripts)
        for field in fixture.driver_source:
            value = copy.deepcopy(fixture.driver_source); value[field] = "hunter2"
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                ci.validate_driver_source(value, fixture.scripts)
        value = copy.deepcopy(fixture.driver_source); value["path"] = "hunter2"
        with self.assertRaises(RuntimeError):ci.validate_driver_source(value, fixture.scripts)
        with tempfile.TemporaryDirectory(prefix="driver-pin-unit-") as temporary:
            root = Path(temporary); archive = root / "wrong.crate"; archive.write_bytes(b"x" * ci.driver_source.ARCHIVE_BYTES)
            with self.assertRaisesRegex(RuntimeError, "pinned-driver-source-invalid"):
                ci.driver_source.prepare(archive, root / "source")
            self.assertFalse((root / "source").exists())
            link = root / "linked.crate"; link.symlink_to(archive)
            with self.assertRaises(RuntimeError):ci.driver_source.prepare(link, root / "linked-source")
            self.assertFalse((root / "linked-source").exists())
            source = root / "closure"; source.mkdir(mode=0o700)
            files = {name: b"owned-static-closure-only" for name in ci.driver_source.SOURCE_FILES}
            for name, data in files.items():
                path = source / name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.write_bytes(data)
            self.assertEqual(ci.driver_source.verify_closure(source), ci.driver_source.closure(files))
            (source / "src/server.rs").write_bytes(b"changed")
            self.assertNotEqual(ci.driver_source.verify_closure(source), ci.driver_source.closure(files))
            (source / "extra").symlink_to(root, target_is_directory=True)
            with self.assertRaises(RuntimeError):ci.driver_source.verify_closure(source)

    def test_prepared_driver_keeps_no_idle_upstream_connection_and_never_retries(self):
        # CI 41558569342: connect=false io=CONNECTION_RESET 3 ms into a request with every
        # process alive, i.e. a request written onto a stale pooled upstream socket.
        source = ci.driver_source
        main = "mod cli;\nmod server;\nmod webdriver;\n"
        server = ("  client\n" + source.FORWARD_ANCHOR + "\n    .await\n}\n"
                  "  let client = Client::builder(TokioExecutor::new())\n    .http1_title_case_headers(true)\n"
                  + source.POOL_ANCHOR + "\n")
        patched_main, patched = source.patch_sources(main, server)
        self.assertEqual(patched_main.count("mod luckyray_forward_diagnostics;"), 1)
        self.assertIn("    .retry_canceled_requests(false)\n    .pool_max_idle_per_host(0)\n    .build_http();", patched)
        self.assertEqual(patched.count("pool_max_idle_per_host"), 1)
        self.assertEqual(patched.count(".inspect_err(crate::luckyray_forward_diagnostics::emit)"), 1)
        self.assertNotIn("retry_canceled_requests(true)", patched)
        self.assertNotIn("retry", patched.replace("retry_canceled_requests(false)", ""))
        self.assertIn("NO_IDLE_UPSTREAM_POOL", source.KIND)
        for broken in (server.replace(source.POOL_ANCHOR, ""), server + source.POOL_ANCHOR,
                       server.replace(source.FORWARD_ANCHOR, ""), server + "    .pool_max_idle_per_host(8)\n",
                       server + "    .retry_canceled_requests(true)\n"):
            with self.subTest(broken=len(broken)), self.assertRaisesRegex(RuntimeError, "pinned-driver-source-invalid"):
                source.patch_sources(main, broken)
        with self.assertRaises(RuntimeError):
            source.patch_sources(main + "mod server;\n", server)

    def test_preview_geometry_measures_the_live_image_and_keeps_its_pass_condition(self):
        # CI 41558569342 attempt 2: preview-ready saw the decoded 32x24 image, then
        # preview-geometry failed. The probe must re-find the live node after the
        # two frames rather than measure a node the widget may have replaced.
        smoke = ci.smoke
        script = smoke.PREVIEW_GEOMETRY
        self.assertEqual(script.count("first.scrollIntoView"), 1)
        self.assertEqual(script.count("live.scrollIntoView"), 1)
        self.assertEqual(script.count("await frames()"), 2)
        self.assertIn("e.isConnected&&e.complete&&e.naturalWidth===32&&e.naturalHeight===24", script)
        self.assertIn("visible:hit===e", script)
        self.assertNotIn("click", script); self.assertNotIn("invoke", script); self.assertNotIn("dispatchEvent", script)
        preview = Path(smoke.__file__).read_text().split("def preview():", 1)[1].split("def verify_image_copy", 1)[0]
        self.assertIn('rect.get("found") is True and rect.get("visible") is True', preview)
        self.assertIn('0 < rect["centerX"] < rect["viewportWidth"] and 0 < rect["centerY"] < rect["viewportHeight"], "preview-not-visible"', preview)
        self.assertLess(preview.index('report["previewGeometry"].append'), preview.index('"preview-not-visible"'))
        # Closed projection; foreign or oversized values never leave the child.
        good = {"centerX": 10, "centerY": 10, "viewportWidth": 100, "viewportHeight": 100, "found": True, "replaced": True, "hit": "SELF"}
        self.assertEqual(smoke.preview_geometry_observation(good), {"found": True, "replaced": True, "hit": "SELF", "centerInViewport": True})
        self.assertEqual(smoke.preview_geometry_observation({"centerX": 0, "centerY": 0, "viewportWidth": 100, "viewportHeight": 100,
                                                             "found": True, "hit": "hunter2"}),
                         {"found": True, "replaced": False, "hit": None, "centerInViewport": False})
        self.assertEqual(smoke.preview_geometry_observation(None), {"found": False, "replaced": False, "hit": None, "centerInViewport": False})
        raw = [{"session": 1, "found": True, "replaced": False, "hit": "OTHER", "centerInViewport": True, "html": "hunter2"}]
        self.assertEqual(ci.bounded_preview_geometry(raw), [{"session": 1, "found": True, "replaced": False, "hit": "OTHER", "centerInViewport": True}])
        self.assertEqual(ci.bounded_preview_geometry([{}] * 3), [])
        self.assertNotIn("hunter2", json.dumps(ci.bounded_report({"previewGeometry": raw})))
        # The gate still needs a self-hit, in-viewport probe in both sessions.
        fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
        fixture.validate(fixture.raw)
        for change in (lambda r: r["previewGeometry"][0].update(hit="OTHER"), lambda r: r["previewGeometry"][1].update(centerInViewport=False),
                       lambda r: r["previewGeometry"][0].update(found=False), lambda r: r["previewGeometry"].pop()):
            raw = copy.deepcopy(fixture.raw); change(raw)
            with self.assertRaisesRegex(RuntimeError, "real-preview-pixel-evidence-missing"):
                fixture.validate(raw)


class ComponentLayoutGateTests(unittest.TestCase):
    def setUp(self):
        self.source = {"commit": "1" * 40, "tree": "2" * 40}
        self.scripts = {"layoutAudit": "3" * 64}
        self.wrapper = component_unit_payload(self.source, self.scripts)

    def test_complete_component_unit_payload_is_canonical(self):
        self.assertEqual(self.wrapper["observations"], ci.media_layout.bounded(self.wrapper["observations"]))
        ci.media_layout.validate(self.wrapper, self.source, self.scripts)

    def test_actual_display_dimensions_are_finite_bounded_numbers_only(self):
        for value in ("hunter2", True, {}, -1, 4097, 10**1000, float("inf"), float("nan")):
            with self.subTest(value=repr(value)):
                raw = copy.deepcopy(self.wrapper["observations"])
                raw["observations"][4].update(displayWidth=value, displayHeight=value)
                exported = ci.media_layout.bounded(raw)
                self.assertIsNone(exported["observations"][4]["displayWidth"])
                self.assertIsNone(exported["observations"][4]["displayHeight"])
                self.assertNotIn("hunter2", json.dumps(exported))
        raw = copy.deepcopy(self.wrapper["observations"])
        raw["observations"][4].update(displayWidth=20, displayHeight=15)
        self.assertEqual(ci.media_layout.bounded(raw)["observations"][4]["displayWidth"], 20)
        raw["observations"][4].update(displayWidth=31.984375, displayHeight=23.984375)
        self.assertEqual(ci.media_layout.bounded(raw)["observations"][4]["displayHeight"], 23.984375)

    def test_reported_success_cannot_hide_small_image_resizing_or_aspect_distortion(self):
        for width, height in ((20, 15), (32, 15), (180, 135), (0, 0)):
            with self.subTest(width=width, height=height):
                value = copy.deepcopy(self.wrapper)
                small = next(row for row in value["observations"]["observations"] if row["case"] == "live-small")
                small.update(displayWidth=width, displayHeight=height)
                self.assertTrue(small["displaySizeValid"])
                with self.assertRaises(RuntimeError):
                    ci.media_layout.validate(value, self.source, self.scripts)
        value = copy.deepcopy(self.wrapper)
        # Ordinary images may fit a narrower pane without changing aspect.
        regular = next(row for row in value["observations"]["observations"] if row["case"] == "live-regular")
        regular.update(displayWidth=160, displayHeight=120)
        ci.media_layout.validate(value, self.source, self.scripts)
        regular.update(displayHeight=80)
        with self.assertRaises(RuntimeError):
            ci.media_layout.validate(value, self.source, self.scripts)

    def test_native_audit_helpers_validate_geometry_short_socket_and_released_keys_without_launch(self):
        audit = Path(ci.__file__).with_name("linux-media-layout-audit.mjs").as_uri()
        program = """
          import assert from 'node:assert/strict';
          const {displaySizeValid,socketPathBytes,nativeBackTab} = await import(process.argv[1]);
          assert(displaySizeValid({naturalWidth:32,naturalHeight:24,width:32,height:24},true));
          assert(!displaySizeValid({naturalWidth:32,naturalHeight:24,width:180,height:135},true));
          assert(displaySizeValid({naturalWidth:320,naturalHeight:240,width:160,height:120},false));
          assert(!displaySizeValid({naturalWidth:320,naturalHeight:240,width:160,height:80},false));
          assert(socketPathBytes('/tmp/lrl-AbC123/tmp')<108);
          assert.throws(()=>socketPathBytes('/tmp/'+ 'x'.repeat(108)));
          const sent=[]; await nativeBackTab(async (method,event)=>sent.push({method,...event}));
          assert.deepEqual(sent.map(e=>e.method),Array(4).fill('Input.dispatchKeyEvent'));
          assert.deepEqual(sent.map(e=>[e.type,e.key,e.modifiers]),[
            ['keyDown','Shift',8],['keyDown','Tab',8],['keyUp','Tab',8],['keyUp','Shift',0]]);
        """
        result = subprocess.run(["node", "--input-type=module", "-e", program, audit], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_incomplete_dimensions_native_input_hit_identity_or_cleanup_cannot_pass(self):
        changes = [lambda w: w.update(childExitCode=1), lambda w: w.update(attempts=2), lambda w: w.update(attempts=True),
            lambda w: w.update(source={}), lambda w: w.update(scripts={}), lambda w: w.update(fixtureSha256="9" * 64),
            lambda w: w["observations"].update(source={}), lambda w: w["observations"].update(scriptSha256="9" * 64),
            lambda w: w["observations"].update(fixtureSourceMatches=False), lambda w: w["observations"].update(browserLaunches=2),
            lambda w: w["observations"].update(userNamespaceExitCode=1), lambda w: w["observations"].update(javascriptError="TypeError"),
            lambda w: w["observations"].update(mainProductAcceptance="PASS"), lambda w: w["observations"]["browser"].update(elf=False),
            lambda w: w["observations"]["sandbox"].update(seccompBpf=None), lambda w: w["observations"]["sandbox"].update(securityDisablingFlags=["INVALID"]),
            lambda w: w["observations"]["cleanup"].update(processGone=False), lambda w: w["observations"]["cleanup"].update(signal="SIGTERM"),
            lambda w: w["observations"]["observations"].pop(),
            lambda w: w["observations"]["observations"].append(copy.deepcopy(w["observations"]["observations"][0])),
            lambda w: w["observations"]["observations"][1].update(mode="hover"),
            lambda w: w["observations"]["observations"][0].update(viewport=560),
            lambda w: w["observations"]["observations"][0].update(naturalWidth=320),
            lambda w: w["observations"]["observations"][0].update(clickAttempts=2)]
        for key in ("displaySizeValid", "hoverApplied", "clickedOnce", *ci.media_layout.FLAGS):
            changes.append(lambda w, key=key: w["observations"]["observations"][0].update({key: False}))
        for key in ("focusWithin", "controlFocused"):
            changes.append(lambda w, key=key: w["observations"]["observations"][1].update({key: False}))
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = copy.deepcopy(self.wrapper)
                change(value)
                with self.assertRaises(RuntimeError):
                    ci.media_layout.validate(value, self.source, self.scripts)

    def test_closed_layout_projection_drops_paths_logs_and_unlabelled_secrets(self):
        value = copy.deepcopy(self.wrapper["observations"])
        value.update(error="hunter2", path="/private/hunter2", fixture="hunter2", environment={"x": "hunter2"})
        value["browser"].update(version="hunter2", path="hunter2")
        value["cleanup"].update(signal="hunter2", stderr="hunter2")
        value["observations"][0].update(case="hunter2", rectangle="hunter2", button="hunter2")
        value["sandbox"].update(evaluation="hunter2", securityDisablingFlags=["hunter2"])
        value["failure"] = {"phase": "hunter2", "code": "hunter2", "reason": "Failed hunter2"}
        exported = ci.media_layout.bounded(value)
        self.assertNotIn("hunter2", json.dumps(exported))
        self.assertEqual(exported["failure"], {"phase": "unknown", "code": "unknown"})
        for key in ("browser", "sandbox", "cleanup", "failure"):
            value[key] = ["hunter2"]
        self.assertNotIn("hunter2", json.dumps(ci.media_layout.bounded(value)))

    def test_failed_or_missing_layout_stops_main_before_attempt_or_process_launch(self):
        for wrapper in (None, {"status": "FAIL"}, self.wrapper):
            with self.subTest(wrapper=wrapper is None), tempfile.TemporaryDirectory(prefix="layout-block-unit-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.private = run.evidence = Path(temporary)
                run.source = lambda: self.source
                run.scripts = lambda: self.scripts
                value = copy.deepcopy(wrapper)
                if value and value.get("status") == "PASS":
                    value["observations"]["observations"][1]["allButtonCentersHit"] = False
                ci.write_json(run.evidence / "notes.json", {"componentLayout": value})
                with mock.patch.object(ci.subprocess, "run") as launcher, self.assertRaises(RuntimeError):
                    run.notes()
                launcher.assert_not_called()
                self.assertFalse((run.private / "notes.attempt").exists())

    def test_failed_fixture_is_closed_and_never_launches_the_browser_child(self):
        with tempfile.TemporaryDirectory(prefix="layout-setup-unit-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.private = Path(temporary) / "private"
            run.evidence = Path(temporary) / "evidence"
            run.private.mkdir(); run.evidence.mkdir()
            run.app = Path(ci.__file__).resolve().parents[1]
            run.args = type("Args", (), {"node": "node"})()
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            run.env = lambda: {}
            with mock.patch.object(ci.subprocess, "run", side_effect=OSError("hunter2")), mock.patch.object(ci.subprocess, "Popen") as launcher:
                with self.assertRaisesRegex(RuntimeError, "^component-layout-precondition-failed$"):
                    run.layout()
            launcher.assert_not_called()
            report = ci.read_json(run.evidence / "notes.json")
            self.assertNotIn("hunter2", json.dumps(report))
            self.assertEqual((report["status"], report["flowCount"], report["attempts"]), ("NOT_RUN", 0, 0))
            self.assertEqual(report["componentLayout"]["failure"], "fixture-build-failed")

    def test_layout_block_exports_the_exact_json_set_with_native_reports_not_run(self):
        with tempfile.TemporaryDirectory(prefix="layout-finish-unit-") as temporary:
            run = ci.Run.__new__(ci.Run)
            run.evidence = Path(temporary)
            run.source = lambda: self.source
            run.scripts = lambda: self.scripts
            ci.write_json(run.evidence / "source.json", {"status": "PASS", "scope": ci.SCOPE, "source": self.source})
            ci.write_json(run.evidence / "notes.json", {"status": "NOT_RUN", "scope": ci.SCOPE, "source": self.source,
                "attempts": 0, "flowCount": 0, "componentLayout": {"status": "FAIL", "failure": "layout-child-failed"}})
            outcomes = {"CI_" + key: "success" if key in ("CHECKOUT", "INIT", "NODE", "OFFLINE", "FRONTEND") else "skipped" for key in ci.STEPS}
            outcomes["CI_LAYOUT"] = "failure"
            with mock.patch.dict(os.environ, outcomes), self.assertRaises(RuntimeError):
                run.finish()
            result = ci.read_json(run.evidence / "result.json")
            self.assertEqual(set(path.name for path in run.evidence.iterdir()), set(ci.EXPORTS))
            self.assertEqual(result["reports"], {"source.json": "PASS", "build.json": "NOT_RUN", "resources.json": "NOT_RUN",
                                             "notes.json": "NOT_RUN", "nativeMessaging.json": "NOT_RUN"})
            self.assertEqual(result["included"], {"notesPngFlows": 0, "componentLayout": "FAIL"})
            self.assertEqual((result["status"], result["exportPolicy"], result["productAcceptance"]), ("FAIL", "PASS", "NOT_RUN"))

    def test_unavailable_sandbox_browser_or_clipped_controls_stay_closed_and_block_main(self):
        for phase in ("user-namespace", "browser-identity", "native-focus"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="layout-child-unit-") as temporary:
                run = ci.Run.__new__(ci.Run)
                run.private, run.evidence = Path(temporary) / "private", Path(temporary) / "evidence"
                run.private.mkdir(); run.evidence.mkdir()
                run.app = Path(ci.__file__).resolve().parents[1]
                run.args = type("Args", (), {"node": "node"})()
                run.source, run.scripts, run.env = lambda: self.source, lambda: self.scripts, lambda: {}
                def build_fixture(*args, **kwargs):
                    (run.private / "component-layout/fixture/index.html").write_text("owned-unit-not-rendered")
                    return type("Result", (), {"returncode": 0})()
                def finish_child(*args, **kwargs):
                    value = copy.deepcopy(self.wrapper["observations"])
                    value.update(status="FAIL", failure={"phase": phase, "code": phase + "-failed", "reason": "hunter2"}, log="hunter2")
                    ci.write_json(run.private / "component-layout/report.json", value)
                    return 1
                child = mock.Mock()
                child.wait.side_effect = finish_child
                with mock.patch.object(ci.subprocess, "run", side_effect=build_fixture), mock.patch.object(ci.subprocess, "Popen", return_value=child) as process:
                    with self.assertRaisesRegex(RuntimeError, "^component-layout-precondition-failed$"):
                        run.layout()
                self.assertEqual(process.call_count, 1)
                self.assertTrue(process.call_args.kwargs["start_new_session"])
                saved = ci.read_json(run.evidence / "notes.json")
                self.assertEqual(saved["componentLayout"]["observations"]["failure"], {"phase": phase, "code": phase + "-failed"})
                self.assertEqual(saved["componentLayout"]["childExitCode"], 1)
                self.assertEqual((saved["status"], saved["flowCount"]), ("NOT_RUN", 0))
                self.assertNotIn("hunter2", json.dumps(saved))
                with mock.patch.object(ci.subprocess, "run") as launcher, self.assertRaises(RuntimeError):
                    run.notes()
                launcher.assert_not_called()
                self.assertFalse((run.private / "notes.attempt").exists())


class AttachmentMutationSourceTests(unittest.TestCase):
    """Source-level invariants for the Linux replace/remove/rollback engine.

    These are offline proofs about the code that ships, not a substitute for the
    Rust filesystem tests (which run in the dedicated `rust` step) or for the
    native flow. A PASS here means only that the shape is closed.
    """

    source = Path(__file__).resolve().parents[1] / "src-tauri" / "src"

    def read(self, relative):
        return (self.source / relative).read_text()

    def test_step4_copy_publish_and_delete_hardening_are_wired(self):
        publish = self.read("linux_attachment_publish.rs")
        delete = self.read("linux_material_delete.rs")
        for source in (publish, delete):
            for forbidden in ("remove_file", "unlink(", "remove_dir", "O_TRUNC", "trash::", "gio trash"):
                self.assertNotIn(forbidden, source)
        self.assertNotIn("unlinkat", delete)
        # The only unlink is this call's own failed stage, after a no-follow
        # dev+inode match against the held handle (Windows removes its temp).
        self.assertEqual(publish.count("unlinkat"), 1)
        discard = publish.split("fn discard_own_stage", 1)[1].split("fn publish_stage", 1)[0]
        self.assertIn("libc::unlinkat", discard)
        for check in ("AT_SYMLINK_NOFOLLOW", "stat.st_dev as u64 != std::os::unix::fs::MetadataExt::dev(&held)",
                      "stat.st_ino as u64 != std::os::unix::fs::MetadataExt::ino(&held)", "S_IFREG"):
            self.assertLess(discard.index(check), discard.index("libc::unlinkat"))
        self.assertIn("create_private(&stage", publish)
        self.assertIn("rename_new(stage, &self.attachments, name)", publish)
        self.assertIn("root.lock()?", publish)
        self.assertIn("move_held_no_replace(&file, original, quarantine)", delete)
        self.assertIn("move_path_no_replace(quarantine, original)", delete)
        attachments = self.read("knowledge/attachments.rs")
        self.assertIn("return linux_publish_bytes_with_reuse(root, inventory, note, name, bytes, reuse_content);", attachments)
        self.assertIn("return self.linux_publish_companion_attachment(", attachments)
        catalog = self.read("materials/catalog.rs")
        self.assertIn('#[cfg(target_os = "linux")]\n        self.linux_quarantine_for_delete(', catalog)
        self.assertIn('#[cfg(not(target_os = "linux"))]\n        if let Err(error) = std::fs::rename(&owned_file.file_path, &quarantine_path)', catalog)
        self.assertIn('#[cfg(not(target_os = "linux"))]\n                std::fs::rename(&validated.quarantine_path, &validated.original_path)', catalog)
        purge = catalog.split("fn purge_delete_quarantine_in_transaction", 1)[1]
        self.assertLess(purge.index("self.linux_verify_quarantine_before_purge(&validated)?;"),
                        purge.index("std::fs::remove_file(&validated.quarantine_path)"))
        lib = self.read("lib.rs")
        for module in ("linux_attachment_publish", "linux_material_delete"):
            self.assertIn(f'#[cfg(target_os = "linux")]\nmod {module};', lib)

    def test_attachment_mutation_sources_never_unlink_a_user_object(self):
        # `linux_material_move.rs` is checked separately below: its cross-volume
        # path must unlink the source it copied (Windows v1.9.9 does the same
        # with delete-on-close), and that single site is position-pinned.
        files = ("linux_attachment_store.rs", "knowledge/linux_attachment_mutations.rs",
                 "knowledge/linux_attachment_import.rs")
        banned = ("remove_file(", "remove_dir(", "fs::remove_", "unlinkat(", "libc::unlink",
                  "RENAME_EXCHANGE", "shutil.")
        for name in files:
            text = self.read(name)
            for token in banned:
                with self.subTest(file=name, token=token):
                    self.assertNotIn(token, text)
        move = self.read("linux_material_move.rs")
        # `libc::unlink` (the path-based syscall) stays banned; only the
        # directory-relative `unlinkat` below is allowed, once.
        for token in ("remove_file(", "remove_dir(", "fs::remove_", "libc::unlink(", "RENAME_EXCHANGE"):
            with self.subTest(file="linux_material_move.rs", token=token):
                self.assertNotIn(token, move)
        # Exactly one unlinkat in the whole module, and it is the source removal
        # of the copy path.
        self.assertEqual(move.count("unlinkat("), 2, "the commit cleanup and the source removal")
        source_unlink = move.split("fn run(&self, expected_sha256: &str) -> io::Result<()> {", 1)[1]
        cleaned = source_unlink.split("fn copy_held_no_replace(", 1)[0]
        self.assertEqual(cleaned.count("libc::unlinkat("), 1)
        # Order inside that function: copy+flush, digest check, publish, target
        # directory fsync, then the stamp re-check, and only then the unlink.
        self.assertLess(cleaned.index("self.staged.sync_all()?;"),
                        cleaned.index("rename_no_replace(&self.to, &self.temporary, &self.to, &self.to_name)?;"))
        after_publish = cleaned.split(
            "rename_no_replace(&self.to, &self.temporary, &self.to, &self.to_name)?;", 1)[1]
        order = ("self.to.file.sync_all()?;", "named(&self.to, &self.to_name)?;",
                 "stamp_at(&self.from, &self.from_name)?", "libc::unlinkat(self.from.file.as_raw_fd()",
                 "self.from.file.sync_all()?;")
        positions = [after_publish.index(token) for token in order]
        self.assertEqual(positions, sorted(positions), "publish fsync, verify, then unlink")
        # The rename path keeps its own reverse-only rule.
        rename_path = move.split("impl<'a> PreparedMove<'a> {", 1)[1].split("/// Move the held, already-verified source object", 1)[0]
        self.assertNotIn("unlinkat(", rename_path)
        self.assertNotIn("write_all(", rename_path)
        store = self.read("linux_attachment_store.rs")
        # The only two inverses the engine may use: a no-replace rename in both
        # directions, and the tombstone name that keeps the original inode.
        self.assertIn("rename_new", store)
        self.assertIn('format!(".lrk-{}-{index}.removed", self.id)', store)
        self.assertIn("RENAME_NOREPLACE", self.read("linux_fs.rs"))

    def test_attachment_kind_whitelist_is_closed_and_rollback_is_routed(self):
        admit = self.read("knowledge/linux_attachment_import.rs")
        self.assertEqual(sorted(set(re.findall(r'"([a-z-]+)" =>', admit))),
                         ["attachment-relink", "attachment-rename", "conversion",
                          "external-reference-update", "import", "note-move"])
        self.assertIn("_ => Err(linux_knowledge_write_unavailable())", admit)
        mutations = self.read("knowledge/linux_attachment_mutations.rs")
        execute = mutations.split("fn execute_linux_attachment_operation_unlocked", 1)[1].split(
            "fn recover_linux_attachment_operation_unlocked", 1)[0]
        self.assertIn('"import" => self.execute_linux_attachment_import_unlocked', execute)
        for kind in ("attachment-rename", "conversion", "note-move", "external-reference-update",
                     "attachment-relink"):
            self.assertIn('"{}"'.format(kind), execute)
        self.assertIn(".execute_linux_attachment_mutation_unlocked(", execute)
        self.assertIn("_ => Err(linux_knowledge_write_unavailable())", execute)
        # Rollback is passed through, not flattened to a refusal.
        recover = mutations.split("fn recover_linux_attachment_operation_unlocked", 1)[1]
        self.assertIn("rollback,", recover)
        self.assertIn("self.run_linux_attachment_mutation(", recover)
        operations = self.read("knowledge/attachment_operations.rs")
        for name in ("execute_linux_attachment_operation_unlocked",
                     "recover_linux_attachment_operation_unlocked"):
            with self.subTest(call=name):
                args = operations.split("self." + name + "(", 1)[1].split(");", 1)[0]
                self.assertIn("source_epoch", args)
        self.assertIn("_ => Err(linux_knowledge_write_unavailable())",
                      self.read("knowledge/linux_attachment_import.rs"))

    def test_step_two_kinds_keep_their_closed_shapes(self):
        admit = self.read("knowledge/linux_attachment_import.rs")
        conversion = admit.split("fn admit_conversion", 1)[1].split("fn admit_note_move", 1)[0]
        # Copies first, never a rewrite before the copy it points at, no removal.
        self.assertIn("if markdown || rewriting {", conversion)
        self.assertIn("(Some(_), None) | (None, None) => return Err(", conversion)
        self.assertIn("if created == 0 {", conversion)
        note_move = admit.split("fn admit_note_move", 1)[1].split(
            "fn admit_external_reference_update", 1)[0]
        self.assertIn("if operation.files.len() != 2", note_move)
        self.assertIn("|| published.before.is_some()", note_move)
        self.assertIn("|| removed.after.is_some()", note_move)
        self.assertIn("!operation.attachment_dependencies.is_empty()", note_move)
        external = admit.split("fn admit_external_reference_update", 1)[1]
        self.assertIn('if !file.relative_path.to_ascii_lowercase().ends_with(".md") {', external)
        self.assertIn("!operation.external_paths.is_empty()", external)

    def test_material_file_move_admission_is_closed(self):
        admit = self.read("knowledge/linux_attachment_import.rs")
        relink = admit.split("fn admit_material_file_move", 1)[1].split("impl KnowledgeService", 1)[0]
        # Only the material file move; the relocation shape (恢复附件位置) stays out.
        self.assertIn("let Some(movement) = operation.material_file_move.as_ref() else {", relink)
        for token in ("|| operation.material_relocation.is_some()",
                      "|| operation.material_revision.is_some()",
                      "|| operation.material_original_path.is_some()",
                      "|| !operation.attachment_dependencies.is_empty()",
                      "|| operation.external_dependencies.len() != 1",
                      "|| operation.external_dependencies[0].0 != movement.original_path",
                      "|| operation.external_dependencies[0].1 != movement.expected_hash",
                      "|| operation.external_paths.len() != operation.files.len()",
                      "if path != &movement.destination_path",
                      'if !file.relative_path.to_ascii_lowercase().ends_with(".md") {',
                      "let before = bytes(&file.before)?.ok_or_else(linux_knowledge_write_unavailable)?;",
                      "let after = bytes(&file.after)?.ok_or_else(linux_knowledge_write_unavailable)?;"):
            with self.subTest(token=token):
                self.assertIn(token, relink)
        # The durable result stays pending until the catalog has moved the file,
        # exactly like the Windows runner.
        mutations = self.read("knowledge/linux_attachment_mutations.rs")
        runner = mutations.split("fn run_linux_attachment_mutation(", 1)[1].split("\n    fn ", 1)[0]
        self.assertIn("|| operation.material_file_move.is_some()", runner)
        self.assertIn('status: "attachment-projection-pending".into(),', runner)
        self.assertIn("serde_json::to_vec(&durable_result)", runner)
        self.assertIn("Ok(result)", runner)

    def test_material_file_move_renames_within_one_filesystem_and_copies_across(self):
        lib = self.read("lib.rs")
        self.assertIn('#[cfg(target_os = "linux")]\nmod linux_material_move;', lib)
        primitive = self.read("linux_material_move.rs")
        self.assertIn("libc::RENAME_NOREPLACE", primitive)
        self.assertIn("libc::AT_SYMLINK_NOFOLLOW", primitive)
        self.assertIn("libc::O_NOFOLLOW", primitive)
        # Same filesystem: the rename path still refuses a foreign device.
        self.assertIn("return Err(cross_device());", primitive)
        # The rename path never copies, truncates or rewrites bytes.
        rename_path = primitive.split("pub(crate) struct PreparedMove<'a> {", 1)[1] \
            .split("/// Source identity with the fields a copy must re-check", 1)[0]
        for token in ("std::io::copy", "fs::copy", "set_len(", ".truncate(", "O_TRUNC",
                      "write(", "write_all("):
            with self.subTest(token=token, path="rename"):
                self.assertNotIn(token, rename_path)
        # Cross filesystem: the copy path exists and only the EXDEV branch uses it.
        self.assertIn("pub(crate) fn copy_held_no_replace(", primitive)
        self.assertIn("PreparedCopy::prepare(source, from, destination)?.commit(expected_sha256)", primitive)
        self.assertIn('"attachment-move-source-kept"', primitive)
        copy_path = primitive.split("pub(crate) struct PreparedCopy<'a> {", 1)[1]
        self.assertIn("write_all(", copy_path)
        self.assertIn("sha2", copy_path)
        # The temporary lives in the destination directory under the name the
        # residue scan recognises.
        self.assertIn('".lrk-move-{}-{}.tmp"', primitive)
        self.assertIn("to_dir.create(OsStr::from_bytes(temporary.as_bytes()), b\"\")", primitive)
        catalog_call = self.read("materials/catalog.rs").split("fn linux_move_owned_handle_no_replace(", 1)[1]
        branch = catalog_call.split("if crate::linux_material_move::is_cross_device(&error) => {", 1)
        self.assertEqual(len(branch), 2, "the copy runs only from the cross-device branch")
        self.assertIn("crate::linux_material_move::copy_held_no_replace(", branch[1].split("}", 1)[0])
        catalog = self.read("materials/catalog.rs")
        # The Windows/Mac primitives and their call sites are untouched; Linux
        # has its own functions, chosen by cfg at the two call sites.
        for line in (
                "fn move_owned_handle_no_replace(source:&mut std::fs::File,destination:&Path)"
                "->std::io::Result<Option<std::fs::File>> {",
                "fn move_owned_file_no_replace(source:&Path,destination:&Path)->std::io::Result<()> {",
                '    #[cfg(not(windows))] {let _=(source,destination);Err(std::io::Error::new('
                'std::io::ErrorKind::Unsupported,"Coordinated physical moves require Windows"))}',
                '    #[cfg(not(windows))] { let _=(source,destination);Err(std::io::Error::new('
                'std::io::ErrorKind::Unsupported,"Coordinated physical moves require Windows")) }',
                "    #[cfg(not(windows))] let _=(source,destination);",
                '            #[cfg(not(target_os = "linux"))]\n'
                "            let copied_guard=move_owned_handle_no_replace(&mut source_guard, &destination)"
                ".map_err(|error| {",
                "                if let Err(restore_error) = move_owned_file_no_replace(&renamed, &original) {"):
            with self.subTest(line=line[:60]):
                self.assertIn(line, catalog)
        self.assertIn('            #[cfg(target_os = "linux")]\n'
                      "            let copied_guard=linux_move_owned_handle_no_replace(&mut source_guard, "
                      "&owned.file_path, &destination, &owned.content_hash)?;", catalog)
        self.assertIn('                #[cfg(target_os = "linux")]\n'
                      "                let move_owned_file_no_replace = linux_move_owned_file_no_replace;",
                      catalog)
        handle = catalog.split("fn linux_move_owned_handle_no_replace(", 1)[1].split("\nfn ", 1)[0]
        self.assertIn("crate::linux_material_move::move_held_no_replace(source,source_path,destination)",
                      handle)
        self.assertIn("Ok(None)", handle)
        restore = catalog.split("fn linux_move_owned_file_no_replace(", 1)[1].split("\n}", 1)[0]
        self.assertIn("hold_material_parent_directories(source,destination)", restore)
        self.assertIn("crate::linux_material_move::move_path_no_replace(source,destination)", restore)
        for name in ("linux_move_owned_handle_no_replace", "linux_move_owned_file_no_replace",
                     "linux_reject_cross_device", "linux_cross_device_error"):
            with self.subTest(gated=name):
                self.assertIn('#[cfg(target_os = "linux")]\nfn ' + name + "(", catalog)
        parents = catalog.split("fn hold_material_parent_directories(", 1)[1].split("\nfn ", 1)[0]
        self.assertIn("crate::linux_material_move::hold_parents(source,destination)", parents)
        # Cross-filesystem is refused at preview, before any note is rewritten.
        prepare = catalog.split("fn prepare_note_file_move(", 1)[1].split("pub(crate) fn ", 1)[0]
        self.assertIn("linux_reject_cross_device(&owned.file_path,&destination)?;", prepare)
        self.assertIn('MaterialError::new("attachment-move-cross-device",LINUX_CROSS_DEVICE_MESSAGE)',
                      catalog)
        # The SQLite-failure recovery still moves the renamed file back.
        rename = catalog.split("fn rename_asset_file_internal(", 1)[1].split("\n    pub", 1)[0]
        self.assertIn("move_owned_file_no_replace(&renamed, &original)", rename)
        self.assertIn('return Err(MaterialError::new("physical-path-owned","目标文件已存在，不能覆盖，未做任何修改"))',
                      catalog)

    def test_material_move_follows_v1_9_9_links_and_refuses_unsupported_renameat2(self):
        # Owner decision on T12 §5: Windows v1.9.9 moves a material that still
        # has a second hard link, so the move path carries the link count in its
        # identity (compared around the rename) but must not require nlink==1.
        # The delete quarantine keeps that requirement.
        primitive = self.read("linux_material_move.rs")
        self.assertIn("links: u64", primitive)
        self.assertIn("if !m.is_file() {", primitive)
        self.assertNotIn("m.nlink() != 1", primitive)
        self.assertNotIn("stat.st_nlink as u64 != 1", primitive)
        self.assertIn("links: m.nlink(),", primitive)
        self.assertIn("links: stat.st_nlink as u64,", primitive)
        # T02 §5.6.2/§5.6.4: a kernel/filesystem without RENAME_NOREPLACE is
        # an explicit capability refusal, not a generic rename error.
        self.assertIn("Some(libc::ENOSYS) | Some(libc::EINVAL)", primitive)
        self.assertIn("rename_capability_error(error)", primitive)
        catalog = self.read("materials/catalog.rs")
        handle = catalog.split("fn linux_move_owned_handle_no_replace(", 1)[1].split("\nfn ", 1)[0]
        self.assertIn('MaterialError::new("knowledge-linux-fs-unsupported",'
                      '"当前文件系统不支持安全的文件移动，未做任何修改")', handle)
        self.assertIn("error.kind()==std::io::ErrorKind::Unsupported", handle)
        delete = self.read("linux_material_delete.rs")
        self.assertIn("if !m.is_file() || m.nlink() != 1 {", delete)
        # The offline crate proves both rules are executable, not only textual.
        tests = (Path(__file__).resolve().parents[1] /
                 "tests/linux-import-transaction/src/lib.rs").read_text()
        self.assertIn("fn material_move_follows_v1_9_9_and_moves_a_hard_linked_source()", tests)
        self.assertIn("fn renameat2_capability_failure_is_explicit_and_never_confused_with_a_conflict()", tests)
        self.assertIn("fn publish_rename_capability_failure_is_marked_and_stage_scoped()", tests)

    def test_publish_rename_capability_failure_has_its_own_code(self):
        # T02 §5.6.2/§5.6.4 for step 4: a filesystem without RENAME_NOREPLACE is
        # refused with knowledge-linux-fs-unsupported and "nothing was modified",
        # without touching the shared linux_transactions::failure mapping or any
        # step-1 code. ACL/xattr refusals keep permissions-unsupported.
        publish = self.read("linux_attachment_publish.rs")
        self.assertIn('pub(crate) const UNSUPPORTED_RENAME: &str = "linux-renameat2-unsupported";', publish)
        self.assertIn("fn rename_capability_error(error: io::Error) -> io::Error {", publish)
        self.assertIn("Some(libc::ENOSYS) | Some(libc::EINVAL)", publish)
        self.assertIn("io::Error::new(io::ErrorKind::Unsupported, UNSUPPORTED_RENAME)", publish)
        stage = publish.split("fn publish_stage(", 1)[1].split("\n    fn ", 1)[0]
        self.assertIn("self.attachments.rename_new(stage, &self.attachments, name).map_err(|error| {", stage)
        self.assertIn("self.vacant(name).unwrap_or(false)", stage)
        self.assertIn("return rename_capability_error(error);", stage)
        attachments = self.read("knowledge/attachments.rs")
        adapter = attachments.split("fn linux_publish_failure(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("crate::linux_attachment_publish::UNSUPPORTED_RENAME", adapter)
        self.assertIn('"knowledge-linux-fs-unsupported"', adapter)
        self.assertIn("当前文件系统不支持安全的附件发布，未做任何修改", adapter)
        # The shared mapping and the step-1 codes are untouched.
        shared = self.read("knowledge/linux_transactions.rs")
        self.assertNotIn("knowledge-linux-fs-unsupported", shared)
        self.assertIn('"knowledge-permissions-unsupported"', shared)
        # The offline crate proves the classification is executable.
        tests = (Path(__file__).resolve().parents[1] /
                 "tests/linux-import-transaction/src/lib.rs").read_text()
        self.assertIn("fn publish_rename_capability_failure_is_marked_and_stage_scoped()", tests)

    def test_canvas_and_workspace_writes_fsync_the_directory_entry(self):
        # T14: Windows commits canvas and workspace writes with
        # MOVEFILE_WRITE_THROUGH / a write-through commit handle. The Linux
        # branches must fsync the directory entry after the replace, must not
        # touch macOS, and the canvas write path must be executable offline.
        primitive = self.read("linux_fs.rs")
        self.assertIn("pub(crate) fn sync_directory(directory: &Path) -> io::Result<()> {", primitive)
        self.assertIn("libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC", primitive)
        canvas = self.read("canvas_agent.rs")
        self.assertIn("#[cfg(target_os = \"linux\")]\n            crate::linux_fs::sync_directory(", canvas)
        self.assertIn('#[cfg(all(test, target_os = "linux"))]\nmod linux_replace_tests {', canvas)
        workspace = self.read("agent_workspace.rs")
        replace_body = workspace.split("#[cfg(not(windows))]\nfn replace_file_atomic(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("#[cfg(target_os = \"linux\")]\n    crate::linux_fs::sync_directory(", replace_body)
        move_body = workspace.split("#[cfg(not(windows))]\nfn move_file_no_replace(", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("#[cfg(target_os = \"linux\")]\n    crate::linux_fs::sync_directory(", move_body)
        # The offline crate compiles the canvas module (chrono pinned like
        # src-tauri) and proves replace/read-back/no-temporary/cleanup. Those
        # tests live next to the writer, the fsync proof lives in the crate.
        cargo = (Path(__file__).resolve().parents[1] /
                 "tests/linux-import-transaction/Cargo.toml").read_text()
        self.assertIn('chrono = "=0.4.45"', cargo)
        offline = (Path(__file__).resolve().parents[1] /
                   "tests/linux-import-transaction/src/lib.rs").read_text()
        self.assertIn('#[path = "../../../src-tauri/src/canvas_agent.rs"]\nmod canvas_agent;', offline)
        self.assertIn("fn directory_entry_fsync_is_the_write_through_equivalent()", offline)
        for name in ("replace_creates_reads_back_and_leaves_no_temporary",
                     "failed_replace_keeps_the_previous_document_and_cleans_the_temporary",
                     "replace_needs_an_existing_parent_directory"):
            self.assertIn(f"fn {name}()", canvas)

    def test_native_messaging_evidence_is_closed_and_gated(self):
        # T21: the native-host registration + round-trip evidence is a closed
        # projection, every step must be PASS, and the run must be source-bound
        # to the smoke script that produced it.
        self.assertEqual(ci.bounded_native_messaging({}), {
            "registration": None, "revocation": None, "reenable": None, "sourceIdentity": None,
            "conflictAndSymlinkPreservation": None, "independentBackupAndOldInode": None,
            "credentialNamespaceUnchanged": None, "roundTrip": None,
            "applicationSha256": None, "scriptSha256": None, "roundTripFrames": None,
            "realBrowser": None, "roundTripRefusalCode": None})
        passing = {"registration": True, "revocation": True, "reenable": True, "sourceIdentity": True,
                   "conflictAndSymlinkPreservation": True, "independentBackupAndOldInode": True,
                   "credentialNamespaceUnchanged": True, "roundTrip": True,
                   "applicationSha256": "a" * 64,
                   "scriptSha256": hashlib.sha256(Path(__file__).with_name(
                       "linux-native-registration-smoke.py").read_bytes()).hexdigest(),
                   "roundTripFrames": 1, "realBrowser": "NOT_RUN",
                   "roundTripRefusalCode": "app-unavailable"}
        # The smoke reports the CLI steps as "PASS", not as booleans; both forms
        # normalise to the same closed projection.
        self.assertEqual(ci.bounded_native_messaging(dict(passing, registration="PASS")), passing)
        self.assertEqual(ci.bounded_native_messaging(dict(passing, registration="FAIL")),
                         dict(passing, registration=None))
        projected = ci.bounded_native_messaging(passing)
        self.assertEqual(projected, passing)
        self.assertEqual(ci.bounded_native_messaging(projected), projected)
        scripts = {"nativeMessaging": passing["scriptSha256"]}
        ci.validate_native_messaging(projected, scripts)
        for name in ("registration", "revocation", "reenable", "sourceIdentity",
                     "conflictAndSymlinkPreservation", "independentBackupAndOldInode",
                     "credentialNamespaceUnchanged", "roundTrip"):
            broken = dict(passing); broken[name] = False
            with self.subTest(flag=name), self.assertRaisesRegex(RuntimeError, "native-messaging-"):
                ci.validate_native_messaging(ci.bounded_native_messaging(broken), scripts)
        for name, value in (("roundTripFrames", 2), ("scriptSha256", "b" * 64),
                            ("realBrowser", "CHROME"), ("roundTripRefusalCode", "")):
            broken = dict(passing); broken[name] = value
            with self.subTest(field=name), self.assertRaisesRegex(RuntimeError, "native-messaging-"):
                ci.validate_native_messaging(ci.bounded_native_messaging(broken), scripts)
        canary = "/home/runner/secret-profile"
        raw = dict(passing, path=canary, manifest=canary, profile=canary, roundTripRefusalCode=canary * 4)
        self.assertNotIn("runner", json.dumps(ci.bounded_native_messaging(raw)))

    def test_native_messaging_is_wired_into_the_preflight_workflow(self):
        # T21: a real step after BUILD builds the host from this source tree,
        # runs the registration smoke, publishes the report, and finish() reads
        # its outcome so a failure cannot be swallowed.
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/linux-desktop-preflight.yml"
        text = workflow.read_text()
        build = text.index("Build the actual Main once for the focused product flow")
        native = text.index("Register the built native host and complete one real Native Messaging exchange")
        driver = text.index("Build the source-bound pinned WebDriver with closed diagnostics once")
        self.assertLess(build, native)
        self.assertLess(native, driver)
        step = text[native:driver]
        self.assertIn("id: native-messaging", step)
        self.assertIn("cargo build --locked --bin luckyray-native-host", step)
        self.assertIn("--features sidecar-binaries", step)
        self.assertIn("linux-native-registration-smoke.py", step)
        self.assertIn("--application", step)
        self.assertIn("linux-notes-ci.py native-messaging --work", step)
        self.assertNotIn("curl", step)  # nothing is downloaded for this step
        self.assertIn("CI_NATIVE_MESSAGING", text)
        self.assertIn("evidence/nativeMessaging.json", text)
        self.assertIn("nativeMessaging.json", ci.EXPORTS)
        self.assertIn("NATIVE_MESSAGING", ci.STEPS)
        self.assertLess(ci.STEPS.index("BUILD"), ci.STEPS.index("NATIVE_MESSAGING"))

    def test_community_mcp_secrets_and_process_use_the_linux_seams(self):
        # T20: the plugin's two secrets live in the Secret Service through the
        # T19 backend (no second keyring client), and the plugin process is
        # owned by a fresh process group instead of a Windows job object.
        module = self.read("community_mcp_secret.rs")
        self.assertIn('pub(crate) const SERVICE: &str = "app.luckyray.community-mcp";', module)
        self.assertIn('pub(crate) const TUNNEL_KEY: &str = "tunnel-key";', module)
        self.assertIn('pub(crate) const CREDENTIAL: &str = "credential";', module)
        self.assertIn('pub(crate) const STORAGE_FAILED: &str = "private-secret-storage-failed";', module)
        self.assertIn("pub(crate) fn secret(", module)
        self.assertIn("pub(crate) fn has_key(", module)
        self.assertIn('"未找到系统钥匙环，未做任何修改"', module)
        self.assertIn('"系统钥匙环已锁定，未做任何修改"', module)
        self.assertNotIn("fs::", module)
        gateway = self.read("community_mcp.rs")
        # Linux branches delegate; Windows keeps the PowerShell helper path.
        self.assertIn("crate::community_mcp_secret::secret(", gateway)
        # Each secret name gets its own keyring account (no shared backend
        # that would let `credential` overwrite `tunnel-key`).
        self.assertIn("crate::community_mcp_secret::account(name)?,", gateway)
        self.assertIn("crate::community_mcp_secret::secret(&backend, action, name, input)", gateway)
        self.assertNotIn("linux_secret_backend", gateway)
        self.assertIn('secret(p, "initialize", "tunnel-key", None)?;\n        return Ok(());', gateway)
        self.assertIn("fn tunnel_key_present(p: &Paths) -> bool", gateway)
        self.assertIn('"hasKey":tunnel_key_present(&p)', gateway)
        self.assertIn('std::env::var_os("SystemRoot")', gateway)
        self.assertIn("powershell.exe", gateway)
        self.assertIn('"private-secret-storage-failed"', gateway)
        # Pairing refuses on Linux before writing anything.
        self.assertIn('return Err("plugin-platform-unsupported".into());', gateway)
        lib = self.read("lib.rs")
        self.assertIn('#[cfg(target_os = "linux")]\nmod community_mcp_secret;', lib)
        keyring = self.read("companion_keyring.rs")
        self.assertIn("pub(crate) fn for_account(service: &'static str, account: &str) -> Self", keyring)
        process = self.read("community_mcp_process.rs")
        self.assertIn("crate::owned_process::spawn_in_owned_job(", process)
        self.assertIn("terminate_and_wait(std::time::Duration::from_secs(5))", process)
        self.assertIn('"plugin-stop-failed"', process)
        self.assertIn('"plugin-start-failed"', process)
        # macOS keeps the previous stub.
        self.assertIn('#[cfg(not(any(windows, target_os = "linux")))]\npub(crate) fn spawn(', process)
        # The synthetic process-group proof exists next to the launcher.
        owned = self.read("owned_process/linux.rs")
        self.assertIn("fn stopping_the_group_leaves_no_descendant_of_the_plugin_shaped_tree()", owned)
        self.assertIn('"sleep 60 & echo $!; exec sleep 60"', owned)

    def test_companion_keyring_uses_the_secret_service_without_touching_windows(self):
        # T19: the Linux identity store is backed by the freedesktop Secret
        # Service through keyring v3 with the pure-Rust backend, never by a
        # plaintext file, and Windows/macOS keep their existing branches.
        cargo = (Path(__file__).resolve().parents[1] / "src-tauri/Cargo.toml").read_text()
        def section(header):
            lines = cargo.splitlines()
            body = []
            for line in lines[lines.index(header) + 1:]:
                if line.startswith("["):
                    break
                body.append(line)
            return "\n".join(body)

        linux_block = section("[target.'cfg(target_os = \"linux\")'.dependencies]")
        self.assertIn('keyring = { version = "=3.6.3"', linux_block)
        self.assertIn('default-features = false', linux_block)
        for feature in ('"async-secret-service"', '"tokio"', '"crypto-rust"'):
            self.assertIn(feature, linux_block)
        self.assertNotIn('"sync-secret-service"', linux_block)
        # The Windows/macOS dependency sections must not mention the keyring.
        for header in ("[dependencies]", "[target.'cfg(windows)'.dependencies]"):
            self.assertNotIn("keyring", section(header), header)
        module = self.read("companion_keyring.rs")
        self.assertIn('pub(crate) const SERVICE: &str = "app.luckyray.companion-gateway";', module)
        self.assertIn('pub(crate) const ACCOUNT: &str = "desktop-identity-v1";', module)
        self.assertIn("pub(crate) trait SecretBackend: Send + Sync {", module)
        self.assertIn("pub(crate) struct SecretServiceBackend {", module)
        self.assertIn("fn encode_identity(plaintext: &[u8]) -> Zeroizing<String>", module)
        self.assertIn("fn decode_identity(encoded: &[u8]) -> Result<Zeroizing<Vec<u8>>, KeyringFailure>", module)
        # The failure kinds are decided in one place, and a locked store is not
        # collapsed into "unavailable".
        self.assertIn("keyring::Error::NoStorageAccess(_) => KeyringFailure::Locked", module)
        self.assertIn("keyring::Error::BadEncoding(_) | keyring::Error::Ambiguous(_) => KeyringFailure::Corrupt",
                      module)
        self.assertIn("_ => KeyringFailure::Unavailable", module)
        lib = self.read("lib.rs")
        self.assertIn('#[cfg(target_os = "linux")]\nmod companion_keyring;', lib)
        # The store maps every keyring outcome and never touches the filesystem.
        gateway = self.read("companion_gateway.rs")
        store_body = gateway.split("impl ProtectedIdentityStore for LinuxIdentityStore {", 1)[1].split("\n}\n", 1)[0]
        for name in ("fn load(&self)", "fn store(&self", "fn remove(&self)"):
            self.assertIn(name, store_body)
        self.assertIn("self.backend.read()", store_body)
        self.assertIn(".write(encoded.as_bytes())", store_body)
        self.assertIn("self.backend.remove()", store_body)
        for forbidden in ("fs::write", "fs::rename", "OpenOptions", "remove_file", "create_dir"):
            self.assertNotIn(forbidden, store_body, forbidden)
        # Distinct codes: unavailable, locked, and the existing corrupt path.
        self.assertIn('"companion-keyring-unavailable"', gateway)
        self.assertIn('"companion-keyring-locked"', gateway)
        self.assertIn('"系统钥匙环已锁定，未做任何修改"', gateway)
        self.assertIn('"companion-secret-recovery-required"', gateway)
        # Windows and macOS branches are untouched.
        self.assertIn("CryptProtectData", gateway)
        self.assertIn("CryptUnprotectData", gateway)
        self.assertIn('"companion-secret-platform-unsupported"', gateway)
        # The fake-backend suite covers success/missing/unavailable/locked/corrupt.
        for name in ("linux_identity_store_round_trips_through_the_keyring_without_writing_files",
                     "linux_identity_store_reports_unavailable_and_locked_distinctly",
                     "linux_identity_store_treats_a_corrupt_entry_as_recovery_required"):
            self.assertIn(name, gateway)

    def test_companion_gateway_linux_slice_is_wired(self):
        # T17: the Linux secret store refuses without a keyring (never plaintext,
        # never a weak fallback), the LAN enumeration is a real getifaddrs read,
        # and the manager picks the store by platform while macOS keeps DPAPI.
        gateway = self.read("companion_gateway.rs")
        self.assertIn('fn linux_keyring_unavailable() -> GatewayError {', gateway)
        self.assertIn('"companion-keyring-unavailable"', gateway)
        self.assertIn('"未找到系统钥匙环，未做任何修改"', gateway)
        self.assertIn("struct LinuxIdentityStore {", gateway)
        self.assertIn("impl ProtectedIdentityStore for LinuxIdentityStore {", gateway)
        store_body = gateway.split("impl ProtectedIdentityStore for LinuxIdentityStore {", 1)[1].split("\n}\n", 1)[0]
        for name in ("fn load(&self)", "fn store(&self", "fn remove(&self)"):
            with self.subTest(fn=name):
                self.assertIn(name, store_body)
        # T19 replaced the stub with the real Secret Service backend: the store
        # delegates every operation and still touches no file.
        self.assertIn("self.backend.read()", store_body)
        self.assertIn(".write(encoded.as_bytes())", store_body)
        self.assertIn("self.backend.remove()", store_body)
        self.assertIn("linux_keyring_error", store_body)
        self.assertNotIn("open(", store_body)
        self.assertNotIn("fs::write", store_body)
        self.assertNotIn("fs::rename", store_body)
        self.assertNotIn("remove_file", store_body)
        self.assertIn("libc::getifaddrs", gateway)
        self.assertIn("libc::freeifaddrs", gateway)
        self.assertIn("fn list_lan_ipv4_interfaces() -> Result<Vec<LanIpv4Interface>, GatewayError> {",
                      gateway)

        self.assertIn('#[cfg(target_os = "linux")]\n        let store = LinuxIdentityStore::new(backend.app_data_dir());',
                      gateway)
        self.assertIn('#[cfg(not(target_os = "linux"))]\n        let store = DpapiIdentityStore::new(backend.app_data_dir());',
                      gateway)
        self.assertIn("fn linux_identity_store_reports_unavailable_and_locked_distinctly(", gateway)
        self.assertIn("fn linux_interface_enumeration_only_reports_private_lan(", gateway)
        # The DPAPI Windows bodies stay byte-identical; macOS keeps the original
        # platform refusal, Linux gets its own keyring refusal.
        self.assertIn("CryptProtectData", gateway)
        self.assertIn("CryptUnprotectData", gateway)
        self.assertIn('#[cfg(not(any(windows, target_os = "linux")))]\n'
                      'fn dpapi_protect(_plaintext: &[u8]) -> Result<Vec<u8>, GatewayError> {\n'
                      '    Err(GatewayError::new(\n'
                      '        "companion-secret-platform-unsupported",', gateway)
        self.assertIn('#[cfg(not(any(windows, target_os = "linux")))]\n'
                      'fn list_lan_ipv4_interfaces() -> Result<Vec<LanIpv4Interface>, GatewayError> {\n'
                      "    Ok(Vec::new())", gateway)
        self.assertEqual(gateway.count('fn list_lan_ipv4_interfaces() -> Result<Vec<LanIpv4Interface>, GatewayError> {'), 3)

    def test_native_media_linux_gate_is_wired_without_touching_windows(self):
        # T16 pure-code slice: the media-engine verification authority is
        # compiled on Linux with the same pinned-version + digest checks, the
        # two native video commands report a missing runtime with their own
        # code and "未做任何修改", and the runner/player stay Windows-gated.
        gate = '#[cfg(any(all(windows, feature = "browser-host-runtime"), target_os = "linux"))]'
        transfer = self.read("media_transfer.rs")
        self.assertEqual(transfer.count(gate), 9, "only the verification gates widen")
        for name in ("struct ExternalMediaResolver {", "impl ExternalMediaResolver {",
                     "pub(crate) fn verified_local_video_tools(resource_dir: &Path)",
                     "fn safe_runtime_path(root: &Path, relative: &str)",
                     "fn enumerate_runtime_files(root: &Path)"):
            self.assertIn(name, transfer)
        # The runner (probe/transfer) and the player stay Windows-only.
        self.assertIn('#[cfg(all(windows, feature = "browser-host-runtime"))]\n'
                      "impl MediaResolver for ExternalMediaResolver {", transfer)
        runtime = self.read("linux_media_runtime.rs")
        self.assertIn('pub(crate) const COMPONENT_MISSING: &str = "native-media-component-missing";',
                      runtime)
        self.assertIn('pub(crate) const COMPONENT_MISSING_MESSAGE: &str = "未找到媒体组件，未做任何修改";',
                      runtime)
        self.assertIn('json!({"code": COMPONENT_MISSING, "message": COMPONENT_MISSING_MESSAGE})',
                      runtime)
        lib = self.read("lib.rs")
        self.assertIn('#[cfg(target_os = "linux")]\nmod linux_media_runtime;', lib)
        offline = (Path(__file__).resolve().parents[1] /
                   "tests/linux-import-transaction/src/lib.rs").read_text()
        self.assertIn('#[path = "../../../src-tauri/src/linux_media_runtime.rs"]\n'
                      "mod linux_media_runtime;", offline)
        commands = self.read("material_native_video/mod.rs")
        self.assertIn("crate::media_transfer::verified_local_video_tools(&resources)", commands)
        self.assertIn("crate::linux_media_runtime::component_missing_error(&verified)", commands)
        self.assertIn("crate::linux_media_runtime::capability_payload(&verified)", commands)
        # macOS keeps its previous refusals byte-identically.
        self.assertIn('Err("native-video-preview-unavailable".into())', commands)
        self.assertIn('Err("native-video-platform-unavailable".into())', commands)

    def test_director_webgl_evidence_is_closed_and_never_leaks_the_renderer(self):
        # T22: the Director stage's GL probe is a closed projection. The full
        # GL_RENDERER / UNMASKED_RENDERER string identifies the driver stack, so
        # only a software/hardware class may leave the report.
        self.assertEqual(ci.bounded_director_webgl({}), {
            "directorCanvasPresent": None, "contextLost": None, "probeDrawn": None,
            "probeNonBlack": None, "contextKind": None, "rendererClass": None,
            "canvasWidth": None, "canvasHeight": None, "probeColors": None})
        passing = {"directorCanvasPresent": True, "contextLost": False, "probeDrawn": True,
                   "probeNonBlack": True, "contextKind": "webgl2", "rendererClass": "software",
                   "canvasWidth": 640, "canvasHeight": 360, "probeColors": 1}
        self.assertEqual(ci.bounded_director_webgl(passing), passing)
        self.assertEqual(ci.bounded_director_webgl(ci.bounded_director_webgl(passing)), passing)
        driver = "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)"
        leaked = dict(passing, renderer=driver, vendor=driver, rendererString=driver,
                      contextKind="webgl2 (llvmpipe)", probeColors=99, canvasWidth=10**9)
        projected = ci.bounded_director_webgl(leaked)
        self.assertEqual(projected["contextKind"], None)
        self.assertEqual(projected["canvasWidth"], None)
        self.assertEqual(projected["probeColors"], None)
        for token in ("llvmpipe", "ANGLE", "LLVM", "Mesa"):
            self.assertNotIn(token, json.dumps(projected))
        # A failing probe must fail the notes gate with its own code, never pass.
        for name, value in (("directorCanvasPresent", False), ("contextKind", "webgl1"),
                            ("contextKind", "none"), ("contextLost", True),
                            ("probeDrawn", False), ("probeNonBlack", False),
                            ("canvasWidth", 0), ("rendererClass", "unknown")):
            broken = dict(passing); broken[name] = value
            fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
            fixture.raw["directorWebgl"] = broken
            projected = ci.bounded_report(fixture.raw)
            with self.subTest(field=name, value=value), self.assertRaisesRegex(
                    RuntimeError, "director-webgl-evidence-missing"):
                ci.validate_notes(projected, fixture.build, fixture.source, fixture.scripts)

    def test_canvas_flow_evidence_is_closed_and_required(self):
        # T18: every step of the real-UI canvas save/reopen flow is a closed
        # boolean, the document node count and the temporary leftovers are
        # bounded counters, and a missing edit or a leftover temporary fails
        # with its own code instead of the generic one.
        self.assertEqual(ci.bounded_canvas_flow({}), {"homeRendered": None, "editorOpened": None,
            "nodeAdded": None, "savedOnDisk": None, "reopened": None,
            "nodePresentAfterReopen": None, "documentNodes": None, "temporaryLeftovers": None})
        passing = {"homeRendered": True, "editorOpened": True, "nodeAdded": True,
                   "savedOnDisk": True, "reopened": True, "nodePresentAfterReopen": True,
                   "documentNodes": 1, "temporaryLeftovers": 0}
        self.assertEqual(ci.bounded_canvas_flow(passing), passing)
        self.assertEqual(ci.bounded_canvas_flow(ci.bounded_canvas_flow(passing)), passing)
        for name in ("homeRendered", "editorOpened", "nodeAdded", "savedOnDisk",
                     "reopened", "nodePresentAfterReopen"):
            dirty = dict(passing); dirty[name] = False
            self.assertNotEqual(ci.bounded_canvas_flow(dirty), passing, name)
            dirty = dict(passing); dirty.pop(name)
            self.assertNotEqual(ci.bounded_canvas_flow(dirty), passing, name)
        # Any deviation from the full literal is refused by the CI gate.
        for name in ("savedOnDisk", "nodePresentAfterReopen", "temporaryLeftovers"):
            dirty = dict(passing); dirty[name] = 8 if name == "temporaryLeftovers" else 2
            failing = EvidenceTests(methodName="runTest"); failing.setUp()
            failing.raw["canvasFlow"] = dirty
            with self.subTest(counter=name), self.assertRaisesRegex(
                    RuntimeError, "canvas-save-reopen-evidence-missing"):
                ci.validate_notes(ci.bounded_report(failing.raw), failing.build, failing.source, failing.scripts)
        # The smoke raises its own codes for the two failures that matter, and
        # they survive the closed projection instead of collapsing.
        for code in ("canvas-save-not-on-disk", "canvas-reopen-lost-edit",
                     "canvas-storage-temporary-leftover"):
            self.assertIn(code, ci.FAILURES)
            exported = ci.bounded_report({"failure": {"phase": "canvas-flow", "action": "canvas-save-shortcut",
                                                      "code": code}})
            self.assertEqual(exported["failure"]["code"], code)
        garbage = {"canvasLeftovers": "hunter2", "path": "hunter2"}
        projected = ci.bounded_report({"canvasFlow": garbage})
        self.assertNotIn("hunter2", json.dumps(projected["canvasFlow"]))
        self.assertNotIn("path", projected["canvasFlow"])
        # The smoke registers the phase, the actions, the check and the codes.
        smoke_src = Path(ci.smoke.__file__).read_text()
        for action in ("canvas-open-home", "canvas-create", "canvas-editor-ready", "canvas-add-node",
                       "canvas-save-shortcut", "canvas-leave-editor", "canvas-reopen-editor"):
            self.assertIn('"{}"'.format(action), smoke_src)
        self.assertIn('"canvas-save-not-on-disk"', smoke_src)
        self.assertIn('"canvas-reopen-lost-edit"', smoke_src)
        self.assertIn('"canvasSaveReopen"', smoke_src)
        # No JS click and no bridge-driven save: the save is the editor's own
        # Ctrl+S and every click is a real WebDriver click.
        self.assertNotIn('invoke("canvas_agent', smoke_src)
        self.assertIn('editor_key_actions("save")', smoke_src)

    def test_canvas_temporary_name_is_tied_to_the_rust_writer(self):
        # The canvas writer (canvas_agent.rs::atomic_write) stages
        # `.{file_name}.agent-{pid}-{nanos}.tmp`. The scan predicate must match
        # exactly that shape - built from the format string in the Rust source -
        # and must never claim the notes/attachment (`.lrk-`) or workspace
        # (`.lrw-`) families.
        rust = self.read("canvas_agent.rs")
        formats = re.findall(r'"\.\{file_name\}\.agent-\{\}-\{\}\.tmp"', rust)
        self.assertEqual(len(formats), 1, "the canvas temporary format moved")
        sample = formats[0].strip('"').replace("{file_name}", "canvas-1.json", 1) \
            .replace("{}", "4242", 1).replace("{}", "1730000000000000000", 1)
        self.assertEqual(sample, ".canvas-1.json.agent-4242-1730000000000000000.tmp")
        self.assertTrue(ci.smoke.is_canvas_temporary(sample))
        self.assertFalse(ci.smoke.is_attachment_temporary(sample))
        self.assertFalse(ci.smoke.is_workspace_temporary(sample))
        for foreign in (".lrk-attachment-0123abcdef.tmp", ".lrk-import-0123abcdef-3.tmp",
                        ".lrw-4242-1730000000000000000.tmp", "canvas-1.json",
                        ".canvas-1.json.agent-4242.tmp", ".canvas-1.json.agent-x-y.tmp"):
            self.assertFalse(ci.smoke.is_canvas_temporary(foreign), foreign)
        self.assertTrue(ci.smoke.is_attachment_temporary(".lrk-attachment-0123abcdef.tmp"))
        self.assertTrue(ci.smoke.is_workspace_temporary(".lrw-4242-1730000000000000000.tmp"))
        # The offline canvas test uses the same family, not the .lrk- prefix.
        offline_canvas = self.read("canvas_agent.rs").split(
            "mod linux_replace_tests", 1)[1]
        self.assertIn('.contains(".agent-") && name.ends_with(".tmp")', offline_canvas)
        self.assertNotIn('name.startswith(".lrk-")', offline_canvas)

    def test_profile_temporary_scan_reports_each_writer_family(self):
        # Synthetic profile only: a canvas leftover must be reported by the scan,
        # and so must the attachment and workspace families, each on its own
        # counter.
        with tempfile.TemporaryDirectory(prefix="canvas-scan-unit-") as temporary:
            home = Path(temporary)
            nested = home / "data" / "luckyray" / "canvases"
            nested.mkdir(parents=True)
            (nested / "canvas-1.json").write_bytes(b"{}")
            (nested / ".canvas-1.json.agent-99-88.tmp").write_bytes(b"{}")
            (nested / ".lrk-attachment-0123abcdef.tmp").write_bytes(b"{}")
            (nested / ".lrw-99-88.tmp").write_bytes(b"{}")
            (nested / ".lrk-move-99-88.tmp").write_bytes(b"{}")
            (nested / ".luckyray-write.lock").write_bytes(b"{}")
            canvas, attachment, workspace, moved, scanned = ci.smoke.profile_temporary_scan(home)
            self.assertEqual((canvas, attachment, workspace, moved), (1, 1, 1, 1))
            self.assertGreaterEqual(scanned, 6)
            clean = home / "clean"
            clean.mkdir()
            (clean / "canvas-1.json").write_bytes(b"{}")
            self.assertEqual(ci.smoke.profile_temporary_scan(clean), (0, 0, 0, 0, 1))

    def test_canvas_storage_hygiene_evidence_is_closed_and_required(self):
        # The smoke scans the owned profile after both sessions end; the
        # projection is closed and a leftover temporary can never pass.
        self.assertEqual(ci.bounded_canvas_storage({}), {"canvasLeftovers": None,
                                                         "attachmentLeftovers": None,
                                                         "workspaceLeftovers": None,
                                                         "moveLeftovers": None,
                                                         "directoriesScanned": None})
        clean = {"canvasLeftovers": 0, "attachmentLeftovers": 0, "workspaceLeftovers": 0,
                 "moveLeftovers": 0, "directoriesScanned": 5}
        self.assertEqual(ci.bounded_canvas_storage(clean), clean)
        for name in ("canvasLeftovers", "attachmentLeftovers", "workspaceLeftovers", "moveLeftovers"):
            dirty = dict(clean); dirty[name] = 1
            self.assertNotEqual(ci.bounded_canvas_storage(dirty), clean, name)
        self.assertEqual(ci.bounded_canvas_storage({"canvasLeftovers": "hunter2"})["canvasLeftovers"], None)
        self.assertEqual(ci.bounded_canvas_storage([{"canvasLeftovers": 1}]), {"canvasLeftovers": None,
                                                                              "attachmentLeftovers": None,
                                                                              "workspaceLeftovers": None,
                                                                              "moveLeftovers": None,
                                                                              "directoriesScanned": None})
        fixture = EvidenceTests(methodName="runTest"); fixture.setUp()
        fixture.raw.update(canvasStorage={"canvasLeftovers": 2, "attachmentLeftovers": 1,
                                          "workspaceLeftovers": "hunter2", "moveLeftovers": 0,
                                          "directoriesScanned": 9, "path": "hunter2"})
        self.assertNotIn("hunter2", json.dumps(ci.bounded_report(fixture.raw)))
        # The full passing fixture is accepted, and a single leftover temporary
        # fails with the dedicated code.
        passing = EvidenceTests(methodName="runTest"); passing.setUp()
        ci.validate_notes(ci.bounded_report(passing.raw), passing.build, passing.source, passing.scripts)
        for name in ("canvasLeftovers", "attachmentLeftovers", "workspaceLeftovers"):
            failing = EvidenceTests(methodName="runTest"); failing.setUp()
            failing.raw["canvasStorage"][name] = 1
            with self.subTest(counter=name), self.assertRaisesRegex(
                    RuntimeError, "canvas-storage-temporary-leftover"):
                ci.validate_notes(ci.bounded_report(failing.raw), failing.build, failing.source, failing.scripts)
        smoke = (Path(__file__).resolve().parents[1] /
                 "tests/linux-notes-attachments-smoke.py").read_text()
        self.assertIn("def profile_temporary_scan(home):", smoke)
        self.assertIn("CANVAS_TEMPORARY = re.compile", smoke)
        self.assertIn('"canvasStorageHygiene"', smoke)
        self.assertIn('"canvas-temporary-scan"', smoke)
        self.assertIn('require(leftovers[0] == 0 and leftovers[1] == 0 and leftovers[2] == 0', smoke)
        self.assertIn("def is_move_temporary(name):", smoke)
        self.assertIn('name.startswith(".lrk-move-")', smoke)
        self.assertIn('"attachmentLeftovers": min(leftovers[1], 8)', smoke)
        gate = (Path(__file__).resolve().parents[1] / "tests/linux-notes-ci.py").read_text()
        self.assertIn('"canvas-storage", "canvas-flow", "director-webgl", "quit"', gate)
        self.assertIn('"canvas-storage-temporary-leftover"', gate)
        self.assertIn('"moveLeftovers", "directoriesScanned")', gate)
        self.assertIn('"moveLeftovers"))', gate)

    def test_note_move_uses_the_sealed_runner_not_the_windows_journal(self):
        operations = self.read("knowledge/attachment_operations.rs")
        move = operations.split("fn move_note_with_attachments_unlocked", 1)[1].split(
            "fn moved_note_bytes_unlocked", 1)[0]
        # The rewritten bytes are computed before any step runs.
        self.assertIn("let after = self.moved_note_bytes_unlocked(vault, input, destination, original)?;",
                      move)
        self.assertIn("return self.execute_linux_note_move_unlocked(vault, &operation);", move)
        self.assertIn("pub(super) fn execute_linux_note_move_unlocked(",
                      self.read("knowledge/linux_attachment_mutations.rs"))
        # The Windows recovery journal still refuses to exist on Linux.
        self.assertIn("return Err(linux_knowledge_write_unavailable());",
                      operations.split("fn recovery_directory", 1)[1])

    def test_external_witness_and_dependency_holds_are_wired(self):
        mutations = self.read("knowledge/linux_attachment_mutations.rs")
        self.assertIn("self.hold_external_plan(vault, operation, source_epoch)?", mutations)
        self.assertIn("hold_external_dependencies(operation)?", mutations)
        self.assertIn("hold_verified_attachment(&vault.root, relative, digest)", mutations)
        # A rollback must not demand a witness that may already have expired.
        self.assertIn(
            "let _external_files = if super::attachment_witness::witness_required(rollback) {",
            mutations)
        observations = self.read("knowledge/attachment_observations.rs")
        witness = self.read("knowledge/attachment_witness.rs")
        # The epoch/identity/TTL rule lives in one pure module and is used here.
        self.assertIn("witness_scope_is_current(", observations)
        self.assertIn("witness_is_fresh(", observations)
        self.assertIn("witness_scope_is_current(", witness)
        self.assertIn("captured.is_some_and(|age| age < ttl)", witness)
        self.assertIn("pub(crate) fn witness_required(rollback: bool) -> bool", witness)

    def test_recovery_summary_is_read_only_and_registered(self):
        mutations = self.read("knowledge/linux_attachment_mutations.rs")
        summary = mutations.split("fn count_tombstones", 1)[1]
        for token in ("create(", "rename_new(", "remove_file", "sync_all(", "write("):
            with self.subTest(token=token):
                self.assertNotIn(token, summary)
        self.assertIn('strip_suffix(".removed")', mutations.split("fn is_tombstone_name", 1)[1])
        lib = self.read("lib.rs")
        # The command only exists where a rename-aside tombstone can exist.
        self.assertIn('#[cfg(target_os = "linux")]\n            knowledge_attachment_recovery_summary,', lib)
        self.assertIn('#[cfg(target_os = "linux")]\n#[tauri::command]\n'
                      'fn knowledge_attachment_recovery_summary', lib)
        self.assertNotIn("AttachmentRecoverySummary", self.read("knowledge/attachment_operations.rs"))
        self.assertIn("pub(crate) struct AttachmentRecoverySummary", mutations)
        self.assertIn("#[cfg(target_os = \"linux\")]\n"
                      "pub(crate) use linux_attachment_mutations::AttachmentRecoverySummary;",
                      self.read("knowledge/mod.rs"))

    def test_linux_attachment_copy_is_chinese_and_states_no_change(self):
        root = Path(__file__).resolve().parents[1]
        errors = (root / "src/core/services/vaultAttachmentErrors.ts").read_text()
        self.assertIn('"knowledge-exclusive-write-unsupported": "该操作在 Linux 上暂不可用，未做任何修改。"',
                      errors)
        self.assertIn('"knowledge-linux-rollback-unprovable"', errors)
        self.assertIn('"knowledge-linux-fs-unsupported"', errors)
        # The cross-device refusal needs no shared-frontend entry: its Chinese
        # message is shown as-is by the existing pass-through.
        self.assertNotIn("attachment-move-cross-device", errors)
        self.assertIn("/[\\u4e00-\\u9fff]/.test(error.message)", errors)
        catalog = self.read("materials/catalog.rs")
        self.assertIn("目标位置与原文件不在同一文件系统，未移动文件，未做任何修改。", catalog)
        # The unprovable-rollback message must promise that nothing was written.
        rollback = errors.split('"knowledge-linux-rollback-unprovable":', 1)[1].split("\n", 1)[0]
        self.assertIn("现场已保留", rollback)
        panel = (root / "src/features/notes/VaultAttachmentsPanel.tsx").read_text()
        self.assertIn("恢复区保留 {tombstones} 个已移除的原件", panel)
        self.assertIn("getAttachmentRecoverySummary(vaultId)", panel)

    def test_attachment_issue_labels_are_closed_to_the_linux_port(self):
        # The label rule is executable: an offline node test pins that every
        # pre-existing status keeps its exact label, and that only the codes this
        # port introduced may be read out of a "code: reason" step status.
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--test",
             str(root / "tests/attachmentIssueLabels.test.mjs")],
            text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        labels = (root / "src/core/services/attachmentIssueLabels.ts").read_text()
        # The pure module must stay importable without the Tauri bridge.
        self.assertNotRegex(labels, r"(?m)^import ")
        self.assertNotIn("@tauri-apps", labels)
        workflow = (root / "src/core/services/vaultAttachmentWorkflow.ts").read_text()
        self.assertIn("resolveAttachmentIssueLabel(status, attachmentAccessMessage(status))", workflow)

    def test_attachment_protections_and_status_sets_stay_closed(self):
        store = self.read("linux_attachment_store.rs")
        for arm in ("Verb::Create =>", "Verb::Replace =>", "Verb::Remove =>"):
            self.assertIn(arm, store)
        # A record written before the verbs existed must still verify.
        self.assertIn('b"luckyray-linux-import-step-v1\\0"', store)
        self.assertIn('b"luckyray-linux-import-step-v2\\0"', store)
        self.assertIn("skip_serializing_if", store)
        projection = self.read("knowledge/linux_attachment_import.rs")
        for status in ('"complete"', '"complete-with-unresolved"', '"partial"', '"rolled-back"'):
            self.assertIn(status, projection)
        # Sealing, the sealed digest and the target identity remain mandatory.
        self.assertIn("self.seal_attachment_receipt(operation)?", projection)
        self.assertIn("self.verify_attachment_receipt(&sealed)?", projection)
        self.assertIn("self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))?",
                      projection)
        mutations = self.read("knowledge/linux_attachment_mutations.rs")
        self.assertIn("self.assert_expected_target_unlocked(vault, Some(identity), Some(guard))",
                      mutations)
        self.assertEqual(
            sorted(set(re.findall(r'"(knowledge-linux-[a-z-]+)"', mutations))),
            ["knowledge-linux-fs-unsupported", "knowledge-linux-rollback-unprovable"])
        # The removal step is still gated on a fresh whole-Vault reference scan.
        self.assertIn("hold_unreferenced_attachment(&vault.root, &file.relative_path)?",
                      mutations)
        # Tombstones and stages stay in the reserved family the inventory skips.
        self.assertIn('name.starts_with(".lrk-")', self.read("knowledge/index.rs"))


if __name__ == "__main__":
    unittest.main()
