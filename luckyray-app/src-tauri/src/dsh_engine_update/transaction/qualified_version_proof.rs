//! Explicit ignored engineering proof. Ephemeral key/identity only; production
//! build trust stays unconfigured. One actual binary assembles both genuine
//! frozen versions, gracefully retires an already-used old host, and a NEW
//! process reopens the signed active marker and real new carrier/plugin gate.
use super::*;
use crate::dsh_host::{DshHostAction, tests::qualified_service_for_integration};
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};
const FEED: &str = "https://updates.example.test/qualified/feed.json";
const CHILD: &str = "dsh_engine_update::transaction::qualified_version_proof::reopen_qualified_active_in_fresh_process";

fn verify_fixture(envelope: &[u8], key: &[u8], from: &str) -> Result<Candidate, super::super::AdmissionError> {
    super::super::verify_installed_with_contract(envelope, key, FEED, env!("CARGO_PKG_VERSION"),
        from, env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"))
}

fn session_logs(app_data: &Path) -> Vec<(String, String)> {
    let mut pending = vec![app_data.join("deepseek-harness/native-state/rc8-v1/sessions")];
    let mut output = Vec::new();
    let mut directories = 0;
    while let Some(directory) = pending.pop() {
        directories += 1; assert!(directories <= 256);
        for item in fs::read_dir(directory).unwrap() {
            let path = item.unwrap().path();
            let meta = safe_runtime_entry(&path).unwrap();
            if meta.is_dir() { pending.push(path); }
            else if path.to_str().unwrap().ends_with(".jsonl") || path.to_str().unwrap().ends_with(".jsonl.zstd") {
                assert!(meta.is_file() && meta.len() <= 8 * 1024 * 1024);
                output.push((path.strip_prefix(app_data).unwrap().to_str().unwrap().replace('\\', "/"),
                    super::super::digest_file(&path).unwrap()));
                assert!(output.len() <= 128);
            }
        }
    }
    output.sort_unstable(); output
}

fn assert_session_logs_preserved(app_data: &Path, records: &[(String, String)]) {
    for (path, expected) in records {
        let relative = Path::new(path);
        assert!(!relative.is_absolute() && relative.components().all(|part| matches!(part, std::path::Component::Normal(_))));
        assert!(relative.starts_with("deepseek-harness/native-state/rc8-v1/sessions"));
        assert_eq!(&super::super::digest_file(&app_data.join(path)).unwrap(), expected);
    }
}
fn candidate_from_real_input(path: &Path, baseline: &Path, from: &str, pair: &Ed25519KeyPair) -> AdmittedCandidate {
    let description: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(description["schema"], 2);
    let authority = &description["qualification"]["authority"];
    let mut pending = vec![baseline.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for item in fs::read_dir(directory).unwrap() {
            let path = item.unwrap().path();
            let meta = safe_runtime_entry(&path).unwrap();
            if meta.is_dir() { pending.push(path); }
            else { assert!(meta.is_file()); files.push((path.strip_prefix(baseline).unwrap().to_str().unwrap().replace('\\', "/"),
                meta.len(), super::super::digest_file(&path).unwrap())); }
        }
    }
    files.sort_unstable();
    let mut closure = sha2::Sha256::new();
    for (name, size, sha) in &files {
        closure.update(name.as_bytes()); closure.update([0]); closure.update(size.to_string().as_bytes());
        closure.update([0]); closure.update(sha.as_bytes()); closure.update(b"\n");
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let candidate = Candidate {
        schema: 1, channel: super::super::CHANNEL.into(), platform: super::super::PLATFORM.into(),
        runtime_package: "@deepseek-ai/dsh".into(), version: authority["runtimePackage"]["version"].as_str().unwrap().into(),
        issued_at: now - 1, expires_at: now + 86400, host_version: env!("CARGO_PKG_VERSION").into(),
        adapter_fingerprint: env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT").into(), resource_gate_sha256: env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256").into(),
        from_versions: vec![from.into()], node_sha256: authority["nodeRuntime"]["nodeExeSha256"].as_str().unwrap().into(),
        entry_sha256: description["qualification"]["dependencyAudit"]["entryPoint"]["fileSha256"].as_str().unwrap().into(),
        artifact_url: format!("https://updates.example.test/qualified/{}.json", authority["runtimePackage"]["version"].as_str().unwrap()),
        artifact_sha256: super::super::digest_file(path).unwrap(), artifact_bytes: fs::metadata(path).unwrap().len(),
        closure_sha256: format!("{:x}", closure.finalize()), closure_file_count: files.len() as u32,
        data_compatibility: "no-migration".into(), upstream: None,
        compatibility: None,
        assembly: Some(super::super::assembly::FrozenAssemblyIdentity { schema: 2, kind: "official-npm-qualified-win-x64-v2".into(),
            toolset: Some("node22.19.0-pnpm11.7.0-policy1".into()) }),
    };
    assert_eq!(candidate.closure_file_count as u64, authority["dependencyClosure"]["releaseLayout"]["fileCount"].as_u64().unwrap());
    let payload = serde_json::to_vec(&candidate).unwrap();
    let signed_envelope = serde_json::to_vec(&serde_json::json!({ "payload": URL_SAFE_NO_PAD.encode(&payload),
        "signature": URL_SAFE_NO_PAD.encode(pair.sign(&payload).as_ref()) })).unwrap();
    let readmitted = super::super::admit_with_contract(&signed_envelope, Some(pair.public_key().as_ref()), Some(FEED), from,
        env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"), now).unwrap();
    super::super::verify_runtime_closure(&readmitted, baseline).unwrap();
    AdmittedCandidate { candidate: readmitted, signed_envelope }
}

#[test]
#[ignore = "real official downloads/two actual frozen versions; generated synthetic identity only"]
fn same_binary_qualifies_two_real_versions_and_switches_after_used_host_shutdown() {
    let old_desc = PathBuf::from(std::env::var_os("DSH_QUALIFIED_OLD_DESCRIPTION").unwrap());
    let new_desc = PathBuf::from(std::env::var_os("DSH_QUALIFIED_NEW_DESCRIPTION").unwrap());
    let old_baseline = PathBuf::from(std::env::var_os("DSH_QUALIFIED_OLD_BASELINE").unwrap());
    let new_baseline = PathBuf::from(std::env::var_os("DSH_QUALIFIED_NEW_BASELINE").unwrap());
    assert!([&old_desc, &new_desc, &old_baseline, &new_baseline].iter().all(|path| path.is_absolute()));
    let old_version = std::env::var("DSH_QUALIFIED_OLD_VERSION").unwrap_or_else(|_| "0.1.5-rc.2".into());
    let new_version = std::env::var("DSH_QUALIFIED_NEW_VERSION").unwrap_or_else(|_| "0.1.7-rc.2".into());
    assert_ne!(old_version, new_version);
    let key = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
    let old = candidate_from_real_input(&old_desc, &old_baseline, "0.1.1-rc.2", &pair);
    let new = candidate_from_real_input(&new_desc, &new_baseline, &old_version, &pair);
    assert_eq!(old.version(), old_version); assert_eq!(new.version(), new_version);
    let scratch = tempfile::Builder::new().prefix("luckyray-qualified-version-proof-").tempdir().unwrap().keep();
    println!("QUALIFIED_PROOF_RETAINED {}", scratch.display());
    fs::write(scratch.join("fixture-versions.json"), serde_json::to_vec(&(&old_version, &new_version)).unwrap()).unwrap();
    let app_data = scratch.join("synthetic-app-data"); fs::create_dir(&app_data).unwrap();
    fs::write(scratch.join("fixture-public-key"), pair.public_key().as_ref()).unwrap();
    fs::write(scratch.join("host-binary.sha256"), super::super::digest_file(&std::env::current_exe().unwrap()).unwrap()).unwrap();
    let store = UpdateStore::open(&app_data).unwrap();
    let cancel = AtomicBool::new(false);
    let old_host = if std::env::var("DSH_QUALIFIED_REUSE_VERIFIED_OLD_BASELINE").ok().as_deref() == Some("1") {
        // candidate_from_real_input already verifies the entire genuine old
        // closure. Reuse that sealed baseline in a NEW synthetic identity;
        // target acquisition and activation still use the ordinary UpdateStore.
        println!("QUALIFIED_OLD_BASELINE_REUSED version={old_version} fullClosureVerified=true oldAssemblyNotRepeated=true");
        qualified_service_for_integration(old_baseline.clone(), old.candidate, &app_data)
    } else {
        let prepared_old = store.prepare_from_archive_with_progress(old, &old_desc, &cancel,
            &mut |phase, done, total| { if phase == "assemble" || done == total { println!("QUALIFIED_OLD_PHASE {phase} {done}/{total}"); } }).unwrap();
        qualified_service_for_integration(prepared_old.root.clone(), prepared_old.admitted.candidate.clone(), &app_data)
    };
    assert!(old_host.probe(DshHostAction::Probe).unwrap().latest_probe_passed);
    old_host.open_native_surface().unwrap();
    assert_eq!(old_host.plugin_compat_check(false).unwrap()["checked"], true);
    println!("QUALIFIED_OLD_REAL_HOST_READY version={old_version} probePassed=true carrierReady=true pluginChecked=true");
    let old_logs = session_logs(&app_data);
    assert!(!old_logs.is_empty(), "real old runtime must have written a closed session history");
    fs::write(scratch.join("old-session-log-hashes.json"), serde_json::to_vec(&old_logs).unwrap()).unwrap();
    // This carrier-only engineering test has no Web client. Close the used
    // surface normally before lengthy acquisition; otherwise the unchanged
    // 90s client-readiness watchdog correctly reclaims the unpresented child.
    // Level-1 close retains the already-used outer host (not a cold host).
    let closed = old_host.close_native_surface().unwrap();
    assert_eq!(closed.owned_direct_process_count, 2);
    println!("QUALIFIED_OLD_USED_SURFACE_CLOSED retainedUsedHost=true");
    // Synthetic unsent draft sentinel: verify that switching never restores
    // backup data over either this old record or later new engine writes.
    let draft = app_data.join("deepseek-harness/native-state/rc8-v1/unsent-draft-proof.txt");
    fs::write(&draft, b"old synthetic draft never send").unwrap();
    let prepared = store.prepare_from_archive_with_progress(new, &new_desc, &cancel,
        &mut |phase, done, total| { if phase == "assemble" || done == total { println!("QUALIFIED_NEW_PHASE {phase} {done}/{total}"); } }).unwrap();
    store.schedule_restart_switch_with_bundled(&prepared, &old_version, Some(&old_version)).unwrap();
    assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
    assert!(old_host.shutdown(), "actual already-used old owned Job must settle before activation marker");
    drop(old_host);
    println!("QUALIFIED_OLD_GRACEFUL_SHUTDOWN settled=true markerNotArmedBeforeShutdown=true");
    store.arm_after_confirmed_shutdown().unwrap();
    let public = pair.public_key().as_ref();
    assert!(store.complete_pending_switch_with(&app_data, &old_version, |envelope, from, now| {
        super::super::admit_with_contract(envelope, Some(public), Some(FEED), from,
            env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"), now)
            .map(|candidate| AdmittedCandidate { candidate, signed_envelope: envelope.to_vec() })
    }).unwrap());
    let active = store.load_active_with_verifier(|envelope| verify_fixture(envelope, public, &old_version)).unwrap().unwrap();
    assert_eq!(active.candidate.version, new_version); assert!(active.pending_health);
    assert_eq!(fs::read(&draft).unwrap(), b"old synthetic draft never send");
    assert_session_logs_preserved(&app_data, &old_logs);
    println!("QUALIFIED_ACTIVE_SWITCH version={new_version} signedClosureVerified=true pendingHealth=true oldDraftPreserved=true");
    drop(store);
    // Fresh host PROCESS, exact same executable. No recompilation, dynamic
    // test root override for production, fake runtime version or GUI activation.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args(["--ignored", "--exact", CHILD, "--nocapture", "--test-threads=1"])
        .env("DSH_QUALIFIED_PROOF_REOPEN", &scratch);
    use std::os::windows::process::CommandExt;
    child.creation_flags(0x08000000);
    assert!(child.status().unwrap().success());
    let reopened = UpdateStore::open(&app_data).unwrap();
    let active = reopened.load_active_with_verifier(|envelope| verify_fixture(envelope, public, &old_version)).unwrap().unwrap();
    assert!(!active.pending_health); assert!(!reopened.pending_switch());
    assert_eq!(fs::read(&draft).unwrap(), b"new synthetic draft still unsent");
    assert_session_logs_preserved(&app_data, &old_logs);
    println!("QUALIFIED_VERSION_SWITCH_OK old={old_version} new={new_version} hostSha256={} freshProcess=true",
        super::super::digest_file(&std::env::current_exe().unwrap()).unwrap());
}

#[test]
#[ignore = "only spawned by the same-binary signed qualification proof"]
fn reopen_qualified_active_in_fresh_process() {
    let root = PathBuf::from(std::env::var_os("DSH_QUALIFIED_PROOF_REOPEN").unwrap());
    assert!(root.starts_with(std::env::temp_dir()) && root.file_name().unwrap().to_str().unwrap().starts_with("luckyray-qualified-version-proof-"));
    let binary = super::super::digest_file(&std::env::current_exe().unwrap()).unwrap();
    assert_eq!(fs::read_to_string(root.join("host-binary.sha256")).unwrap(), binary);
    let public = fs::read(root.join("fixture-public-key")).unwrap();
    let (old_version, new_version): (String, String) = serde_json::from_slice(&fs::read(root.join("fixture-versions.json")).unwrap()).unwrap();
    let fixture_feed = fs::read_to_string(root.join("fixture-feed.url")).unwrap_or_else(|_| FEED.into());
    let verify = |envelope: &[u8]| super::super::verify_installed_with_contract(envelope, &public, &fixture_feed,
        env!("CARGO_PKG_VERSION"), &old_version, env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"));
    let app_data = root.join("synthetic-app-data");
    let old_logs: Vec<(String, String)> = serde_json::from_slice(&fs::read(root.join("old-session-log-hashes.json")).unwrap()).unwrap();
    let store = UpdateStore::open(&app_data).unwrap();
    let active = store.load_active_with_verifier(verify).unwrap().unwrap();
    assert_eq!(active.candidate.version, new_version); assert!(active.pending_health);
    let host = qualified_service_for_integration(active.root.clone(), active.candidate.clone(), &app_data);
    assert!(host.probe(DshHostAction::Probe).unwrap().latest_probe_passed);
    host.open_native_surface().unwrap();
    assert_eq!(host.plugin_compat_check(false).unwrap()["checked"], true);
    assert_session_logs_preserved(&app_data, &old_logs);
    let first_new_logs = session_logs(&app_data);
    assert!(first_new_logs.len() > old_logs.len(), "real new runtime must add its own completed session history");
    store.mark_healthy(&active).unwrap();
    let draft = app_data.join("deepseek-harness/native-state/rc8-v1/unsent-draft-proof.txt");
    assert_eq!(fs::read(&draft).unwrap(), b"old synthetic draft never send");
    fs::write(&draft, b"new synthetic draft still unsent").unwrap();
    host.close_native_surface().unwrap(); assert!(host.shutdown()); drop(host);
    let reopened_host = qualified_service_for_integration(active.root, active.candidate, &app_data);
    assert!(reopened_host.probe(DshHostAction::Probe).unwrap().latest_probe_passed);
    reopened_host.open_native_surface().unwrap();
    assert_eq!(reopened_host.plugin_compat_check(false).unwrap()["checked"], true);
    reopened_host.close_native_surface().unwrap(); assert!(reopened_host.shutdown());
    assert_eq!(fs::read(draft).unwrap(), b"new synthetic draft still unsent");
    assert_session_logs_preserved(&app_data, &first_new_logs);
    println!("QUALIFIED_REAL_HISTORY_PRESERVED oldArtifacts={} afterNewArtifacts={} newDataSurvivedReopen=true", old_logs.len(), first_new_logs.len());
    println!("QUALIFIED_FRESH_PROCESS_REOPEN_OK hostSha256={binary} healthCommitted=true pluginChecked=true");
}

fn copy_verified_fixture(source: &Path, target: &Path) {
    assert!(!target.exists());
    fs::create_dir(target).unwrap();
    for item in fs::read_dir(source).unwrap() {
        let item = item.unwrap();
        let meta = safe_runtime_entry(&item.path()).unwrap();
        let destination = target.join(item.file_name());
        if meta.is_dir() { copy_verified_fixture(&item.path(), &destination); }
        else { assert!(meta.is_file()); fs::copy(item.path(), destination).unwrap(); }
    }
}

#[test]
#[ignore = "explicit isolated HTTPS settings/update/reopen proof using previously qualified real17 and20 artifacts"]
fn settings_updates_with_semantic_contract_and_reopens_real_020() {
    use super::super::{compatibility, coordinator::DshEngineUpdater, TrustedSource};
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::os::windows::process::CommandExt;
    let old_desc = PathBuf::from(std::env::var_os("DSH_QUALIFIED_OLD_DESCRIPTION").unwrap());
    let new_desc = PathBuf::from(std::env::var_os("DSH_QUALIFIED_NEW_DESCRIPTION").unwrap());
    let old_baseline = PathBuf::from(std::env::var_os("DSH_QUALIFIED_OLD_BASELINE").unwrap());
    let new_baseline = PathBuf::from(std::env::var_os("DSH_QUALIFIED_NEW_BASELINE").unwrap());
    let scratch = tempfile::Builder::new().prefix("luckyray-qualified-version-proof-").tempdir().unwrap().keep();
    println!("SEMANTIC_SETTINGS_PROOF_RETAINED {}", scratch.display());
    let app_data = scratch.join("synthetic-app-data"); fs::create_dir(&app_data).unwrap();
    let key = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
    let old = candidate_from_real_input(&old_desc, &old_baseline, "0.1.5-rc.2", &pair);
    let mut new = candidate_from_real_input(&new_desc, &new_baseline, "0.1.7-rc.2", &pair).candidate;
    assert_eq!(old.version(), "0.1.7-rc.2"); assert_eq!(new.version, "0.2.0-rc.2");
    fs::write(scratch.join("fixture-versions.json"), serde_json::to_vec(&(old.version(), &new.version)).unwrap()).unwrap();
    fs::write(scratch.join("fixture-public-key"), pair.public_key().as_ref()).unwrap();
    fs::write(scratch.join("host-binary.sha256"), super::super::digest_file(&std::env::current_exe().unwrap()).unwrap()).unwrap();
    for (variable, name) in [("DSH_COMPAT_TEST_CERT", "tls-cert.pem"), ("DSH_COMPAT_TEST_KEY", "tls-key.pem")] {
        fs::copy(PathBuf::from(std::env::var_os(variable).unwrap()), scratch.join(name)).unwrap();
    }
    fs::write(scratch.join("mode.txt"), "missing").unwrap();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("scripts/dsh-engine-compat-fixture.mjs");
    let mut server = Command::new(old_baseline.join("node/node.exe")).arg(script).arg(&scratch).arg(&new_desc)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).creation_flags(0x08000000).spawn().unwrap();
    for _ in 0..200 {
        if scratch.join("ready.json").is_file() { break; }
        assert!(server.try_wait().unwrap().is_none()); std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let ready: serde_json::Value = serde_json::from_slice(&fs::read(scratch.join("ready.json")).unwrap()).unwrap();
    let feed = ready["feed"].as_str().unwrap().to_owned();
    fs::write(scratch.join("fixture-feed.url"), &feed).unwrap();
    new.artifact_url = feed.replace("/feed.json", "/descriptor.json");
    new.schema = 2; new.compatibility = Some(compatibility::fixture());
    // Deliberately different source evidence: the semantic interface remains
    // supported, while the original signature/full seal still binds code.
    new.adapter_fingerprint = "0".repeat(64); new.resource_gate_sha256 = "9".repeat(64);
    let signed = |candidate: &Candidate| {
        let payload = serde_json::to_vec(candidate).unwrap();
        serde_json::to_vec(&serde_json::json!({"payload":URL_SAFE_NO_PAD.encode(&payload),
            "signature":URL_SAFE_NO_PAD.encode(pair.sign(&payload).as_ref())})).unwrap()
    };
    let envelope = signed(&new);
    fs::write(scratch.join("candidate.json"), &envelope).unwrap();
    let mut wrong_signature: serde_json::Value = serde_json::from_slice(&envelope).unwrap();
    wrong_signature["signature"] = serde_json::json!(URL_SAFE_NO_PAD.encode([0u8;64]));
    fs::write(scratch.join("bad-signature.json"), serde_json::to_vec(&wrong_signature).unwrap()).unwrap();
    let certificate = reqwest::Certificate::from_pem(&fs::read(scratch.join("tls-cert.pem")).unwrap()).unwrap();
    let client = reqwest::blocking::Client::builder().add_root_certificate(certificate.clone())
        .redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(10)).build().unwrap();
    let artifact_client = reqwest::Client::builder().add_root_certificate(certificate)
        .redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(10)).build().unwrap();
    let host = crate::dsh_host::tests::bundled_service_for_settings_integration(old_baseline.clone(), &app_data);
    assert_eq!(host.engine_update_context().unwrap().1, "0.1.7-rc.2");
    assert!(host.probe(DshHostAction::Probe).unwrap().latest_probe_passed);
    host.open_native_surface().unwrap();
    assert_eq!(host.plugin_compat_check(false).unwrap()["checked"], true);
    host.close_native_surface().unwrap();
    let logs = session_logs(&app_data); assert!(!logs.is_empty());
    fs::write(scratch.join("old-session-log-hashes.json"), serde_json::to_vec(&logs).unwrap()).unwrap();
    let draft = app_data.join("deepseek-harness/native-state/rc8-v1/unsent-draft-proof.txt");
    fs::write(&draft, b"old synthetic draft never send").unwrap();
    let updater = DshEngineUpdater::new(host.clone(), app_data.clone()).with_fixture_authority(TrustedSource {
        feed_url: feed.clone(), public_key: pair.public_key().as_ref().try_into().unwrap(), trust_class: "development"
    }, client, artifact_client);
    for (mode, phase) in [("missing", "no_candidate"), ("network", "check_failed"), ("bad-signature", "untrusted")] {
        fs::write(scratch.join("mode.txt"), mode).unwrap();
        let status = updater.check(); assert_eq!(status.phase, phase); assert!(!status.can_install);
        println!("SEMANTIC_SETTINGS_REFUSED mode={mode} phase={phase}");
    }
    fs::write(scratch.join("mode.txt"), "good").unwrap();
    for (kind, phase) in [("interface", "requires_host"), ("from", "upgrade_path"), ("legacy", "legacy_contract")] {
        let mut candidate = new.clone();
        match kind {
            "interface" => candidate.compatibility.as_mut().unwrap().adapter_protocol = 2,
            "from" => candidate.from_versions = vec!["0.1.5-rc.2".into()],
            _ => { candidate.schema = 1; candidate.compatibility = None; }
        }
        fs::write(scratch.join("candidate.json"), signed(&candidate)).unwrap();
        let status = updater.check(); assert_eq!(status.phase, phase); assert!(!status.can_install);
        println!("SEMANTIC_SETTINGS_REFUSED kind={kind} phase={phase}");
    }
    fs::write(scratch.join("candidate.json"), &envelope).unwrap();
    assert!(updater.check().can_install);
    fs::write(scratch.join("mode.txt"), "bad-artifact").unwrap();
    assert_eq!(updater.install().phase, "prepare_failed");
    let (store, _, _) = host.engine_update_context().unwrap(); assert!(!store.pending_switch());
    assert_session_logs_preserved(&app_data, &logs);
    println!("SEMANTIC_SETTINGS_ARTIFACT_TAMPER_REFUSED activeUnchanged=true pendingAbsent=true");
    // Reuse the already qualified official20 artifact through the updater's
    // existing cached-stage path. Every byte is rechecked against this newly
    // authenticated candidate; assembly/download matrix is not repeated.
    super::super::verify_runtime_closure(&new, &new_baseline).unwrap();
    let cached = store.version_path(&new.artifact_sha256).unwrap();
    copy_verified_fixture(&new_baseline, &cached);
    fs::write(scratch.join("mode.txt"), "good").unwrap();
    let checked = updater.check(); assert_eq!(checked.phase, "available"); assert!(checked.can_install);
    assert_eq!(checked.candidate_version.as_deref(), Some("0.2.0-rc.2"));
    fs::write(scratch.join("settings-check-result.json"), serde_json::to_vec(&checked).unwrap()).unwrap();
    let installed = updater.install(); assert_eq!(installed.phase, "restart_required");
    fs::write(scratch.join("settings-install-result.json"), serde_json::to_vec(&installed).unwrap()).unwrap();
    assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
    assert!(host.shutdown()); drop(updater); drop(host);
    store.arm_after_confirmed_shutdown().unwrap();
    assert!(store.complete_pending_switch_with(&app_data, "0.1.7-rc.2", |bytes, from, now| {
        super::super::admit_with_contract(bytes, Some(pair.public_key().as_ref()), Some(&feed), from,
            env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"), now)
            .map(|candidate| AdmittedCandidate { candidate, signed_envelope: bytes.to_vec() })
    }).unwrap());
    assert_session_logs_preserved(&app_data, &logs); drop(store);
    writeln!(server.stdin.as_mut().unwrap(), "close").unwrap(); assert!(server.wait().unwrap().success());
    let mut child = Command::new(std::env::current_exe().unwrap());
    child.args(["--ignored", "--exact", CHILD, "--nocapture", "--test-threads=1"])
        .env("DSH_QUALIFIED_PROOF_REOPEN", &scratch).creation_flags(0x08000000);
    assert!(child.status().unwrap().success());
    let reopened = UpdateStore::open(&app_data).unwrap();
    let active = reopened.load_active_with_verifier(|bytes| super::super::verify_installed_with_contract(bytes,
        pair.public_key().as_ref(), &feed, env!("CARGO_PKG_VERSION"), "0.1.7-rc.2",
        env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"), env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"))).unwrap().unwrap();
    assert_eq!(active.candidate.schema, 2); assert!(!active.pending_health); assert!(!reopened.pending_switch());
    println!("SEMANTIC_SETTINGS_SWITCH_OK schema=2 old=0.1.7-rc.2 new=0.2.0-rc.2 freshProcess=true healthCommitted=true");
}
