#[path = "../../../src-tauri/src/extension_worker.rs"]
mod extension_worker;
fn main() {
    extension_worker::run_stdio();
}

#[path = "../../../src-tauri/src/extension_process.rs"]
mod extension_process;
#[cfg(test)]
mod tests {
    use super::extension_process::Worker;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    fn exe() -> PathBuf {
        PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").expect("fixture exe path"))
    }
    fn finish(worker: &Worker) -> Result<Value, String> {
        let start = Instant::now();
        loop {
            if let Some(v) = worker.poll()? {
                return Ok(v);
            }
            assert!(start.elapsed() < Duration::from_secs(6));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn real_engine_has_no_ambient_host_capabilities() {
        let w=Worker::launch(&exe(),"LuckyRay.register(()=>[typeof process,typeof require,typeof fetch,typeof document,typeof __TAURI_INTERNALS__,typeof Worker,typeof os]);",&json!({}),Duration::from_secs(4)).unwrap();
        let v = finish(&w).unwrap();
        assert_eq!(
            v["result"]["value"],
            json!([
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined"
            ])
        );
    }
    #[test]
    fn real_parent_roundtrip_supports_logic() {
        let mut w = Worker::launch(
            &exe(),
            "LuckyRay.register(async()=> (await LuckyRay.call('data.get')).n + 2);",
            &json!({}),
            Duration::from_secs(4),
        )
        .unwrap();
        assert_eq!(finish(&w).unwrap()["request"]["method"], "data.get");
        w.reply(&json!({"value":{"n":3}})).unwrap();
        assert_eq!(finish(&w).unwrap()["result"]["value"], 5);
    }
    #[test]
    fn parent_kills_infinite_code_and_blocked_rpc() {
        for source in ["while(true){}","LuckyRay.register(()=>LuckyRay.call('never.replied'));","LuckyRay.register(()=>{function again(){Promise.resolve().then(again)}again();return new Promise(()=>{});});"] {let start=Instant::now();let w=Worker::launch(&exe(),source,&json!({}),Duration::from_millis(150)).unwrap();loop{match finish(&w){Ok(v) if v["kind"]=="call"=>continue,_=>break}}drop(w);assert!(start.elapsed()<Duration::from_secs(3));}
    }
    #[test]
    fn memory_and_output_are_bounded() {
        for source in [
            "const a=[];while(true)a.push(new Array(100000).fill('x'));",
            "LuckyRay.register(()=> 'x'.repeat(200000));",
        ] {
            let w = Worker::launch(&exe(), source, &json!({}), Duration::from_secs(4)).unwrap();
            let v = finish(&w);
            assert!(v.is_err() || v.unwrap()["result"]["ok"] == false);
        }
    }
}

#[path = "../../../src-tauri/src/extension_broker.rs"]
mod extension_broker;
#[path = "../../../src-tauri/src/extension_packages_store.rs"]
mod extension_packages_store;
#[cfg(test)]
mod authorization_tests {
    use super::{
        extension_broker::{Broker, Scope},
        extension_packages_store::{self as store, Request},
    };
    use serde_json::json;
    use std::{
        path::PathBuf,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "lr-v1-authority-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn package(id: &str, code: &str) -> store::Package {
        serde_json::from_value(json!({"manifest":{"schemaVersion":1,"apiVersion":1,"id":id,"name":"fixture","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["materials"],"optionalModules":[]},"resource":{"code":code,"requiredPermissions":["materials.read"],"optionalPermissions":[],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"command"}]}})).unwrap()
    }
    fn enable(root: &PathBuf, id: &str, code: &str) {
        let s = store::manage(root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            root,
            "1.9.2",
            Request::Install {
                package: package(id, code),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(store::manage(
            root,
            "1.9.2",
            Request::Enable {
                id: id.into(),
                expected_revision: s.revision
            }
        )
        .is_err());
        let s = store::manage(
            root,
            "1.9.2",
            Request::Grant {
                id: id.into(),
                grants: vec!["materials.read".into()],
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            root,
            "1.9.2",
            Request::Enable {
                id: id.into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
    }
    fn start(b: &mut Broker, root: &PathBuf, id: &str) -> String {
        b.start(
            root,
            "1.9.2",
            &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
            id,
            Scope {
                material_ids: vec!["allowed".into()],
                ..Scope::default()
            },
            json!({"contribution":"run"}),
        )
        .unwrap()
    }
    fn pending(b: &mut Broker, root: &PathBuf, t: &str) {
        for _ in 0..500 {
            let v = b.poll(root, "1.9.2", t).unwrap();
            if v["kind"] == "call" {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("no request");
    }
    #[test]
    fn foreign_objects_and_methods_do_not_reach_domain() {
        let root = root();
        enable(
            &root,
            "test.one",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'foreign'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.one");
        pending(&mut b, &root, &t);
        let result = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| {
                panic!("must not reach domain")
            })
            .unwrap();
        assert_eq!(result["response"]["error"], "plugin-object-denied");
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn revoke_rejects_pending_write_and_reenable_does_not_revive_token() {
        let root = root();
        enable(
            &root,
            "test.one",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.one");
        pending(&mut b, &root, &t);
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Disable {
                id: "test.one".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            &root,
            "1.9.2",
            Request::Enable {
                id: "test.one".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!("retired"))
            .is_err());
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn permission_expansion_disables_and_keeps_data() {
        let root = root();
        enable(&root, "test.one", "LuckyRay.register(()=>null);");
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Data {
                id: "test.one".into(),
                expected_revision: s.revision,
                data: store::PluginData {
                    schema_version: 1,
                    revision: 1,
                    settings: json!({"keep":true}),
                    cache: json!({}),
                },
            },
        )
        .unwrap();
        let mut next = package("test.one", "LuckyRay.register(()=>null);");
        next.manifest.version = "1.1.0".into();
        next.resource["optionalPermissions"] = json!(["materials.tags"]);
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Update {
                package: next,
                expected_revision: s.revision,
            },
        )
        .unwrap();
        assert!(!s.packages[0].enabled);
        assert!(s.packages[0].grants.is_empty());
        assert_eq!(s.packages[0].data.as_ref().unwrap().settings["keep"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn close_does_not_wait_for_blocked_domain_and_final_check_rejects_it() {
        let root = root();
        enable(
            &root,
            "test.slow",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.slow");
        pending(&mut b, &root, &t);
        let handle = b.handle(&t).unwrap();
        let cloned = root.clone();
        let (entered, wait_enter) = std::sync::mpsc::channel();
        let (resume, wait_resume) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            handle.dispatch(&cloned, "1.9.2", None, |s, _| {
                entered.send(()).unwrap();
                wait_resume.recv().unwrap();
                s.require_current(&cloned, "1.9.2")?;
                panic!("retired operation must not commit")
            })
        });
        wait_enter.recv_timeout(Duration::from_secs(2)).unwrap();
        let now = std::time::Instant::now();
        b.close(&t);
        assert!(now.elapsed() < Duration::from_secs(1));
        resume.send(()).unwrap();
        assert!(thread.join().unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selected_document_does_not_grant_create_and_forged_identity_is_rejected() {
        let root = root();
        let mut pkg = package(
            "test.scope",
            "LuckyRay.register(()=>LuckyRay.call('knowledge.create',{title:'No',content:'No'}));",
        );
        pkg.manifest.required_modules = vec!["knowledge".into()];
        pkg.resource["requiredPermissions"] = json!(["knowledge.create"]);
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Install {
                package: pkg,
                expected_revision: 0,
            },
        )
        .unwrap();
        let s = store::manage(
            &root,
            "1.9.2",
            Request::Grant {
                id: "test.scope".into(),
                grants: vec!["knowledge.create".into()],
                expected_revision: s.revision,
            },
        )
        .unwrap();
        store::manage(
            &root,
            "1.9.2",
            Request::Enable {
                id: "test.scope".into(),
                expected_revision: s.revision,
            },
        )
        .unwrap();
        let mut b = Broker::default();
        let t = b
            .start(
                &root,
                "1.9.2",
                &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
                "test.scope",
                Scope {
                    writes: true,
                    knowledge: Some(super::extension_broker::KnowledgeScope {
                        allow_create: false,
                        vault_id: "v".into(),
                        source_epoch: 1,
                        documents: vec!["selected.md".into()],
                        parent_relative_path: None,
                    }),
                    ..Scope::default()
                },
                json!({"contribution":"run"}),
            )
            .unwrap();
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!("no create grant"))
            .unwrap();
        assert_eq!(response["response"]["error"], "plugin-create-not-selected");
        b.close_all();
        enable(
            &root,
            "test.forge",
            "LuckyRay.register(()=>LuckyRay.call('data.get',{pluginId:'test.scope'}));",
        );
        let t = start(&mut b, &root, "test.forge");
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        assert_eq!(response["response"]["error"], "plugin-parameters");
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retired_blocked_work_keeps_its_host_capacity_until_completion() {
        let root = root();
        enable(
            &root,
            "test.cap",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let mut jobs = Vec::new();
        for _ in 0..4 {
            let t = start(&mut b, &root, "test.cap");
            pending(&mut b, &root, &t);
            let h = b.handle(&t).unwrap();
            let r = root.clone();
            let (entered, wait) = std::sync::mpsc::channel();
            let (resume, paused) = std::sync::mpsc::channel();
            let job = std::thread::spawn(move || {
                h.dispatch(&r, "1.9.2", None, |_, _| {
                    entered.send(()).unwrap();
                    paused.recv().unwrap();
                    Ok(json!({}))
                })
            });
            wait.recv_timeout(Duration::from_secs(2)).unwrap();
            b.close(&t);
            jobs.push((resume, job));
        }
        let t = start(&mut b, &root, "test.cap");
        pending(&mut b, &root, &t);
        assert_eq!(
            b.dispatch(&root, "1.9.2", &t, None, |_, _| panic!("capacity bypass"))
                .unwrap_err(),
            "plugin-host-work-limit"
        );
        for (resume, job) in jobs {
            resume.send(()).unwrap();
            assert!(job.join().unwrap().is_err());
        }
        assert!(b
            .dispatch(&root, "1.9.2", &t, None, |_, _| Ok(json!({})))
            .is_ok());
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn already_admitted_write_can_finish_after_retirement_without_retry() {
        let root = root();
        enable(
            &root,
            "test.accept",
            "LuckyRay.register(()=>LuckyRay.call('materials.read',{id:'allowed'}));",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.accept");
        pending(&mut b, &root, &t);
        let h = b.handle(&t).unwrap();
        let r = root.clone();
        let (accepted, wait) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let effect = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mark = effect.clone();
        let job = std::thread::spawn(move || {
            h.dispatch(&r, "1.9.2", None, |s, _| {
                s.require_current(&r, "1.9.2")?;
                accepted.send(()).unwrap();
                paused.recv().unwrap();
                mark.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({}))
            })
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        b.close(&t);
        resume.send(()).unwrap();
        assert!(job.join().unwrap().is_err());
        assert_eq!(effect.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn committed_write_whose_reply_cannot_be_delivered_still_reports_its_receipt() {
        // R2: a write admitted and finished by the domain must not vanish when the
        // lease ends before the worker can be answered. The dispatch result carries
        // the response plus deliveryError instead of hiding the receipt behind Err.
        let root = root();
        let package: store::Package = serde_json::from_value(json!({"manifest":{"schemaVersion":1,"apiVersion":1,"id":"test.deliver","name":"fixture","version":"1.0.0","type":"script","entry":"main.js","minHostVersion":"1.9.2","requiredModules":["materials"],"optionalModules":[]},"resource":{"code":"LuckyRay.register(()=>LuckyRay.call('materials.tags',{id:'allowed',revision:'r1',tags:['x']}));","requiredPermissions":["materials.read","materials.tags"],"optionalPermissions":[],"dataVersion":1,"contributions":[{"id":"run","label":"Run","kind":"command"}]}})).unwrap();
        let s = store::manage(&root, "1.9.2", Request::List).unwrap();
        let s = store::manage(&root, "1.9.2", Request::Install { package, expected_revision: s.revision }).unwrap();
        let s = store::manage(&root, "1.9.2", Request::Grant { id: "test.deliver".into(), grants: vec!["materials.read".into(), "materials.tags".into()], expected_revision: s.revision }).unwrap();
        store::manage(&root, "1.9.2", Request::Enable { id: "test.deliver".into(), expected_revision: s.revision }).unwrap();
        let mut b = Broker::default();
        let t = b
            .start(
                &root,
                "1.9.2",
                &PathBuf::from(std::env::var("LUCKYRAY_V1_WORKER").unwrap()),
                "test.deliver",
                Scope { material_ids: vec!["allowed".into()], writes: true, ..Scope::default() },
                json!({"contribution":"run"}),
            )
            .unwrap();
        pending(&mut b, &root, &t);
        let h = b.handle(&t).unwrap();
        let r = root.clone();
        let (accepted, wait) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let effect = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mark = effect.clone();
        let job = std::thread::spawn(move || {
            h.dispatch(&r, "1.9.2", None, |s, _| {
                s.require_current(&r, "1.9.2")?;
                accepted.send(()).unwrap();
                paused.recv().unwrap();
                mark.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({"id":"allowed","name":"allowed.png","tagIds":["x"],"revision":"r2"}))
            })
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        b.close(&t);
        resume.send(()).unwrap();
        let delivered = job.join().unwrap().expect("committed write must report its receipt");
        assert_eq!(delivered["method"], "materials.tags");
        assert_eq!(delivered["deliveryError"], "plugin-retired");
        assert_eq!(delivered["response"]["value"]["revision"], "r2");
        assert_eq!(effect.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn owned_data_does_not_cross_plugin_namespaces() {
        let root = root();
        enable(&root,"test.owner","LuckyRay.register(()=>LuckyRay.call('data.set',{schemaVersion:1,revision:1,settings:{secret:'owner'},cache:{}}));");
        enable(
            &root,
            "test.other",
            "LuckyRay.register(()=>LuckyRay.call('data.get')); ",
        );
        let mut b = Broker::default();
        let t = start(&mut b, &root, "test.owner");
        pending(&mut b, &root, &t);
        b.dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        b.close(&t);
        let t = start(&mut b, &root, "test.other");
        pending(&mut b, &root, &t);
        let response = b
            .dispatch(&root, "1.9.2", &t, None, |_, _| panic!())
            .unwrap();
        assert_eq!(response["response"]["value"]["settings"], json!({}));
        assert_eq!(response["response"]["value"]["revision"], 0);
        b.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
}
