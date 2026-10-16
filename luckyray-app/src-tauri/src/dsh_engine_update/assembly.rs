//! Frozen official inputs are only another input adapter to UpdateStore. They
//! cannot arm an active pointer, change a profile, authorize latest or supply
//! executable hooks. Worker/tool/policy bytes are fixed; schema 2 version
//! qualification is separately bound by the admitted signed descriptor.
use super::{AdmittedCandidate, AdmissionError, ArtifactError, Candidate};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenAssemblyIdentity {
    pub(crate) schema: u8,
    pub(crate) kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) toolset: Option<String>,
}

pub(super) fn validate_candidate_input(candidate: &Candidate) -> Result<(), AdmissionError> {
    let input = candidate.assembly.as_ref().ok_or(AdmissionError::InvalidManifest)?;
    if candidate.upstream.is_some() || candidate.artifact_bytes > 2 * 1024 * 1024
        { return Err(AdmissionError::InvalidManifest); }
    match input.schema {
        1 if input.kind == "official-npm-frozen-win-x64-v1" && input.toolset.is_none() => {
            // Previously signed installed descriptors remain reopenable.
            if candidate.node_sha256 != NODE_SHA || candidate.version != "0.1.7-rc.2" || candidate.closure_file_count != 25_659
                || candidate.entry_sha256 != ENTRY_SHA { return Err(AdmissionError::InvalidManifest); }
        },
        2 if input.kind == "official-npm-qualified-win-x64-v2" => {
            if input.toolset.as_deref() != Some("node22.19.0-pnpm11.7.0-policy1") || candidate.node_sha256 != NODE_SHA
                { return Err(AdmissionError::RequiresHost); }
            // No version/entry/count baseline here. Native signature/contract
            // gates plus bounded qualification and the complete closure apply.
        },
        _ => return Err(AdmissionError::RequiresHost),
    }
    Ok(())
}

const NODE_SHA: &str = "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362";
const ENTRY_SHA: &str = "935e95d05f4dc70a8a013eea59da80028946b5c139e45c6351dcaf2810ca00a1";
const NODE_URL: &str = "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip";
const NODE_ARCHIVE_SHA: &str = "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86";
const NODE_BYTES: u64 = 35_424_607;
const LICENSE_SHA: &str = "339c50294da6a84322dcbe7285b57b248123bd4d9e37a2f72d68d5abf2574783";
const PNPM_URL: &str = "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz";
const PNPM_SHA: &str = "deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee";
const PNPM_BYTES: u64 = 4_590_455;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    name: String,
    version: String,
    url: String,
    bytes: u64,
    sha256: String,
}

fn validate_input(input: &Input) -> Result<(), ArtifactError> {
    let name = &input.name;
    let parts: Vec<_> = name.split('/').collect();
    if name.len() > 214 || input.version.len() > 128 || input.bytes == 0 || input.bytes > 256 * 1024 * 1024
        || !(parts.len() == 1 || parts.len() == 2 && parts[0].starts_with('@'))
        || parts.iter().any(|part| {
            let part = part.strip_prefix('@').unwrap_or(part);
            part.is_empty() || !part.as_bytes()[0].is_ascii_alphanumeric()
                || !part.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        })
        || semver::Version::parse(&input.version).is_err()
        || !input.version.bytes().all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        || !super::hex64(&input.sha256) || input.sha256 != input.sha256.to_ascii_lowercase()
        || input.url != format!("https://registry.npmjs.org/{name}/-/{}-{}.tgz", parts.last().unwrap(), input.version)
    { return Err(ArtifactError::Invalid); }
    Ok(())
}

#[cfg(not(all(windows, feature = "browser-host-runtime")))]
pub(super) fn prepare(_: &AdmittedCandidate, _: &Path, _: &Path, _: &AtomicBool,
    _: &mut dyn FnMut(&'static str, u64, u64)) -> Result<(), ArtifactError> { Err(ArtifactError::Invalid) }

#[cfg(all(windows, feature = "browser-host-runtime"))]
pub(super) fn prepare(admitted: &AdmittedCandidate, description: &Path, stage: &Path, cancel: &AtomicBool,
    progress: &mut dyn FnMut(&'static str, u64, u64)) -> Result<(), ArtifactError> {
    implementation::prepare(admitted, description, stage, cancel, progress)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
mod implementation {
    use super::*;
    use std::collections::HashSet;
    use std::ffi::OsString;
    use std::fs::{self, File, OpenOptions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use crate::dsh_runtime_seal::{acquire_stable_file, StableFileLease};

    // No development repository or preinstalled tools at runtime. These
    // compiled bytes are held against write/delete throughout worker use.
    const BUNDLE: &[(&str, &[u8])] = &[
        ("dsh-frozen-assembly-worker.mjs", include_bytes!("../../../scripts/dsh-frozen-assembly-worker.mjs")),
        ("dsh-supply-chain.mjs", include_bytes!("../../../scripts/dsh-supply-chain.mjs")),
        ("dsh-frozen-assembly-description.mjs", include_bytes!("../../../scripts/dsh-frozen-assembly-description.mjs")),
        ("dsh-frozen-inputs.mjs", include_bytes!("../../../scripts/dsh-frozen-inputs.mjs")),
        ("dsh-npm-tar-policy.mjs", include_bytes!("../../../scripts/dsh-npm-tar-policy.mjs")),
        ("dsh-frozen-cache-relay.mjs", include_bytes!("../../../scripts/dsh-frozen-cache-relay.mjs")),
        ("dsh-assembly-network-fence.mjs", include_bytes!("../../../scripts/dsh-assembly-network-fence.mjs")),
        ("runtime-authority.json", include_bytes!("../../../dsh-host/runtime-authority.json")),
        ("host/package.json", include_bytes!("../../../dsh-host/package.json")),
        ("host/.npmrc", include_bytes!("../../../dsh-host/.npmrc")),
        ("host/pnpm-lock.yaml", include_bytes!("../../../dsh-host/pnpm-lock.yaml")),
        ("host/pnpm-workspace.yaml", include_bytes!("../../../dsh-host/pnpm-workspace.yaml")),
        ("records/dependency-audit.json", include_bytes!("../../../dsh-host/records/dependency-audit.json")),
        ("records/sbom.cdx.json", include_bytes!("../../../dsh-host/records/sbom.cdx.json")),
        ("records/launch-manifest.json", include_bytes!("../../../dsh-host/records/launch-manifest.json")),
        ("records/runtime-manifest.json", include_bytes!("../../../dsh-host/records/runtime-manifest.json")),
        ("records/THIRD-PARTY-NOTICES.txt", include_bytes!("../../../dsh-host/records/THIRD-PARTY-NOTICES.txt")),
    ];

    fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
        let mut file = OpenOptions::new().create_new(true).write(true).open(path).map_err(|_| ArtifactError::Io)?;
        file.write_all(bytes).map_err(|_| ArtifactError::Io)?;
        file.sync_all().map_err(|_| ArtifactError::Io)
    }

    fn hold(path: &Path) -> Result<StableFileLease, ArtifactError> {
        acquire_stable_file(path).map_err(|_| ArtifactError::Invalid)
    }

    fn revalidate(leases: &[StableFileLease], cancel: &AtomicBool) -> Result<(), ArtifactError> {
        for lease in leases {
            if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
            lease.revalidate().map_err(|_| ArtifactError::Invalid)?;
        }
        Ok(())
    }

    fn extract_node(archive: &Path, workspace: &Path, cancel: &AtomicBool) -> Result<(), ArtifactError> {
        // Whole official archive verified first; only exact Node/LICENSE are
        // materialized, never its npm/corepack scripts or a shell installer.
        if super::super::digest_file(archive)? != NODE_ARCHIVE_SHA { return Err(ArtifactError::Invalid); }
        let root = workspace.join("node");
        fs::create_dir(&root).map_err(|_| ArtifactError::Io)?;
        let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|_| ArtifactError::Io)?)
            .map_err(|_| ArtifactError::Invalid)?;
        if zip.len() > 10_000 { return Err(ArtifactError::Invalid); }
        for (name, hash) in [("node.exe", NODE_SHA), ("LICENSE", LICENSE_SHA)] {
            if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
            let entry = zip.by_name(&format!("node-v22.19.0-win-x64/{name}")).map_err(|_| ArtifactError::Invalid)?;
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            if entry.is_dir() || !matches!(kind, 0 | 0o100000) || entry.size() > 100 * 1024 * 1024 { return Err(ArtifactError::Invalid); }
            let mut bytes = Vec::new();
            entry.take(100 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| ArtifactError::Invalid)?;
            use sha2::{Digest, Sha256};
            if bytes.len() > 100 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != hash { return Err(ArtifactError::Invalid); }
            write_new(&root.join(name), &bytes)?;
        }
        Ok(())
    }

    fn run_worker(workspace: &Path, stage: &Path, descriptor_hash: &str, descriptor_bytes: u64, command: &str, cancel: &AtomicBool,
        progress: &mut dyn FnMut(&'static str, u64, u64)) -> Result<serde_json::Value, ArtifactError> {
        let bundle = workspace.join("worker");
        let policy = workspace.join(format!("native-policy-{command}"));
        fs::create_dir(&policy).map_err(|_| ArtifactError::Io)?;
        let mut env: Vec<(OsString, OsString)> = Vec::new();
        for name in ["SystemRoot", "WINDIR", "COMSPEC"] {
            if let Some(value) = std::env::var_os(name) { env.push((name.into(), value)); }
        }
        for name in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PNPM_HOME",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] { env.push((name.into(), policy.as_os_str().to_owned())); }
        env.push(("PATH".into(), workspace.join("node").into_os_string()));
        env.push(("CI".into(), "true".into()));
        // Keep the existing atomic process entry's simple-argument grammar.
        // The fixed worker derives the workspace from its own bundled path;
        // no quoted absolute path, shell expansion or arbitrary argv is added.
        let args = vec!["dsh-frozen-assembly-worker.mjs".into(), command.into(),
            stage.file_name().ok_or(ArtifactError::Invalid)?.to_owned(), descriptor_hash.into(),
            descriptor_bytes.to_string().into()];
        if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
        let owned = crate::owned_process::spawn_in_owned_job(&workspace.join("node/node.exe"), &args, &bundle, env, false)
            .map_err(|_| ArtifactError::Io)?;
        let crate::owned_process::AtomicSpawn { process, stdin, stdout, stderr, job } = owned;
        drop(stdin);
        let (send, receive) = mpsc::sync_channel(8);
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout).take(2 * 1024 * 1024 + 1);
            let mut total = 0usize;
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(count) => { total += count; if total > 2 * 1024 * 1024 {
                        let _ = send.send(Err(ArtifactError::Invalid)); break;
                    } },
                    Err(_) => { let _ = send.send(Err(ArtifactError::Io)); break; },
                }
                if send.send(serde_json::from_slice::<serde_json::Value>(&line).map_err(|_| ArtifactError::Invalid)).is_err() { break; }
            }
        });
        let errors = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.take(64 * 1024 + 1).read_to_end(&mut bytes).map(|_| bytes.is_empty()).unwrap_or(false)
        });
        let deadline = Instant::now() + Duration::from_secs(600);
        let mut result = None;
        let mut failed = false;
        loop {
            match receive.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(row)) if row.get("kind").and_then(|v| v.as_str()) == Some("progress") => {
                    match (row.get("done").and_then(|v| v.as_u64()), row.get("total").and_then(|v| v.as_u64())) {
                        (Some(done), Some(4)) if done <= 4 => progress("assemble", done, 4),
                        _ => { failed = true; break; },
                    }
                },
                Ok(Ok(row)) if row.get("kind").and_then(|v| v.as_str()) == Some("result") && result.is_none() => result = Some(row),
                Ok(Ok(row)) if row.get("kind").and_then(|v| v.as_str()) == Some("failure") => {
                    #[cfg(test)] if let Some(stage) = row.get("stage").and_then(|v| v.as_str()).filter(|stage|
                        matches!(*stage, "descriptor" | "preflight" | "pnpm-extract" | "cache-populate" | "offline-install" | "portable-seal" | "native-probe")) {
                        eprintln!("NATIVE_WORKER_FAILURE_STAGE {stage}");
                    }
                    #[cfg(test)] if let Some(category) = row.get("category").and_then(|v| v.as_str()).filter(|category|
                        matches!(*category, "seal" | "worker" | "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION" | "ERR_PNPM_NO_OFFLINE_TARBALL" | "ERR_PNPM_TARBALL_INTEGRITY" |
                            "ERR_PNPM_PEER_DEP_ISSUES" | "ERR_PNPM_LOCKFILE_BREAKING_CHANGE" | "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE" |
                            "ERR_PNPM_LINKING_FAILED" | "ERR_PNPM_ENAMETOOLONG" | "ERR_PNPM_ENOENT" | "ERR_PNPM_EPERM" | "ERR_PNPM_EACCES" |
                            "ENAMETOOLONG" | "ENOENT" | "EPERM" | "EACCES")) {
                        eprintln!("NATIVE_WORKER_FAILURE_CATEGORY {category}");
                    }
                    failed = true; break;
                },
                Ok(_) => { failed = true; break; },
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {},
            }
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline { failed = true; break; }
        }
        // Termination belongs only to this owned installation worker Job,
        // never to a product/LSH session or the normal application quit path.
        let exited = !failed && process.wait_for(Duration::from_secs(2)) && process.succeeded();
        // Job accounting can trail the process signal briefly. Still require
        // the whole owned child tree to settle before any output is accepted.
        let settle_deadline = Instant::now() + Duration::from_millis(250);
        while exited && !job.settled() && Instant::now() < settle_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !exited || !job.settled() {
            let drained = job.terminate_and_wait(Duration::from_secs(2));
            failed = true;
            if !drained {
                // Preserve the exact workspace/stage if teardown could not
                // be proved. Do not block forever joining inherited pipes.
                drop(receive);
                return Err(ArtifactError::WorkerPending);
            }
        }
        drop(receive);
        let clean_output = reader.join().is_ok() && errors.join().unwrap_or(false);
        if failed || !clean_output || cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
        result.ok_or(ArtifactError::Invalid)
    }

    pub(super) fn prepare(admitted: &AdmittedCandidate, description: &Path, stage: &Path, cancel: &AtomicBool,
        progress: &mut dyn FnMut(&'static str, u64, u64)) -> Result<(), ArtifactError> {
        validate_candidate_input(&admitted.candidate).map_err(|_| ArtifactError::Invalid)?;
        if stage.exists() || !stage.is_absolute() || cancel.load(Ordering::Acquire) { return Err(ArtifactError::Invalid); }
        let description_lease = hold(description)?;
        if super::super::digest_file(description)? != admitted.candidate.artifact_sha256
            || fs::metadata(description).map_err(|_| ArtifactError::Io)?.len() != admitted.candidate.artifact_bytes { return Err(ArtifactError::Invalid); }
        let descriptor_bytes = fs::read(description).map_err(|_| ArtifactError::Io)?;
        let descriptor: serde_json::Value = serde_json::from_slice(&descriptor_bytes).map_err(|_| ArtifactError::Invalid)?;
        let identity = admitted.candidate.assembly.as_ref().ok_or(ArtifactError::Invalid)?;
        if descriptor.get("schema").and_then(|v| v.as_u64()) != Some(identity.schema as u64)
            || descriptor.get("kind").and_then(|v| v.as_str()) != Some(identity.kind.as_str()) { return Err(ArtifactError::Invalid); }
        let parent = stage.parent().ok_or(ArtifactError::Invalid)?;
        if !super::super::safe_runtime_entry(parent)?.is_dir() { return Err(ArtifactError::Invalid); }
        let workspace = parent.join(format!(".assembly-{:032x}", rand::random::<u128>()));
        fs::create_dir(&workspace).map_err(|_| ArtifactError::Io)?;
        let result = (|| {
            write_new(&workspace.join("description.json"), &descriptor_bytes)?;
            let bundle = workspace.join("worker");
            let mut leases = vec![hold(&workspace.join("description.json"))?];
            for (name, bytes) in BUNDLE {
                let path = super::super::artifact_path(&bundle, name)?;
                fs::create_dir_all(path.parent().ok_or(ArtifactError::Invalid)?).map_err(|_| ArtifactError::Io)?;
                write_new(&path, bytes)?; leases.push(hold(&path)?);
            }
            let client = super::super::artifact_client()?;
            let node_archive = workspace.join("node.zip");
            tauri::async_runtime::block_on(super::super::download_exact_async(&client, NODE_URL, NODE_BYTES,
                NODE_ARCHIVE_SHA, false, &node_archive, cancel, &mut |done, total| progress("bootstrap", done, total)))?;
            #[cfg(test)] eprintln!("NATIVE_BOOTSTRAP_DOWNLOAD_VERIFIED");
            leases.push(hold(&node_archive)?);
            extract_node(&node_archive, &workspace, cancel)?;
            #[cfg(test)] eprintln!("NATIVE_BOOTSTRAP_NODE_EXTRACTED");
            leases.push(hold(&workspace.join("node/node.exe"))?);
            leases.push(hold(&workspace.join("node/LICENSE"))?);
            description_lease.revalidate().map_err(|_| ArtifactError::Invalid)?;
            revalidate(&leases, cancel)?;
            #[cfg(test)] eprintln!("NATIVE_BOOTSTRAP_WORKER_INPUTS_HELD");
            let plan = run_worker(&workspace, stage, &admitted.candidate.artifact_sha256, admitted.candidate.artifact_bytes, "plan", cancel, progress)?;
            #[cfg(test)] eprintln!("NATIVE_BOOTSTRAP_WORKER_PLAN_ACCEPTED");
            if plan.get("outcome").and_then(|v| v.as_str()) != Some("FROZEN_INPUT_PLAN") { return Err(ArtifactError::Invalid); }
            let inputs: Vec<Input> = serde_json::from_value(plan.get("packages").cloned().ok_or(ArtifactError::Invalid)?)
                .map_err(|_| ArtifactError::Invalid)?;
            if inputs.is_empty() || inputs.len() > 2048
                || plan.get("version").and_then(|v| v.as_str()) != Some(admitted.candidate.version.as_str())
                || plan.get("nodeSha256").and_then(|v| v.as_str()) != Some(admitted.candidate.node_sha256.as_str())
                || plan.get("closureFileCount").and_then(|v| v.as_u64()) != Some(admitted.candidate.closure_file_count as u64)
                || identity.schema == 2 && plan.get("entrySha256").and_then(|v| v.as_str()) != Some(admitted.candidate.entry_sha256.as_str())
            { return Err(ArtifactError::Invalid); }
            let mut seen = HashSet::new();
            let mut total = PNPM_BYTES;
            for input in &inputs {
                validate_input(input)?;
                if !seen.insert((&input.name, &input.version)) { return Err(ArtifactError::Invalid); }
                total = total.checked_add(input.bytes).filter(|n| *n <= 1024 * 1024 * 1024).ok_or(ArtifactError::Invalid)?;
            }
            let tarballs = workspace.join("tarballs");
            fs::create_dir(&tarballs).map_err(|_| ArtifactError::Io)?;
            let pnpm = workspace.join("pnpm.tgz");
            tauri::async_runtime::block_on(super::super::download_exact_async(&client, PNPM_URL, PNPM_BYTES,
                PNPM_SHA, false, &pnpm, cancel, &mut |done, _| progress("inputs", done, total)))?;
            leases.push(hold(&pnpm)?);
            let mut completed = PNPM_BYTES;
            for input in &inputs {
                let output = tarballs.join(format!("{}.tgz", input.sha256));
                tauri::async_runtime::block_on(super::super::download_exact_async(&client, &input.url, input.bytes,
                    &input.sha256, false, &output, cancel, &mut |done, _| progress("inputs", completed + done, total)))?;
                leases.push(hold(&output)?);
                completed += input.bytes;
            }
            revalidate(&leases, cancel)?;
            let final_row = run_worker(&workspace, stage, &admitted.candidate.artifact_sha256, admitted.candidate.artifact_bytes, "assemble", cancel, progress)?;
            if final_row.get("outcome").and_then(|v| v.as_str()) != Some("ASSEMBLED_FROZEN_RUNTIME")
                || final_row.get("packageCount").and_then(|v| v.as_u64()) != Some(inputs.len() as u64) { return Err(ArtifactError::Invalid); }
            Ok(())
        })();
        drop(description_lease);
        // Exact generated sibling only, after worker Job is drained and all
        // held inputs dropped. Never an active directory/profile/backup.
        if result != Err(ArtifactError::WorkerPending) && workspace.parent() == Some(parent) && super::super::safe_runtime_entry(&workspace).is_ok_and(|m| m.is_dir())
            && workspace.canonicalize().ok().is_some_and(|path| parent.canonicalize().ok().is_some_and(|p| path.parent() == Some(p.as_path()))) {
            let _ = fs::remove_dir_all(&workspace);
        }
        result
    }

    // Engineering diagnostic only, not a production download bypass. Uses
    // explicit previously acquired inputs and the REAL held-input/Job/worker
    // boundary in a new retained synthetic identity. No Candidate activation.
    #[cfg(test)]
    pub(super) fn cached_owned_worker_for_test() -> Result<(), ArtifactError> {
        let root = tempfile::Builder::new().prefix("luckyray-native-cached-worker-").tempdir().unwrap().keep();
        let parent = root.join("dsh-engine-updates/versions");
        fs::create_dir_all(&parent).unwrap();
        let workspace = parent.join(format!(".assembly-{:032x}", rand::random::<u128>()));
        let stage = parent.join(format!(".stage-{:032x}", rand::random::<u128>()));
        fs::create_dir(&workspace).unwrap();
        println!("NATIVE_CACHED_WORKER_RETAINED {}", root.display());
        let description = std::path::PathBuf::from(std::env::var_os("DSH_OFFICIAL_INPUTS_RECORD").unwrap());
        let tar_cache = std::path::PathBuf::from(std::env::var_os("DSH_OFFICIAL_TARBALL_CACHE").unwrap());
        let bootstrap = std::path::PathBuf::from(std::env::var_os("DSH_OFFICIAL_BOOTSTRAP_CACHE").unwrap());
        assert!([&description, &tar_cache, &bootstrap].iter().all(|path| path.is_absolute()));
        let bytes = fs::read(description).unwrap();
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(&bytes));
        write_new(&workspace.join("description.json"), &bytes)?;
        let mut leases = vec![hold(&workspace.join("description.json"))?];
        for (name, bytes) in BUNDLE {
            let path = super::super::artifact_path(&workspace.join("worker"), name)?;
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write_new(&path, bytes)?; leases.push(hold(&path)?);
        }
        fs::create_dir(workspace.join("node")).unwrap();
        for name in ["node.exe", "LICENSE"] {
            fs::copy(bootstrap.join("bootstrap-node/node-v22.19.0-win-x64").join(name), workspace.join("node").join(name)).unwrap();
            leases.push(hold(&workspace.join("node").join(name))?);
        }
        let cancel = AtomicBool::new(false);
        let mut progress = |phase, done, _| println!("NATIVE_CACHED_WORKER_PHASE {phase} {done}");
        let plan = run_worker(&workspace, &stage, &hash, bytes.len() as u64, "plan", &cancel, &mut progress)?;
        let inputs: Vec<Input> = serde_json::from_value(plan["packages"].clone()).map_err(|_| ArtifactError::Invalid)?;
        assert_eq!(inputs.len(), 516);
        fs::create_dir(workspace.join("tarballs")).unwrap();
        fs::copy(bootstrap.join("cache/inputs/pnpm-11.7.0.tgz"), workspace.join("pnpm.tgz")).unwrap();
        leases.push(hold(&workspace.join("pnpm.tgz"))?);
        for input in inputs {
            validate_input(&input)?;
            let name = format!("{}.tgz", input.sha256);
            let target = workspace.join("tarballs").join(&name);
            fs::copy(tar_cache.join(name), &target).unwrap(); leases.push(hold(&target)?);
        }
        revalidate(&leases, &cancel)?;
        let result = run_worker(&workspace, &stage, &hash, bytes.len() as u64, "assemble", &cancel, &mut progress)?;
        assert_eq!(result["outcome"], "ASSEMBLED_FROZEN_RUNTIME");
        let control = crate::dsh_runtime_seal::RuntimeSealControl::new(&cancel);
        crate::dsh_runtime_seal::RuntimeIdentityLease::acquire(&stage, &control).map_err(|_| ArtifactError::Invalid)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    #[test]
    #[ignore = "explicit acquired official cache; real owned worker diagnostic, not native acquisition proof"]
    fn cached_official_inputs_cross_real_held_file_and_job_boundary() {
        implementation::cached_owned_worker_for_test().unwrap();
    }
    #[test]
    fn frozen_inputs_cannot_download_arbitrary_origins_aliases_or_versions() {
        let mut input = Input { name: "@deepseek-ai/dsh".into(), version: "0.1.7-rc.2".into(),
            url: "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz".into(), bytes: 23335, sha256: "a".repeat(64) };
        assert!(validate_input(&input).is_ok());
        for invalid in ["https://third-party.test/runtime.tgz", "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz?token=x",
            "http://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz", "https://registry.npmjs.org:443/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz"] {
            input.url = invalid.into(); assert_eq!(validate_input(&input), Err(ArtifactError::Invalid));
        }
        input.name = "../../command".into(); assert_eq!(validate_input(&input), Err(ArtifactError::Invalid));
    }
}
