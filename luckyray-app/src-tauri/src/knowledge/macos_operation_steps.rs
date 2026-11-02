//! Four immutable attachment-step records, bound to the sealed admission.
//! An incomplete phase is intentionally not retried or inferred from content.
use super::macos_attachment_io::Checkpoint;
use super::macos_operation_store::Store;
use super::macos_step_policy::{Done, Progress};
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    version: u32,
    id: String,
    index: usize,
    path: String,
    plan: String,
    phase: String,
    object: Option<Checkpoint>,
    prior: String,
    seal: String,
}
pub(super) struct Scope<'a> {
    pub(super) id: &'a str,
    pub(super) index: usize,
    pub(super) path: &'a str,
    pub(super) plan: &'a str,
    pub(super) plan_seal: &'a str,
    pub(super) initial: &'a Option<Checkpoint>,
    pub(super) before_revision: Option<&'a str>,
    pub(super) after_revision: Option<&'a str>,
    pub(super) keep_copy: bool,
}
pub(super) struct Step {
    pub(super) progress: Progress<Checkpoint>,
    forward_intent: Option<Evidence>,
    forward_done: Option<Evidence>,
    rollback_intent: Option<Evidence>,
    rollback_done: Option<Evidence>,
}
fn conflict() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "operation-step-identity-conflict",
    )
}
fn name(scope: &Scope<'_>, phase: &str) -> String {
    format!("{}.s{:04}.{phase}.json", scope.id, scope.index)
}
fn unsigned(record: &Evidence) -> io::Result<Vec<u8>> {
    let mut value = record.clone();
    value.seal.clear();
    serde_json::to_vec(&value).map_err(|_| conflict())
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |result, (a, b)| result | (a ^ b))
            == 0
}
fn read(
    store: &Store,
    scope: &Scope<'_>,
    phase: &str,
    sign: &impl Fn(&[u8]) -> io::Result<String>,
) -> io::Result<Option<Evidence>> {
    let Some(bytes) = store.read_optional(&name(scope, phase))? else {
        return Ok(None);
    };
    let record: Evidence = serde_json::from_slice(&bytes).map_err(|_| conflict())?;
    if record.version != 1
        || record.id != scope.id
        || record.index != scope.index
        || record.path != scope.path
        || record.plan != scope.plan
        || record.phase != phase
        || !super::macos_record_policy::hash64(&record.seal)
        || !equal(&sign(&unsigned(&record)?)?, &record.seal)
    {
        return Err(conflict());
    }
    Ok(Some(record))
}
pub(super) fn load(
    store: &Store,
    scope: &Scope<'_>,
    sign: &impl Fn(&[u8]) -> io::Result<String>,
) -> io::Result<Step> {
    let fi = read(store, scope, "fi", sign)?;
    let fd = read(store, scope, "fd", sign)?;
    let ri = read(store, scope, "ri", sign)?;
    let rd = read(store, scope, "rd", sign)?;
    if fi
        .as_ref()
        .is_some_and(|record| record.prior != scope.plan_seal || &record.object != scope.initial)
    {
        return Err(conflict());
    }
    if let Some(done) = &fd {
        let intent = fi.as_ref().ok_or_else(conflict)?;
        if done.prior != intent.seal
            || done.object.as_ref().map(|v| v.object.hash.as_str()) != scope.after_revision
        {
            return Err(conflict());
        }
    }
    if let Some(intent) = &ri {
        let (prior, object) = fd
            .as_ref()
            .map(|v| (v.seal.as_str(), &v.object))
            .unwrap_or((scope.plan_seal, scope.initial));
        if intent.prior != prior || &intent.object != object || (fi.is_some() && fd.is_none()) {
            return Err(conflict());
        }
    }
    if let Some(done) = &rd {
        let intent = ri.as_ref().ok_or_else(conflict)?;
        if done.prior != intent.seal {
            return Err(conflict());
        }
        if fd.is_none() {
            if &done.object != scope.initial {
                return Err(conflict());
            }
        } else if scope.keep_copy {
            if done.object != fd.as_ref().ok_or_else(conflict)?.object {
                return Err(conflict());
            }
        } else {
            if done.object.as_ref().map(|v| v.object.hash.as_str()) != scope.before_revision {
                return Err(conflict());
            }
            // Undoing a removal restores the actual original inode.
            if scope.after_revision.is_none()
                && done.object.as_ref().map(|v| &v.object)
                    != scope.initial.as_ref().map(|v| &v.object)
            {
                return Err(conflict());
            }
        }
    }
    Ok(Step {
        progress: Progress {
            forward_intent: fi.is_some(),
            forward_done: fd.as_ref().map(|r| Done {
                object: r.object.clone(),
            }),
            rollback_intent: ri.is_some(),
            rollback_done: rd.as_ref().map(|r| Done {
                object: r.object.clone(),
            }),
        },
        forward_intent: fi,
        forward_done: fd,
        rollback_intent: ri,
        rollback_done: rd,
    })
}
fn append(
    store: &Store,
    scope: &Scope<'_>,
    phase: &str,
    object: Option<Checkpoint>,
    prior: &str,
    sign: &impl Fn(&[u8]) -> io::Result<String>,
) -> io::Result<Evidence> {
    let mut record = Evidence {
        version: 1,
        id: scope.id.into(),
        index: scope.index,
        path: scope.path.into(),
        plan: scope.plan.into(),
        phase: phase.into(),
        object,
        prior: prior.into(),
        seal: String::new(),
    };
    record.seal = sign(&unsigned(&record)?)?;
    let bytes = serde_json::to_vec(&record).map_err(|_| conflict())?;
    store.write(&name(scope, phase), &bytes)?;
    if store.read(&name(scope, phase))? != bytes {
        return Err(conflict());
    }
    Ok(record)
}
pub(super) fn begin(
    store: &Store,
    scope: &Scope<'_>,
    step: &Step,
    rollback: bool,
    sign: &impl Fn(&[u8]) -> io::Result<String>,
) -> io::Result<()> {
    if step.progress.unknown() {
        return Err(conflict());
    }
    let (phase, object, prior) = if rollback {
        if step.rollback_intent.is_some() || step.rollback_done.is_some() {
            return Err(conflict());
        }
        (
            "ri",
            step.forward_done
                .as_ref()
                .map(|r| r.object.clone())
                .unwrap_or_else(|| scope.initial.clone()),
            step.forward_done
                .as_ref()
                .map(|r| r.seal.as_str())
                .unwrap_or(scope.plan_seal),
        )
    } else {
        if step.forward_intent.is_some()
            || step.forward_done.is_some()
            || step.rollback_intent.is_some()
        {
            return Err(conflict());
        }
        ("fi", scope.initial.clone(), scope.plan_seal)
    };
    append(store, scope, phase, object, prior, sign).map(|_| ())
}
pub(super) fn finish(
    store: &Store,
    scope: &Scope<'_>,
    rollback: bool,
    object: Option<Checkpoint>,
    sign: &impl Fn(&[u8]) -> io::Result<String>,
) -> io::Result<Step> {
    let intent =
        read(store, scope, if rollback { "ri" } else { "fi" }, sign)?.ok_or_else(conflict)?;
    append(
        store,
        scope,
        if rollback { "rd" } else { "fd" },
        object,
        &intent.seal,
        sign,
    )?;
    let step = load(store, scope, sign)?;
    if step.progress.unknown() {
        return Err(conflict());
    }
    Ok(step)
}
