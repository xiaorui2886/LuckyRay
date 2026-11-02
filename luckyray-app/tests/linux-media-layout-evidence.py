"""Closed component-layout evidence; never substitutes Main acceptance."""
SCOPE = "production-note-media-component-layout-only"
CASES = ("read-small", "read-regular", "live-small", "live-regular")
VIEWPORTS = (1024, 560)
MODES = ("hover", "focus")
FLAGS = ("toolbarVisible", "toolbarFullyVisible", "buttonEnabled", "controlsFullyVisible", "buttonCenterHit", "allButtonCentersHit")
PHASES = ("ordinary-user", "user-namespace", "browser-identity", "browser-start", "cdp-connect", "sandbox-page", "sandbox-assertion",
          "fixture-ready", "native-hover", "native-focus", "native-click", "browser-cleanup", "complete", "unknown")
CODES = tuple(name + "-failed" for name in PHASES) + ("unknown",)


def integer(value, low, high):
    return value if type(value) is int and low <= value <= high else None


def digest(value):
    import re
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) else None


def source(value):
    import re
    value = value if isinstance(value, dict) else {}
    return {name: value.get(name) if isinstance(value.get(name), str) and re.fullmatch(r"[0-9a-f]{40}", value[name]) else None
            for name in ("commit", "tree")}


def bounded(raw):
    import re
    raw = raw if isinstance(raw, dict) else {}
    report = {"schemaVersion": 1 if type(raw.get("schemaVersion")) is int and raw["schemaVersion"] == 1 else None,
              "scope": SCOPE if raw.get("scope") == SCOPE else "INVALID",
              "status": raw.get("status") if raw.get("status") in ("PASS", "FAIL") else "INVALID",
              "source": source(raw.get("source")), "attempts": integer(raw.get("attempts"), 0, 1),
              "browserLaunches": integer(raw.get("browserLaunches"), 0, 1),
              "userNamespaceExitCode": integer(raw.get("userNamespaceExitCode"), -65535, 65535),
              "scriptSha256": digest(raw.get("scriptSha256")), "fixtureSha256": digest(raw.get("fixtureSha256")),
              "fixtureSourceMatches": raw.get("fixtureSourceMatches") is True,
              "mainProductAcceptance": "NOT_RUN" if raw.get("mainProductAcceptance") == "NOT_RUN" else "INVALID",
              "javascriptError": raw.get("javascriptError") if raw.get("javascriptError") in ("NONE", "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "UNKNOWN") else "UNKNOWN"}
    browser = raw.get("browser") if isinstance(raw.get("browser"), dict) else {}
    report["browser"] = {"version": browser.get("version") if isinstance(browser.get("version"), str)
                          and re.fullmatch(r"Chromium [0-9]+(?:\.[0-9]+){1,5}", browser["version"]) else None,
                          "sha256": digest(browser.get("sha256")), "bytes": integer(browser.get("bytes"), 1, 2**31),
                          "elf": browser.get("elf") is True}
    sandbox = raw.get("sandbox") if isinstance(raw.get("sandbox"), dict) else {}
    report["sandbox"] = {"status": "PASS" if sandbox.get("status") == "PASS" else "NOT_RUN",
        **{name: "Yes" if sandbox.get(name) == "Yes" else None for name in ("namespace", "pidNamespaces", "networkNamespaces", "seccompBpf")},
        "adequatelySandboxed": sandbox.get("adequatelySandboxed") is True,
        "securityDisablingFlags": [] if sandbox.get("securityDisablingFlags") == [] else ["INVALID"],
        "source": "ACTUAL_CHROME_SANDBOX_PAGE" if sandbox.get("source") == "ACTUAL_CHROME_SANDBOX_PAGE" else "INVALID"}
    cleanup = raw.get("cleanup") if isinstance(raw.get("cleanup"), dict) else {}
    report["cleanup"] = {"processGone": cleanup.get("processGone") is True,
        "exitCode": integer(cleanup.get("exitCode"), -65535, 65535),
        "signal": cleanup.get("signal") if cleanup.get("signal") in (None, "SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGKILL", "SIGSEGV", "SIGSYS", "SIGTERM", "SIGTRAP") else "UNKNOWN"}
    report["observations"] = []
    for row in raw["observations"][:16] if isinstance(raw.get("observations"), list) else []:
        if not isinstance(row, dict):
            continue
        report["observations"].append({
            "case": row.get("case") if row.get("case") in CASES else "INVALID",
            "mode": row.get("mode") if row.get("mode") in MODES else "INVALID",
            "viewport": row.get("viewport") if type(row.get("viewport")) is int and row["viewport"] in VIEWPORTS else None,
            "naturalWidth": integer(row.get("naturalWidth"), 1, 320), "naturalHeight": integer(row.get("naturalHeight"), 1, 240),
            **{name: row.get(name) if type(row.get(name)) is bool else None for name in
               ("displaySizeValid", "hoverApplied", "focusWithin", "controlFocused", *FLAGS, "clickedOnce")},
            "clickAttempts": integer(row.get("clickAttempts"), 0, 1)})
    report["observationOverflow"] = raw.get("observationOverflow") is True or isinstance(raw.get("observations"), list) and len(raw["observations"]) > 16
    if "failure" in raw:
        failure = raw["failure"] if isinstance(raw["failure"], dict) else {}
        report["failure"] = {"phase": failure.get("phase") if failure.get("phase") in PHASES else "unknown",
                             "code": failure.get("code") if failure.get("code") in CODES else "unknown"}
    return report


def validate(wrapper, expected_source, scripts):
    def require(value):
        if not value:
            raise RuntimeError("required-component-layout-not-complete")
    require(isinstance(wrapper, dict) and wrapper.get("status") == "PASS" and "failure" not in wrapper)
    require(set(wrapper) == {"status", "source", "scripts", "attempts", "childExitCode", "fixtureSha256", "observations"})
    require(wrapper.get("source") == expected_source and wrapper.get("scripts") == scripts
            and type(wrapper.get("attempts")) is int and wrapper["attempts"] == 1
            and type(wrapper.get("childExitCode")) is int and wrapper["childExitCode"] == 0)
    raw = wrapper.get("observations")
    require(isinstance(raw, dict) and raw == bounded(raw) and raw.get("schemaVersion") == 1 and raw.get("status") == "PASS" and "failure" not in raw)
    require(raw.get("scope") == SCOPE and raw.get("source") == expected_source and raw.get("attempts") == 1
            and raw.get("browserLaunches") == 1 and raw.get("userNamespaceExitCode") == 0
            and raw.get("scriptSha256") == scripts.get("layoutAudit") and raw.get("fixtureSha256") == wrapper.get("fixtureSha256")
            and digest(raw.get("fixtureSha256")) is not None and raw.get("fixtureSourceMatches") is True
            and raw.get("mainProductAcceptance") == "NOT_RUN" and raw.get("javascriptError") == "NONE")
    browser = raw["browser"]
    require(browser["version"] is not None and browser["sha256"] is not None and browser["bytes"] is not None and browser["elf"] is True)
    require(raw["sandbox"] == {"status": "PASS", "namespace": "Yes", "pidNamespaces": "Yes", "networkNamespaces": "Yes", "seccompBpf": "Yes",
        "adequatelySandboxed": True, "securityDisablingFlags": [], "source": "ACTUAL_CHROME_SANDBOX_PAGE"})
    require(raw["cleanup"] == {"processGone": True, "exitCode": 0, "signal": None})
    rows = raw["observations"]
    require(len(rows) == 16 and raw["observationOverflow"] is False)
    require({(row["case"], row["viewport"], row["mode"]) for row in rows} == {(case, viewport, mode) for case in CASES for viewport in VIEWPORTS for mode in MODES})
    for row in rows:
        small = row["case"].endswith("small")
        require(row["naturalWidth"] == (32 if small else 320) and row["naturalHeight"] == (24 if small else 240)
                and row["displaySizeValid"] is True and row["clickedOnce"] is True and row["clickAttempts"] == 1
                and all(row[name] is True for name in FLAGS))
        require(row["hoverApplied"] is (row["mode"] == "hover") and row["focusWithin"] is (row["mode"] == "focus")
                and row["controlFocused"] is (row["mode"] == "focus"))
