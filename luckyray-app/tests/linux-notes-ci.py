"""Source-bound single Main notes/PNG CI; reuse real build/resource collectors."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import zlib
from pathlib import Path

sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


runtime = module("notes_runtime_ci", "linux-runtime-ci.py")
smoke = module("notes_smoke", "linux-notes-attachments-smoke.py")
media_layout = module("notes_media_layout", "linux-media-layout-evidence.py")
driver_source = module("notes_driver_source", "linux-tauri-driver-source.py")
require, digest, read_json, write_json = runtime.require, runtime.digest, runtime.read_json, runtime.write_json
SCOPE = smoke.SCOPE
EXCLUDED = {name: "NOT_RUN" for name in ("chromiumConsent", "nativeMessaging", "nativePointerDrag",
    "externalApplicationDisplay", "trimmedFilenameEndToEnd", "videoCodecMatrix", "personalBrowserHost",
    "installer", "release", "waylandHardware", "oldMatrices", "lshFunctionalFlow")}
STEPS = ("CHECKOUT", "INIT", "NODE", "OFFLINE", "FRONTEND", "LAYOUT", "DEPENDENCIES", "RUST", "BUILD",
         "NATIVE_MESSAGING", "DRIVER", "RUNTIME", "RESOURCES", "NOTES", "SECRET_SERVICE", "COMPANION_KEYRING",
         "COMPANION_PAIRING", "MEDIA_PREVIEW", "MEDIA_RESOLVER",
         "MEDIA_PLAYER", "MEDIA_LGPL_BUNDLE", "PORT_FIXTURES", "AGENT_BROWSER_SHELL", "AGENT_BROWSER_ENGINE")
EXPORTS = ("source.json", "build.json", "resources.json", "notes.json", "nativeMessaging.json", "result.json")
runtime.SCOPE, runtime.EXCLUDED = SCOPE, EXCLUDED
PHASES = frozenset(("synthetic-setup", "desktop-association", "driver-start", "main-start", "drop-import", "edit-save", "copy-absolute-path",
                    "image-preview", "attachment-open", "reopen", "attachment-rename", "attachment-rollback",
                    "material-maintenance", "canvas-storage", "canvas-flow", "director-webgl", "quit", "unknown"))
FAILURES = frozenset(("owned-desktop-association-unavailable", "driver-not-ready", "backend-not-ready", "production-ipc-rejected", "visible-control-missing",
    "ui-observation-timeout", "drop-target-unavailable", "both-input-notes-not-retained", "case-distinct-content-mismatch",
    "special-name-png-not-retained", "imported-image-resolution-mismatch", "attachment-copy-policy-not-confirmed", "ui-edit-not-saved", "copy-path-menu-missing", "absolute-path-clipboard-mismatch",
    "preview-not-visible", "preview-pixels-mismatch", "screenshot-invalid", "screenshot-size-invalid",
    "image-outside-screenshot", "attachment-open-not-interactable", "attachment-open-ui-not-observed", "attachment-detail-target-mismatch", "attachment-note-only-opened-detail", "attachment-open-control-mismatch",
    "attachment-receiver-not-observed", "attachment-handoff-mismatch",
    "reopen-file-content-mismatch", "quit-process-remained", "quit-already-attempted", "driver-cleanup-incomplete",
    "webdriver-command-failed", "editor-not-ready", "editor-input-mismatch", "maintenance-precondition-mismatch",
    "maintenance-control-rejected", "recovery-records-invalid", "recovery-summary-invalid", "attachment-rename-not-confirmed",
    "attachment-rollback-not-confirmed", "material-catalog-read-invalid", "material-import-not-observed", "material-source-mode-not-applied",
    "material-rename-not-observed", "material-rename-not-confirmed", "material-delete-not-observed", "material-delete-not-confirmed", "material-viewer-opened-by-context-gesture", "context-release-point-unavailable",
    "canvas-storage-temporary-leftover", "canvas-save-not-on-disk", "canvas-reopen-lost-edit",
    "director-canvas-missing", "director-webgl2-unavailable", "director-context-lost", "director-canvas-empty",
    "director-probe-not-rendered", "director-webgl-evidence-missing",
    "control-not-interactable", "control-outside-viewport", "unexpected-error"))


def bounded_interactability(raw):
    """Redacted not-interactable diagnostic: five booleans, one fixed hit kind and integer-only geometry."""
    raw = raw if isinstance(raw, dict) else {}
    result = {name: raw.get(name) if type(raw.get(name)) is bool else None
              for name in ("found", "displayed", "enabled", "inViewport", "styleVisible")}
    result["hit"] = raw.get("hit") if raw.get("hit") in smoke.HIT_KINDS else "NONE"
    result["hitLabel"] = raw.get("hitLabel") if raw.get("hitLabel") in smoke.HIT_LABELS else "NONE"
    result["hitDialog"] = raw.get("hitDialog") if raw.get("hitDialog") in ("NONE", "OTHER", *smoke.DIALOG_LABELS.values()) else "NONE"
    result["geometry"] = smoke.bounded_geometry(raw.get("geometry"))
    return result


def bounded_native_messaging(raw):
    """Closed projection of the real native-host registration + round-trip run.

    Every step is a boolean; only the two script/binary digests and the framed
    message count leave this function, so the evidence carries no path, no
    manifest body and no browser profile name.
    """
    raw = raw if isinstance(raw, dict) else {}

    def passed(value):
        # The smoke reports the CLI outcomes as the literal "PASS" its other
        # reports use; anything else has to be a real boolean.
        if value is True or value == "PASS":
            return True
        if value is False:
            return False
        return None

    result = {name: passed(raw.get(name))
              for name in ("registration", "revocation", "reenable", "sourceIdentity",
                           "conflictAndSymlinkPreservation", "independentBackupAndOldInode",
                           "credentialNamespaceUnchanged", "roundTrip")}
    for name in ("applicationSha256", "scriptSha256"):
        value = raw.get(name)
        result[name] = value if type(value) is str and len(value) == 64 else None
    frames = raw.get("roundTripFrames")
    result["roundTripFrames"] = frames if type(frames) is int and 1 <= frames <= 8 else None
    result["realBrowser"] = raw.get("realBrowser") if raw.get("realBrowser") == "NOT_RUN" else None
    result["roundTripRefusalCode"] = (raw.get("roundTripRefusalCode")
                                      if type(raw.get("roundTripRefusalCode")) is str
                                      and 0 < len(raw["roundTripRefusalCode"]) <= 48 else None)
    return result


def validate_native_messaging(observed, scripts):
    """The registration and round-trip evidence must all be PASS, and the run
    must be source-bound to the smoke script that produced it."""
    require(observed.get("realBrowser") == "NOT_RUN", "native-messaging-real-browser-claimed")
    for name in ("registration", "revocation", "reenable", "sourceIdentity",
                 "conflictAndSymlinkPreservation", "independentBackupAndOldInode",
                 "credentialNamespaceUnchanged", "roundTrip"):
        require(observed.get(name) is True, "native-messaging-" + name.lower() + "-failed")
    require(observed.get("roundTripFrames") == 1, "native-messaging-round-trip-not-single")
    require(observed.get("scriptSha256") == scripts["nativeMessaging"],
            "native-messaging-script-identity-changed")
    require(observed.get("roundTripRefusalCode"), "native-messaging-round-trip-no-response")


def bounded_director_webgl(raw):
    """Closed projection of the Director stage's WebGL probe.

    Only a context kind, a renderer *class* (software/hardware), a boolean
    state and bounded pixel counts leave the report: the full GL_RENDERER or
    UNMASKED_RENDERER string is never exported, because it identifies the
    machine's driver stack.
    """
    raw = raw if isinstance(raw, dict) else {}
    result = {name: raw.get(name) if type(raw.get(name)) is bool else None
              for name in ("directorCanvasPresent", "contextLost", "probeDrawn", "probeNonBlack")}
    kind = raw.get("contextKind")
    result["contextKind"] = kind if kind in ("webgl2", "webgl1", "none") else None
    renderer = raw.get("rendererClass")
    result["rendererClass"] = renderer if renderer in ("software", "hardware", "unknown") else None
    for name in ("canvasWidth", "canvasHeight"):
        value = raw.get(name)
        result[name] = value if type(value) is int and 0 <= value <= 4096 else None
    colors = raw.get("probeColors")
    result["probeColors"] = colors if type(colors) is int and 0 <= colors <= 8 else None
    return result


def bounded_canvas_flow(raw):
    """Closed projection of the real-UI canvas save/reopen flow.

    Six booleans (create -> edit -> save -> leave -> reopen -> node present)
    plus two bounded counters: the document node count and the canvas/attachment/
    workspace temporary leftovers found while the editor was still open.
    """
    raw = raw if isinstance(raw, dict) else {}
    result = {name: raw.get(name) if type(raw.get(name)) is bool else None
              for name in ("homeRendered", "editorOpened", "nodeAdded", "savedOnDisk",
                           "reopened", "nodePresentAfterReopen")}
    for name in ("documentNodes", "temporaryLeftovers"):
        value = raw.get(name)
        result[name] = value if type(value) is int and 0 <= value <= 8 else None
    return result


def bounded_canvas_storage(raw):
    """Closed projection of the post-run temporary scan: five 0..8 counters.

    `canvasLeftovers` counts the canvas writer's own
    `.{file_name}.agent-{pid}-{nanos}.tmp` names, `attachmentLeftovers` the
    notes/attachment `.lrk-…tmp` family, `workspaceLeftovers` the `.lrw-…tmp`
    family and `moveLeftovers` the cross-volume material move's
    `.lrk-move-…tmp` family, so every leftover is attributed to its own writer.
    """
    raw = raw if isinstance(raw, dict) else {}
    return {name: raw.get(name) if type(raw.get(name)) is int and 0 <= raw[name] <= 8 else None
            for name in ("canvasLeftovers", "attachmentLeftovers", "workspaceLeftovers",
                         "moveLeftovers", "directoriesScanned")}


def bounded_maintenance(raw):
    """Closed projection of the UI maintenance evidence: fixed enums, booleans and counts 0..8."""
    raw = raw if isinstance(raw, dict) else {}
    result = {}
    for name, (fixed, flags, counts) in smoke.MAINTENANCE_FIELDS.items():
        value = raw.get(name) if isinstance(raw.get(name), dict) else {}
        item = {key: expected if value.get(key) == expected else "INVALID" for key, expected in fixed.items()}
        item.update({flag: value.get(flag) if type(value.get(flag)) is bool else None for flag in flags})
        item.update({count: value.get(count) if type(value.get(count)) is int and 0 <= value[count] <= 8 else None for count in counts})
        if name == "noteRename":
            item["materialAssetIdShape"] = smoke.bounded_asset_id_shape(value.get("materialAssetIdShape"))
        result[name] = item
    not_run = raw.get("notRun") if isinstance(raw.get("notRun"), dict) else {}
    result["notRun"] = {name: expected if not_run.get(name) == expected else "INVALID" for name, expected in smoke.MAINTENANCE_NOT_RUN.items()}
    return result


def bounded_driver(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = {"kind": raw.get("kind") if raw.get("kind") in ("HTTP_ERROR", "TRANSPORT_ERROR", "INVALID_RESPONSE") else "UNKNOWN",
        "operation": raw.get("operation") if isinstance(raw.get("operation"), str) and raw["operation"] in smoke.DRIVER_OPERATIONS else "other",
        "error": raw.get("error") if isinstance(raw.get("error"), str) and raw["error"] in smoke.DRIVER_ERRORS else "unknown-standard-error",
        "httpStatus": raw.get("httpStatus") if type(raw.get("httpStatus")) is int and 400 <= raw["httpStatus"] <= 599 else None,
        "transport": raw.get("transport") if isinstance(raw.get("transport"), str) and raw["transport"] in smoke.TRANSPORT_CODES else "UNKNOWN",
        "responseState": raw.get("responseState") if raw.get("responseState") in ("UNCONFIRMED", "HTTP_ERROR_RECEIVED") else "UNKNOWN",
        "elapsedMs": media_layout.integer(raw.get("elapsedMs"), 0, 60000)}
    if "forwarding" in raw:
        result["forwarding"] = bounded_forwarding(raw["forwarding"])
    if "processesAtResponse" in raw:
        result["processesAtResponse"] = bounded_processes(raw["processesAtResponse"])
    return result


def bounded_forwarding(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = {"state": raw.get("state") if raw.get("state") in ("OBSERVED", "NOT_OBSERVED", "UNAVAILABLE") else "UNAVAILABLE",
              "readBytes": media_layout.integer(raw.get("readBytes"), 0, 65536), "truncated": raw.get("truncated") is True,
              "typed": [], "legacy": []}
    rows = raw.get("typed") if isinstance(raw.get("typed"), list) else []
    for row in rows[:2]:
        if isinstance(row, dict):
            result["typed"].append({"connect": row.get("connect") if type(row.get("connect")) is bool else None,
                "hyper": row.get("hyper") if row.get("hyper") in smoke.FORWARD_HYPER else "OTHER",
                "io": row.get("io") if row.get("io") in smoke.FORWARD_IO else "OTHER",
                "depth": media_layout.integer(row.get("depth"), 1, 8), "truncated": row.get("truncated") is True})
    legacy = raw.get("legacy") if isinstance(raw.get("legacy"), list) else []
    result["legacy"] = [value for value in legacy[:2] if value in ("CONNECT", "SEND_REQUEST", "CANCELED", "CHANNEL_CLOSED")]
    result["truncated"] |= len(rows) > 2 or len(legacy) > 2
    return result


def validate_driver_source(raw, scripts):
    expected = {"kind": driver_source.KIND, "version": driver_source.VERSION,
        "archiveSha256": driver_source.ARCHIVE_SHA, "lockSha256": driver_source.LOCK_SHA,
        "prepScriptSha256": scripts["driverPrep"], "diagnosticSha256": scripts["driverDiagnostic"]}
    require(isinstance(raw, dict) and set(raw) == {*expected, "patchedMainSha256", "patchedServerSha256", "sourceClosureSha256"}
            and all(raw.get(key) == value for key, value in expected.items())
            and all(media_layout.digest(raw.get(key)) is not None for key in ("patchedMainSha256", "patchedServerSha256", "sourceClosureSha256")),
            "driver-source-diagnostic-identity-mismatch")
    return raw


def bounded_exit(raw):
    raw = raw if isinstance(raw, dict) else {}
    return {"state": raw.get("state") if raw.get("state") in ("RUNNING", "EXITED", "SIGNALED", "IDENTITY_CHANGED", "UNOBSERVED") else "UNOBSERVED",
            "exitCode": media_layout.integer(raw.get("exitCode"), 0, 255), "signal": media_layout.integer(raw.get("signal"), 1, 64)}


def bounded_processes(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = {"driver": bounded_exit(raw.get("driver"))}
    for name in ("app", "nativeDriver"):
        value = raw.get(name) if isinstance(raw.get(name), dict) else {}
        result[name] = {key: media_layout.integer(value.get(key), 0, 2) for key in ("tracked", "running", "gone", "identityChanged", "unobserved")}
        result[name].update(overflow=value.get("overflow") is True,
                           exitStatus="NOT_OBSERVED" if value.get("exitStatus") == "NOT_OBSERVED" else "INVALID")
    return result


def bounded_clipboard_probe(raw):
    raw = raw if isinstance(raw, dict) else {}
    return {"attempts": media_layout.integer(raw.get("attempts"), 0, 1),
        "method": "XCLIP_READONLY_ONCE" if raw.get("method") == "XCLIP_READONLY_ONCE" else "INVALID",
        "state": raw.get("state") if raw.get("state") in ("READ", "TIMEOUT", "SIZE_LIMIT", "EXIT_ERROR", "IO_ERROR", "UNAVAILABLE", "CLEANUP_UNCONFIRMED") else "UNAVAILABLE",
        "exactAbsolutePath": raw.get("exactAbsolutePath") if type(raw.get("exactAbsolutePath")) is bool else None,
        "readBytes": media_layout.integer(raw.get("readBytes"), 0, 8193), "overflow": raw.get("overflow") is True,
        "exit": bounded_exit(raw.get("exit"))}


def bounded_unconfirmed_copy(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = {"action": "context-copy" if raw.get("action") == "context-copy" else "unknown",
        "writeAttempts": media_layout.integer(raw.get("writeAttempts"), 0, 1),
        "responseState": "UNCONFIRMED" if raw.get("responseState") == "UNCONFIRMED" else "UNKNOWN",
        "state": raw.get("state") if raw.get("state") in ("OBSERVED", "UNAVAILABLE") else "UNAVAILABLE",
        **{key: bounded_processes(raw.get(key)) for key in ("beforeRequest", "atUnconfirmedResponse")}}
    if "clipboard" in raw:
        result["clipboard"] = bounded_clipboard_probe(raw["clipboard"])
    if "afterClipboardRead" in raw:
        result["afterClipboardRead"] = bounded_processes(raw["afterClipboardRead"])
    return result


def bounded_cleanup(raw):
    raw = raw if isinstance(raw, dict) else {}
    quit_command = raw.get("quitCommand") if isinstance(raw.get("quitCommand"), dict) else {}
    termination = raw.get("driverTermination") if isinstance(raw.get("driverTermination"), dict) else {}
    result = {"quitAttemptedInFinally": raw.get("quitAttemptedInFinally") is True,
        "quitSkippedAlreadyAttempted": raw.get("quitSkippedAlreadyAttempted") is True,
        "quitCommand": {name: quit_command.get(name) if type(quit_command.get(name)) is bool else None for name in ("attempted", "ipcReplyObserved")},
        **{name: bounded_processes(raw.get(name)) for name in ("beforeDriverTermination", "afterDriverTermination")},
        "driverTermination": {"termRequested": termination.get("termRequested") is True, "killRequested": termination.get("killRequested") is True,
            "error": termination.get("error") if termination.get("error") in ("NONE", "PROCESS_GROUP_GONE", "TIMEOUT", "IO_ERROR") else "IO_ERROR",
            "exit": bounded_exit(termination.get("exit"))}}
    if "quitFailure" in raw:
        result["quitFailure"] = bounded_driver(raw["quitFailure"])
    return result


def bounded_drop_trace(raw):
    raw = raw if isinstance(raw, dict) else {}
    count = raw.get("readBytes")
    result = {"state": "UNAVAILABLE" if raw.get("state") == "UNAVAILABLE" else "NOT_OBSERVED",
              "readBytes": count if type(count) is int and 0 <= count <= 65536 else 0,
              "truncated": raw.get("truncated") is True, "records": []}
    for item in raw["records"][:32] if isinstance(raw.get("records"), list) else []:
        if (not isinstance(item, dict) or not isinstance(item.get("stage"), str)
                or item["stage"] not in smoke.DROP_STAGES or type(item.get("count")) is not int
                or not 0 <= item["count"] <= 100000 or type(item.get("hit")) is not bool):
            continue
        result["records"].append({"stage": item["stage"], "count": min(item["count"], 2),
                                  "overflow": item.get("overflow") is True or item["count"] > 2, "hit": item["hit"]})
    if result["records"]:
        result["state"] = "OBSERVED"
    if isinstance(raw.get("records"), list) and len(raw["records"]) > 32:
        result["truncated"] = True
    return result


def bounded_preview_geometry(raw):
    """At most one geometry probe per app session, closed fields only."""
    rows = raw if isinstance(raw, list) and len(raw) <= 2 else []
    result = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        session = item.get("session")
        result.append({"session": session if type(session) is int and 1 <= session <= 2 else None,
                       "found": item.get("found") is True, "replaced": item.get("replaced") is True,
                       "hit": item.get("hit") if item.get("hit") in smoke.PREVIEW_HITS else None,
                       "centerInViewport": item.get("centerInViewport") is True})
    return result


def bounded_preview_toggle(raw):
    """Closed projection of the preview-toggle attempts.

    At most two attempts, each either the transport failure that caused a retry
    or the retry that delivered. Nothing else is exported.
    """
    rows = raw if isinstance(raw, list) and len(raw) <= 2 else []
    result = []
    for index, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        attempt, transport, elapsed, state = item.get("attempt"), item.get("transport"), item.get("elapsedMs"), item.get("stateAfterFailure")
        result.append({
            "attempt": attempt if type(attempt) is int and attempt == index + 1 else index + 1,
            "transport": transport if transport in smoke.TRANSPORT_CODES else None,
            "elapsedMs": elapsed if type(elapsed) is int and 0 <= elapsed <= 60000 else None,
            "stateAfterFailure": state if state in ("PREVIEW", "SOURCE") else None})
    return result


def bounded_attachment_open_trace(raw):
    """Closed projection of the sanitized attachment-open evidence."""
    raw = raw if isinstance(raw, dict) else {}
    count = raw.get("readBytes")
    result = {"state": "UNAVAILABLE" if raw.get("state") == "UNAVAILABLE" else "NOT_OBSERVED",
              "readBytes": count if type(count) is int and 0 <= count <= 65536 else 0,
              "truncated": raw.get("truncated") is True, "records": []}
    rows = raw.get("records") if isinstance(raw.get("records"), list) else []
    for item in rows[:8]:
        if (not isinstance(item, dict) or item.get("route") not in smoke.ATTACHMENT_ROUTES
                or item.get("status") not in smoke.ATTACHMENT_STATUSES or item.get("opener") not in smoke.ATTACHMENT_OPENERS):
            continue
        exit_code, digest, elapsed = item.get("exitCode"), item.get("sha256"), item.get("elapsedMs")
        result["records"].append({"route": item["route"], "status": item["status"], "opener": item["opener"],
            "exitCode": exit_code if type(exit_code) is int and 0 <= exit_code <= 255 else None,
            "sha256": digest if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) else None,
            "elapsedMs": elapsed if type(elapsed) is int and 0 <= elapsed <= 60000 else 0})
    if result["records"]:
        result["state"] = "OBSERVED"
    if len(rows) > 8:
        result["truncated"] = True
    return result


def bounded_report(raw):
    """Closed projection. No child text, path, clipboard value, log or environment."""
    raw = raw if isinstance(raw, dict) else {}
    result = {"schemaVersion": 1 if type(raw.get("schemaVersion")) is int and raw["schemaVersion"] == 1 else None,
              "scope": SCOPE if raw.get("scope") == SCOPE else "INVALID",
              "status": raw.get("status") if raw.get("status") in ("PASS", "FAIL") else "INVALID"}
    for key, length in (("commit", 40), ("applicationSha256", 64), ("scriptSha256", 64), ("helperSha256", 64)):
        value = raw.get(key)
        result[key] = value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(length) + r"}", value) else None
    for key in ("flowCount", "appSessions"):
        value = raw.get(key)
        result[key] = value if type(value) is int and 0 <= value <= 2 else None
    checks = raw.get("checks") if isinstance(raw.get("checks"), dict) else {}
    result["checks"] = {name: checks.get(name) if checks.get(name) in ("PASS", "FAIL", "NOT_RUN") else "INVALID" for name in smoke.CHECKS}
    drop = raw.get("drop") if isinstance(raw.get("drop"), dict) else {}
    result["drop"] = {"transport": "TAURI_EVENT_IPC" if drop.get("transport") == "TAURI_EVENT_IPC" else "INVALID",
                      "nativePointerDrag": "NOT_RUN" if drop.get("nativePointerDrag") == "NOT_RUN" else "INVALID"}
    for name in ("gestures", "inputNotes", "retainedNotes"):
        value = drop.get(name)
        result["drop"][name] = value if type(value) is int and 0 <= value <= 2 else None
    for name in ("collisionRenameObserved", "originalCaseSpellingsBothRetained"):
        result["drop"][name] = drop.get(name) if type(drop.get(name)) is bool else None
    result["drop"]["destinationNames"] = ["Note.md", "note (1).md"] if drop.get("destinationNames") == ["Note.md", "note (1).md"] else []
    for name, keys in (("dropHit", ("insideNotes", "rootTarget")), ("dropTargets", ("upperExists", "lowerExists"))):
        value = raw.get(name) if isinstance(raw.get(name), dict) else {}
        result[name] = {key: value.get(key) if type(value.get(key)) is bool else None for key in keys}
    result["dropTrace"] = bounded_drop_trace(raw.get("dropTrace"))
    result["attachmentOpen"] = bounded_attachment_open_trace(raw.get("attachmentOpen"))
    policy = raw.get("attachmentPolicy") if isinstance(raw.get("attachmentPolicy"), dict) else {}
    result["attachmentPolicy"] = {name: expected if policy.get(name) == expected else None
        for name, expected in (("selected", "copy"), ("readBack", "copy"), ("method", "PRODUCTION_PREFERENCE_IPC"))}
    opened = raw.get("mediaOpen") if isinstance(raw.get("mediaOpen"), dict) else {}
    result["mediaOpen"] = {"method": "WEBDRIVER_POINTER_MOVE" if opened.get("method") == "WEBDRIVER_POINTER_MOVE" else "INVALID",
                           "clickAttempts": opened.get("clickAttempts") if type(opened.get("clickAttempts")) is int and 0 <= opened["clickAttempts"] <= 1 else None,
                           **{name: opened.get(name) if type(opened.get(name)) is bool else None for name in smoke.MEDIA_OPEN_FLAGS}}
    result["imageCopies"] = []
    for item in raw["imageCopies"] if isinstance(raw.get("imageCopies"), list) and len(raw["imageCopies"]) <= 2 else []:
        if not isinstance(item, dict):
            continue
        observed = {name: item.get(name) if type(item.get(name)) is int and 0 <= item[name] <= 2 else None
                    for name in ("session", "pngCount", "matchingDigestCount")}
        observed.update({name: item.get(name) if type(item.get(name)) is bool else None
                         for name in ("pngOverflow", "matchingDigestOverflow", "scanComplete", "nameMatchesPolicy", "noteLinkRewritten",
                                      "sourceImageUnchanged", "sourceNotesUnchanged", "productionResolved")})
        result["imageCopies"].append(observed)
    result["previews"] = []
    for probe in raw["previews"] if isinstance(raw.get("previews"), list) and len(raw["previews"]) <= 2 else []:
        if not isinstance(probe, dict):
            continue
        item = {name: probe.get(name) if type(probe.get(name)) is int and 0 <= probe[name] <= 4096 else None
                for name in ("session", "naturalWidth", "naturalHeight", "sampled", "matched")}
        item.update(visible=probe.get("visible") is True,
                    method="WEBVIEW_SCREENSHOT_PIXELS" if probe.get("method") == "WEBVIEW_SCREENSHOT_PIXELS" else "INVALID")
        result["previews"].append(item)
    clipboard = raw.get("clipboard") if isinstance(raw.get("clipboard"), dict) else {}
    result["previewToggle"] = bounded_preview_toggle(raw.get("previewToggle"))
    result["previewGeometry"] = bounded_preview_geometry(raw.get("previewGeometry"))
    result["clipboard"] = {"source": "REAL_NOTE_CONTEXT_MENU" if clipboard.get("source") == "REAL_NOTE_CONTEXT_MENU" else "INVALID",
                           "systemRead": "XCLIP" if clipboard.get("systemRead") == "XCLIP" else "INVALID",
                           "exactAbsolutePath": clipboard.get("exactAbsolutePath") is True}
    handoff = raw.get("handoff") if isinstance(raw.get("handoff"), dict) else {}
    expected_sha = hashlib.sha256(smoke.png_bytes()).hexdigest()
    result["handoff"] = {"kind": "OWNED_XDG_RECEIVER_READBACK" if handoff.get("kind") == "OWNED_XDG_RECEIVER_READBACK" else "INVALID",
                         "uiRoute": handoff.get("uiRoute") if handoff.get("uiRoute") in ("NOTE_PREVIEW_OPEN", "MATERIAL_DETAIL_OPEN") else "INVALID",
                         "exactExpectedFile": handoff.get("exactExpectedFile") is True,
                         "bytes": handoff.get("bytes") if type(handoff.get("bytes")) is int and handoff["bytes"] == len(smoke.png_bytes()) else None,
                         "sha256": expected_sha if handoff.get("sha256") == expected_sha else None,
                         "externalApplicationDisplay": "NOT_RUN" if handoff.get("externalApplicationDisplay") == "NOT_RUN" else "INVALID"}
    result["quitRequests"] = []
    for item in raw["quitRequests"] if isinstance(raw.get("quitRequests"), list) and len(raw["quitRequests"]) <= 2 else []:
        if isinstance(item, dict):
            result["quitRequests"].append({"ipcReplyObserved": item.get("ipcReplyObserved") is True,
                "priorProcessIdentitiesGone": item.get("priorProcessIdentitiesGone") is True,
                "exitStatus": "NOT_OBSERVED" if item.get("exitStatus") == "NOT_OBSERVED" else "INVALID"})
    for name in ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer"):
        result[name] = "NOT_RUN" if raw.get(name) == "NOT_RUN" else "INVALID"
    result["attachmentMaintenance"] = bounded_maintenance(raw.get("attachmentMaintenance"))
    result["canvasStorage"] = bounded_canvas_storage(raw.get("canvasStorage"))
    result["canvasFlow"] = bounded_canvas_flow(raw.get("canvasFlow"))
    result["directorWebgl"] = bounded_director_webgl(raw.get("directorWebgl"))
    if "failure" in raw:
        failure = raw["failure"] if isinstance(raw["failure"], dict) else {}
        result["failure"] = {"phase": failure.get("phase") if isinstance(failure.get("phase"), str) and failure["phase"] in PHASES else "unknown",
                             "action": failure.get("action") if isinstance(failure.get("action"), str) and failure["action"] in smoke.ACTIONS else "unknown",
                             "code": failure.get("code") if isinstance(failure.get("code"), str) and failure["code"] in FAILURES else "unexpected-error"}
        if "webdriver" in failure:
            result["failure"]["webdriver"] = bounded_driver(failure["webdriver"])
        if "observed" in failure:
            result["failure"]["observed"] = smoke.bounded_observed(failure["observed"])
        if "interactability" in failure:
            result["failure"]["interactability"] = bounded_interactability(failure["interactability"])
    if "unconfirmedCopy" in raw:
        result["unconfirmedCopy"] = bounded_unconfirmed_copy(raw["unconfirmedCopy"])
    if "cleanupEvidence" in raw:
        result["cleanupEvidence"] = bounded_cleanup(raw["cleanupEvidence"])
    if "cleanup" in raw:
        result["cleanup"] = "UNCONFIRMED"
    return result


def expected_maintenance():
    result = {}
    for name, (fixed, flags, counts) in smoke.MAINTENANCE_FIELDS.items():
        result[name] = {**fixed, **{flag: True for flag in flags}}
    result["noteRename"].update(newRecords=1, tombstones=1, materialAssetIdShape={
        "before": "NULL", "first": "NULL", "final": "NULL", "waitedSeconds": smoke.ASSET_ID_SETTLE_SECONDS})
    result["rollback"]["tombstones"] = 0
    result["materialDelete"]["quarantineLeftovers"] = 0
    result["notRun"] = dict(smoke.MAINTENANCE_NOT_RUN)
    return result


def validate_notes(raw, build, source, scripts):
    require(isinstance(raw, dict) and raw == bounded_report(raw), "notes-report-shape-invalid")
    require(isinstance(raw, dict) and raw.get("schemaVersion") == 1 and raw.get("status") == "PASS" and "failure" not in raw and "cleanup" not in raw,
            "notes-flow-not-complete")
    require("unconfirmedCopy" not in raw, "copy-response-not-confirmed")
    require(raw.get("scope") == SCOPE and raw.get("commit") == source["commit"]
            and raw.get("applicationSha256") == build["application"]["sha256"]
            and raw.get("scriptSha256") == scripts["smoke"] and raw.get("helperSha256") == scripts["webdriver"], "notes-source-identity-mismatch")
    require(raw.get("flowCount") == 1 and raw.get("appSessions") == 2
            and all(raw.get("checks", {}).get(name) == "PASS" for name in smoke.CHECKS), "required-notes-check-missing")
    require(raw.get("drop") == {"transport": "TAURI_EVENT_IPC", "nativePointerDrag": "NOT_RUN", "gestures": 1,
            "inputNotes": 2, "retainedNotes": 2, "collisionRenameObserved": True,
            "originalCaseSpellingsBothRetained": False, "destinationNames": ["Note.md", "note (1).md"]}, "drop-boundary-or-retention-mismatch")
    require(raw.get("dropTargets") == {"upperExists": True, "lowerExists": True}, "synthetic-drop-targets-missing")
    require(raw.get("attachmentPolicy") == {"selected": "copy", "readBack": "copy", "method": "PRODUCTION_PREFERENCE_IPC"}, "copy-preference-not-confirmed")
    require(raw.get("mediaOpen") == {"method": "WEBDRIVER_POINTER_MOVE", "clickAttempts": 1,
                                      **{name: True for name in smoke.MEDIA_OPEN_FLAGS}}, "real-hover-and-hit-evidence-missing")
    expected_copy = lambda session: {"session": session, "pngCount": 1, "matchingDigestCount": 1,
        "pngOverflow": False, "matchingDigestOverflow": False, "scanComplete": True, "nameMatchesPolicy": True,
        "noteLinkRewritten": True, "sourceImageUnchanged": True, "sourceNotesUnchanged": True, "productionResolved": True}
    require(raw.get("imageCopies") == [expected_copy(1), expected_copy(2)], "copied-image-retention-and-resolution-not-confirmed")
    trace = raw.get("dropTrace", {})
    require(trace.get("state") == "OBSERVED" and trace.get("truncated") is False, "native-import-completion-not-observed")
    records = trace.get("records", [])
    for stage, count in (("native-import-start", 2), ("native-source-active", 0), ("native-import-ok", 2), ("native-import-failed", 0)):
        require([record for record in records if record.get("stage") == stage]
                == [{"stage": stage, "count": count, "overflow": False, "hit": True}], "native-import-completion-not-observed")
    require(not any(record["stage"].startswith(("native-error-", "native-result-"))
                    or record["stage"] == "native-import-partial" for record in records), "native-import-reported-failure")
    expected_preview = lambda session: {"session": session, "naturalWidth": 32, "naturalHeight": 24,
        "sampled": 5, "matched": 5, "visible": True, "method": "WEBVIEW_SCREENSHOT_PIXELS"}
    require(raw.get("previews") == [expected_preview(1), expected_preview(2)], "real-preview-pixel-evidence-missing")
    require([(item["session"], item["found"], item["hit"], item["centerInViewport"]) for item in raw.get("previewGeometry", [])]
            == [(1, True, "SELF", True), (2, True, "SELF", True)], "real-preview-pixel-evidence-missing")
    require(raw.get("attachmentMaintenance") == expected_maintenance(), "attachment-maintenance-ui-evidence-missing")
    director = raw.get("directorWebgl") or {}
    require(director.get("directorCanvasPresent") is True
            and director.get("contextKind") == "webgl2"
            and director.get("contextLost") is False
            and director.get("rendererClass") in ("software", "hardware")
            and type(director.get("canvasWidth")) is int and director["canvasWidth"] > 0
            and type(director.get("canvasHeight")) is int and director["canvasHeight"] > 0
            and director.get("probeDrawn") is True and director.get("probeNonBlack") is True,
            "director-webgl-evidence-missing")
    require(raw.get("canvasFlow") == {"homeRendered": True, "editorOpened": True, "nodeAdded": True,
        "savedOnDisk": True, "reopened": True, "nodePresentAfterReopen": True,
        "documentNodes": 1, "temporaryLeftovers": 0}, "canvas-save-reopen-evidence-missing")
    canvas_storage = raw.get("canvasStorage", {})
    require(all(canvas_storage.get(name) == 0
                for name in ("canvasLeftovers", "attachmentLeftovers", "workspaceLeftovers",
                             "moveLeftovers"))
            and type(canvas_storage.get("directoriesScanned")) is int
            and 1 <= canvas_storage["directoriesScanned"] <= 8,
            "canvas-storage-temporary-leftover")
    require(raw.get("clipboard") == {"source": "REAL_NOTE_CONTEXT_MENU", "systemRead": "XCLIP", "exactAbsolutePath": True}, "real-clipboard-evidence-missing")
    handoff = raw.get("handoff", {})
    require(handoff.get("kind") == "OWNED_XDG_RECEIVER_READBACK" and handoff.get("exactExpectedFile") is True
            and handoff.get("uiRoute") in ("NOTE_PREVIEW_OPEN", "MATERIAL_DETAIL_OPEN")
            and handoff.get("bytes") == len(smoke.png_bytes())
            and handoff.get("sha256") == hashlib.sha256(smoke.png_bytes()).hexdigest()
            and handoff.get("externalApplicationDisplay") == "NOT_RUN", "os-handoff-readback-missing")
    require(raw.get("quitRequests") == [{"ipcReplyObserved": True, "priorProcessIdentitiesGone": True, "exitStatus": "NOT_OBSERVED"}] * 2,
            "application-quit-evidence-incomplete")
    opened = raw.get("attachmentOpen", {})
    records = opened.get("records", [])
    require(opened.get("state") == "OBSERVED" and opened.get("truncated") is False and records
            and records[0].get("route") in ("SYSTEM_OPEN", "MATERIAL_DETAIL"), "attachment-open-diagnostic-not-observed")
    require(all(raw.get(name) == "NOT_RUN" for name in
            ("externalApplicationDisplay", "trimmedFilenameEndToEnd", "waylandHardware", "installer")), "unverified-coverage-claimed")


class Run(runtime.Run):
    def scripts(self):
        paths = {"collector": "luckyray-app/tests/linux-notes-ci.py", "resourceCollector": "luckyray-app/tests/linux-runtime-ci.py",
                 "smoke": "luckyray-app/tests/linux-notes-attachments-smoke.py", "webdriver": "luckyray-app/tests/linux-desktop-smoke.py",
                 "workflow": ".github/workflows/linux-desktop-preflight.yml", "dropPaths": "luckyray-app/src/features/notes/externalDropPaths.ts",
                 "notesPage": "luckyray-app/src/features/notes/NotesPage.tsx",
                 "layoutBuild": "luckyray-app/tests/linux-media-layout-build.mjs",
                 "layoutAudit": "luckyray-app/tests/linux-media-layout-audit.mjs",
                 "layoutEvidence": "luckyray-app/tests/linux-media-layout-evidence.py",
                 "cdpClient": "luckyray-app/tests/browser-extension-runtime/lib/cdp-client.mjs",
                 "driverPrep": "luckyray-app/tests/linux-tauri-driver-source.py",
                 "driverDiagnostic": "luckyray-app/tests/linux-tauri-driver-forward-diagnostics.rs",
                 "nativeMessaging": "luckyray-app/tests/linux-native-registration-smoke.py",
                 "secretServiceSession": "luckyray-app/tests/linux-secret-service-session.sh",
                 "secretServiceChecks": "luckyray-app/tests/linux-companion-keyring/src/live_secret_service.rs",
                 "pairingWsClient": "luckyray-app/tests/lsh_remote_standard_ws_client.py",
                 "mediaPreviewRuntime": "luckyray-app/tests/linux-media-preview-runtime.py"}
        return {name: digest(self.repo / path) for name, path in paths.items()}

    def publish_notes(self, report):
        destination = self.evidence / "notes.json"
        if os.path.lexists(destination):
            entry = destination.lstat()
            require(stat.S_ISREG(entry.st_mode) and entry.st_uid == os.geteuid() and entry.st_nlink == 1,
                    "unsafe-notes-evidence-target")
        temporary = self.evidence / "notes.pending"
        with temporary.open("x") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, destination)

    def layout(self):
        source, scripts = self.source(), self.scripts()
        with (self.private / "component-layout.attempt").open("x"):
            pass
        wrapper = {"status": "FAIL", "source": source, "scripts": scripts, "attempts": 1}
        report = {"status": "NOT_RUN", "scope": SCOPE, "source": source, "attempts": 0, "flowCount": 0,
                  "componentLayout": wrapper}
        phase = "fixture-build"
        try:
            node = shutil.which(self.args.node)
            require(node is not None, "pinned-node-unavailable")
            root = self.private / "component-layout"
            root.mkdir(mode=0o700)
            fixture = root / "fixture"
            fixture.mkdir(mode=0o700)
            def png(width, height):
                def chunk(kind, value):
                    return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
                return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                        + chunk(b"IDAT", zlib.compress((b"\0" + bytes(smoke.COLOR) * width) * height)) + chunk(b"IEND", b""))
            write_json(root / "input.json", {"source": source, "probe": smoke.MEDIA_OPEN_PROBE,
                       **{name: "data:image/png;base64," + base64.b64encode(png(width, height)).decode("ascii")
                          for name, width, height in (("tiny", 32, 24), ("regular", 320, 240))}})
            environment = self.env()
            with (root / "fixture-build.log").open("xb") as log:
                built = subprocess.run([node, str(self.app / "tests/linux-media-layout-build.mjs"), str(self.app),
                    str(fixture), str(root / "input.json")], env=environment, stdout=log, stderr=log, timeout=90)
            require(built.returncode == 0, "component-fixture-build-failed")
            wrapper["fixtureSha256"] = digest(fixture / "index.html")
            phase = "layout-child"
            with (root / "audit.log").open("xb") as log:
                child = subprocess.Popen([node, str(self.app / "tests/linux-media-layout-audit.mjs"),
                    "--html", str(fixture / "index.html"), "--output", str(root / "report.json"),
                    "--browser", "/usr/bin/chromium", "--source-commit", source["commit"], "--source-tree", source["tree"]],
                    env=environment, stdout=log, stderr=log, start_new_session=True)
                try:
                    code = child.wait(timeout=300)
                except subprocess.TimeoutExpired:
                    # Only this single owned child session; never restart a browser or lower its sandbox.
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
                    raise
            wrapper["childExitCode"] = media_layout.integer(code, -65535, 65535)
            wrapper["observations"] = media_layout.bounded(read_json(root / "report.json"))
            phase = "layout-evidence"
            require(code == 0, "component-layout-child-failed")
            self.source()
            wrapper["status"] = "PASS"
            media_layout.validate(wrapper, source, scripts)
        except Exception:
            wrapper["status"] = "FAIL"
            wrapper["failure"] = phase + "-failed"
            raise RuntimeError("component-layout-precondition-failed") from None
        finally:
            self.publish_notes(report)

    def native_messaging(self):
        """Build-time independent: the step already produced the host report."""
        source = self.source()
        report = {"status": "FAIL", "scope": SCOPE, "source": source}
        try:
            raw = read_json(self.private / "native-messaging-report/report.json")
            report["observations"] = bounded_native_messaging(raw)
            validate_native_messaging(report["observations"], self.scripts())
            report["status"] = "PASS"
        finally:
            # A retried step must replace its own report, never fail on it.
            target = self.evidence / "nativeMessaging.json"
            if target.is_symlink() or target.exists():
                target.unlink()
            write_json(target, report)

    def notes(self):
        source = self.source()
        component = read_json(self.evidence / "notes.json").get("componentLayout")
        media_layout.validate(component, source, self.scripts())
        with (self.private / "notes.attempt").open("x"):
            pass
        build, resources = read_json(self.evidence / "build.json"), read_json(self.evidence / "resources.json")
        layout = read_json(self.private / "layout.json")
        require(build.get("status") == "PASS" and resources.get("status") == "PASS"
                and build.get("source") == source and resources.get("source") == source
                and resources.get("scope") == SCOPE, "source-bound-main-and-resources-required")
        require(runtime.regular_elf(Path(layout["application"])) == build["application"], "main-elf-changed")
        prepared_driver = validate_driver_source(read_json(self.private / "driver-source.json"), self.scripts())
        require(driver_source.verify_closure(self.work / "driver-source") == prepared_driver["sourceClosureSha256"], "prepared-driver-closure-changed")
        for name, expected in (("Cargo.lock", prepared_driver["lockSha256"]), ("src/main.rs", prepared_driver["patchedMainSha256"]),
                               ("src/server.rs", prepared_driver["patchedServerSha256"]),
                               ("src/luckyray_forward_diagnostics.rs", prepared_driver["diagnosticSha256"])):
            require(digest(self.work / "driver-source" / name) == expected, "prepared-driver-source-changed")
        require(b"[luckyray-forward-v1] connect=" in self.args.driver.read_bytes(), "driver-diagnostic-marker-missing")
        command = ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x900x24",
            "/usr/bin/python3", str(self.app / "tests/linux-notes-attachments-smoke.py"),
            "--application", layout["application"], "--driver", str(self.args.driver), "--output", str(self.private / "notes-flow")]
        report = {"status": "FAIL", "scope": SCOPE, "source": source, "attempts": 1, "flowCount": 1,
                  "componentLayout": component,
                  "driver": {"versionPin": "2.1.0", "source": prepared_driver, **runtime.regular_elf(self.args.driver)}}
        try:
            result = subprocess.run(command, env=self.env(), text=True, capture_output=True, timeout=720)
            (self.private / "notes-flow.log").write_text(result.stdout + result.stderr)
            report["childExitCode"] = result.returncode
            raw_path = self.private / "notes-flow/report.json"
            require(raw_path.is_file(), "child-report-unavailable")
            report["observations"] = bounded_report(read_json(raw_path))
            require(result.returncode == 0, "notes-child-failed")
            validate_notes(report["observations"], build, source, self.scripts())
            self.source()
            report["status"] = "PASS"
        except subprocess.TimeoutExpired:
            report["failure"] = "notes-child-timeout"
            raise
        except Exception:
            report["failure"] = "notes-child-or-evidence-incomplete"
            raise
        finally:
            self.publish_notes(report)

    def finish(self):
        outcomes = {name: os.environ.get("CI_" + name, "missing") for name in STEPS}
        bodies, statuses = {}, {}
        for name in EXPORTS[:-1]:
            try:
                bodies[name] = read_json(self.evidence / name)
                statuses[name] = bodies[name].get("status", "INVALID")
            except (OSError, ValueError, RuntimeError):
                statuses[name] = "INVALID" if os.path.lexists(self.evidence / name) else "NOT_RUN"
        passed = all(value == "success" for value in outcomes.values()) and all(value == "PASS" for value in statuses.values())
        source = {"commit": os.environ.get("GITHUB_SHA"), "sourceVerification": "FAILED"}
        try:
            source = self.source()
            require(all(body.get("source") == source and body.get("scope") == SCOPE for body in bodies.values()), "stale-report")
            require(bodies["build.json"].get("scripts") == self.scripts(), "build-script-identity-changed")
            notes = bodies["notes.json"]
            media_layout.validate(notes.get("componentLayout"), source, self.scripts())
            validate_driver_source(notes["driver"]["source"], self.scripts())
            require(notes.get("attempts") == 1 and notes.get("flowCount") == 1 and notes.get("childExitCode") == 0
                    and "failure" not in notes, "missing-or-repeated-flow")
            validate_notes(notes.get("observations"), bodies["build.json"], source, self.scripts())
        except (OSError, ValueError, KeyError, TypeError, RuntimeError):
            passed = False
        # Keep the same five-file artifact even when a precondition stops native build.
        for name in EXPORTS[:-1]:
            if statuses[name] == "NOT_RUN" and not os.path.lexists(self.evidence / name):
                write_json(self.evidence / name, {"status": "NOT_RUN", "scope": SCOPE, "source": source})
        safe = ({path.name for path in self.evidence.iterdir()} == set(EXPORTS[:-1])
                and all(path.is_file() and not path.is_symlink() for path in self.evidence.iterdir()))
        passed = passed and safe
        write_json(self.evidence / "result.json", {"status": "PASS" if passed else "FAIL", "scope": SCOPE,
            "source": source, "stepOutcomes": outcomes, "reports": statuses, "artifactAllowlist": list(EXPORTS),
            "exportPolicy": "PASS" if safe else "FAIL", "included": {"notesPngFlows": 1 if bodies.get("notes.json", {}).get("flowCount") == 1 else 0,
                "componentLayout": bodies.get("notes.json", {}).get("componentLayout", {}).get("status", "NOT_RUN")},
            "excluded": {**EXCLUDED, "nativeMessaging":
                "REGISTRATION_AND_ROUND_TRIP_PASS" if bodies.get("nativeMessaging.json", {}).get("status") == "PASS" else EXCLUDED["nativeMessaging"]},
            "productAcceptance": "NOTES_PATH_ATTACHMENTS_PASS_ONLY" if passed else "NOT_RUN",
            "limits": ["drop is one declared Tauri event IPC injection; native pointer drag NOT_RUN",
                       "case-distinct input contents retained; existing importer collision rename preserved",
                       "PNG decoded and sampled in Main WebDriver screenshot, not physical-display QA",
                       "owned isolated XDG receiver readback; external application display NOT_RUN",
                       "trailing-whitespace filenames, video codecs, embedded browser and packages NOT_RUN",
                       "quit IPC and process disappearance; clean exit status NOT_OBSERVED",
                       "component layout is a precondition, not Main product acceptance",
                       "attachment rename and recovery rollback via real settings UI; path inputs set by DOM value events",
                       "source-mode material import via declared Tauri drop IPC; real context-menu rename and source delete",
                       "canvas/attachment/workspace writes fsync the directory entry (write-through); UI canvas flow NOT_RUN",
                       "delete quarantine intermediate and crash resume OFFLINE_ONLY; conversion, note move, material move and insert-copy NOT_RUN"]})
        require(passed, "required-notes-product-flow-failed-or-not-run")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "layout", "binaries", "resources", "notes",
                                          "native-messaging", "finish"))
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--driver", type=Path)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    getattr(Run(args), args.phase.replace("-", "_"))()


if __name__ == "__main__":
    main()
