//! Synthetic Windows intake checks. These never open a user profile or accept a PID.
use super::*;
use crate::extension_packages_store::{Installed, Package, Request};

fn package(version: &str) -> Package {
    serde_json::from_value(json!({"manifest":{"schemaVersion":2,"apiVersion":2,"type":"desktop",
        "entry":"main.js","id":"test.api2-intake","name":"Synthetic intake","version":version,
        "minHostVersion":"1.9.8","requiredModules":["workspace"],"optionalModules":[]},
        "resource":{"code":"export function activate(api) {}","css":"","assets":{},"dataVersion":1,"contributions":[]}})).unwrap()
}

fn lease(entry: &Installed) -> Arc<Lease> {
    Arc::new(Lease {
        id: entry.package.manifest.id.clone(),
        digest: entry.digest.clone(),
        epoch: entry.epoch,
        live: AtomicBool::new(true),
        requests: Mutex::new(HashMap::new()),
        cancelled: Mutex::new(VecDeque::new()),
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        processes: Mutex::new(HashMap::new()),
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        terminals: Mutex::new(TerminalCache::default()),
    })
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn terminal_cache_keeps_latest_observed_finish_even_if_polled_out_of_order() {
    let mut cache = TerminalCache::default();
    // Names deliberately run opposite to completion order.
    for time in 1..=129u64 {
        cache.insert(format!("{:04}", 200 - time), time, json!({"exitCode":time}));
    }
    assert_eq!(cache.entries.len(), 128);
    assert!(cache.get("0199").is_none()); // earliest exit
    assert_eq!(cache.get("0071").unwrap()["exitCode"], 129);
    // A late poll of an older process must not evict a newer completion.
    cache.insert("late-old".into(), 0, json!({"exitCode":0}));
    assert!(cache.get("late-old").is_none());
    assert!(cache.get("0198").is_some());
    // Duplicate terminal polls must not refresh its place or consume a slot.
    cache.insert("0198".into(), 1000, json!({"exitCode":1000}));
    assert_eq!(cache.get("0198").unwrap()["exitCode"], 2);
    cache.insert("newest".into(), 130, json!({"exitCode":130}));
    assert!(cache.get("0198").is_none());
    assert!(cache.get("newest").is_some());
    assert_eq!(cache.entries.len(), 128);
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn inherited_windows_pseudo_entries_do_not_block_spawn() {
    use std::ffi::OsString;
    let root = tempfile::tempdir().unwrap();
    let mut inherited: Vec<_> = std::env::vars_os().collect();
    inherited.extend([
        (OsString::from("=Q:"), OsString::from("synthetic-drive-directory")),
        (OsString::new(), OsString::from("synthetic-empty-key")),
        (OsString::from("SYNTHETIC_VALID"), OsString::from("one=two")),
    ]);
    let environment = inherited_process_environment(inherited);
    assert!(!environment.contains_key(&OsString::from("=Q:")));
    assert!(!environment.contains_key(&OsString::new()));
    assert_eq!(environment.get(&OsString::from("SYNTHETIC_VALID")), Some(&OsString::from("one=two")));
    let spawn = crate::owned_process::spawn_in_owned_job_with_argv_detailed(
        &std::env::current_exe().unwrap(), &[OsString::from("--list")], root.path(),
        environment.into_iter().collect(), false,
    ).expect("sanitized inherited environment should allow starting a child");
    assert!(spawn.job.terminate_and_wait(Duration::from_secs(5)));
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn spawn_diagnostic_identifies_invalid_environment_without_disclosing_values() {
    let root = tempfile::tempdir().unwrap();
    let state = enabled(root.path());
    let lease = lease(&state.packages[0]);
    let error = process_operation(&lease, "spawn", &json!({
        "executable": std::env::current_exe().unwrap(), "cwd": root.path(), "args": [],
        "env": {"SYNTHETIC=BAD": "synthetic-secret-not-logged"}
    })).unwrap_err();
    assert_eq!(error, "desktop-extension-spawn:environment");
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn terminal_cache_uses_observed_complete_job_order_when_polled_backwards() {
    let root = tempfile::tempdir().unwrap();
    let state = enabled(root.path());
    let lease = lease(&state.packages[0]);
    let executable = root.path().join("synthetic-cache-child.exe");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/desktop-api2-process-child.rs");
    assert!(std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg("--edition=2021").arg(source).arg("-o").arg(&executable).status().unwrap().success());
    let spawn_and_finish = || {
        let handle = process_operation(&lease,"spawn",&json!({"executable":executable,"cwd":root.path(),"args":[]}))
            .unwrap().as_str().unwrap().to_string();
        process_operation(&lease,"closeInput",&json!({"handle":handle})).unwrap();
        let process = lease.processes.lock().unwrap().get(&handle).cloned().unwrap();
        assert!(process.lock().unwrap().process.wait_for(Duration::from_secs(5)));
        handle
    };
    let first = spawn_and_finish();
    let deadline=std::time::Instant::now()+Duration::from_secs(5);
    loop {if lease.processes.lock().unwrap().get(&first).unwrap().lock().unwrap().observed_finish.is_some(){break;}
        assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10));}
    let second = spawn_and_finish();
    loop {if lease.processes.lock().unwrap().get(&second).unwrap().lock().unwrap().observed_finish.is_some(){break;}
        assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10));}
    let exit_time = |handle:&str| lease.processes.lock().unwrap().get(handle).unwrap().lock().unwrap().process.exit_time().unwrap();
    assert!(exit_time(&first) < exit_time(&second));
    for handle in [&second,&first] {
        let deadline=std::time::Instant::now()+Duration::from_secs(5);
        loop {
            let result=process_operation(&lease,"poll",&json!({"handle":handle})).unwrap();
            if result["settled"]==true {break;}
            assert!(std::time::Instant::now()<deadline,"synthetic child did not settle");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let cache=lease.terminals.lock().unwrap();
    let order:Vec<_>=cache.entries.iter().map(|(handle,_,_)|handle.as_str()).collect();
    assert_eq!(order,vec![first.as_str(),second.as_str()]);
}

fn enabled(root: &Path) -> State {
    let mut state = store::manage(
        root,
        env!("CARGO_PKG_VERSION"),
        Request::Install {
            package: package("1.0.0"),
            publisher_approved: false,
            expected_revision: 0,
        },
    )
    .unwrap();
    state = store::manage(
        root,
        env!("CARGO_PKG_VERSION"),
        Request::Grant {
            id: "test.api2-intake".into(),
            grants: vec!["desktop.fullTrust".into()],
            expected_revision: state.revision,
        },
    )
    .unwrap();
    store::manage(
        root,
        env!("CARGO_PKG_VERSION"),
        Request::Enable {
            id: "test.api2-intake".into(),
            expected_revision: state.revision,
        },
    )
    .unwrap()
}

#[test]
fn disable_update_and_reset_retire_old_native_leases() {
    close_all();
    let root = tempfile::tempdir().unwrap();
    let mut state = enabled(root.path());
    let first = lease(&state.packages[0]);
    leases()
        .lock()
        .unwrap()
        .insert("fixture-first".into(), first.clone());
    assert!(authorized(root.path(), "fixture-first").is_ok());
    state = store::manage(
        root.path(),
        env!("CARGO_PKG_VERSION"),
        Request::Disable {
            id: "test.api2-intake".into(),
            expected_revision: state.revision,
        },
    )
    .unwrap();
    retain_current(&state);
    assert!(!first.live.load(Ordering::Acquire));
    assert!(matches!(authorized(root.path(), "fixture-first"), Err(_)));

    state = store::manage(
        root.path(),
        env!("CARGO_PKG_VERSION"),
        Request::Enable {
            id: "test.api2-intake".into(),
            expected_revision: state.revision,
        },
    )
    .unwrap();
    let second = lease(&state.packages[0]);
    leases()
        .lock()
        .unwrap()
        .insert("fixture-second".into(), second.clone());
    state = store::manage(
        root.path(),
        env!("CARGO_PKG_VERSION"),
        Request::Update {
            package: package("1.0.1"),
            publisher_approved: true,
            expected_revision: state.revision,
        },
    )
    .unwrap();
    retain_current(&state);
    assert!(!second.live.load(Ordering::Acquire));
    assert!(matches!(authorized(root.path(), "fixture-second"), Err(_)));
    assert!(!state.packages[0].enabled && state.packages[0].grants.is_empty());

    state = store::manage(
        root.path(),
        env!("CARGO_PKG_VERSION"),
        Request::Grant {
            id: "test.api2-intake".into(),
            grants: vec!["desktop.fullTrust".into()],
            expected_revision: state.revision,
        },
    )
    .unwrap();
    state = store::manage(
        root.path(),
        env!("CARGO_PKG_VERSION"),
        Request::Enable {
            id: "test.api2-intake".into(),
            expected_revision: state.revision,
        },
    )
    .unwrap();
    let third = lease(&state.packages[0]);
    leases()
        .lock()
        .unwrap()
        .insert("fixture-third".into(), third.clone());
    close_all();
    assert!(!third.live.load(Ordering::Acquire));
    assert!(matches!(authorized(root.path(), "fixture-third"), Err(_)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retirement_cancels_real_loopback_http_request() {
    let root = tempfile::tempdir().unwrap();
    let state = enabled(root.path());
    let lease = lease(&state.packages[0]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (_socket, _) = listener.accept().unwrap();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(6));
    });
    let running = tokio::spawn(http_request(
        lease.clone(),
        json!({"requestId":"synthetic-http",
        "url":format!("http://{address}/waiting"),"method":"GET","timeoutMs":5000}),
    ));
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("request reached loopback");
    lease.retire();
    let result = tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .unwrap()
        .unwrap();
    release_tx.send(()).unwrap();
    server.join().unwrap();
    assert_eq!(result.unwrap_err(), "desktop-extension-cancelled");
    assert!(lease.requests.lock().unwrap().is_empty());
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn real_owned_jobs_report_stdio_exit_and_reclaim_more_than_sixteen_slots() {
    let root = tempfile::tempdir().unwrap();
    let state = enabled(root.path());
    let lease = lease(&state.packages[0]);
    let exe = root.path().join("synthetic-api2-child.exe");
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/desktop-api2-process-child.rs");
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let status = std::process::Command::new(compiler)
        .arg("--edition=2021")
        .arg(source)
        .arg("-o")
        .arg(&exe)
        .status()
        .unwrap();
    assert!(status.success(), "synthetic child compilation failed");
    let args = ["", "has space", "a\"b", "中文", "C:\\folder\\"];
    let spawn = || {
        process_operation(
            &lease,
            "spawn",
            &json!({"executable":exe,"cwd":root.path(),"args":args}),
        )
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
    };
    for _ in 0..17 {
        let handle = spawn();
        process_operation(
            &lease,
            "stdin",
            &json!({"handle":handle,"base64":B64.encode("fixture-input")}),
        )
        .unwrap();
        process_operation(&lease, "closeInput", &json!({"handle":handle})).unwrap();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let result = process_operation(&lease, "poll", &json!({"handle":handle})).unwrap();
            for event in result["events"].as_array().unwrap() {
                let bytes = B64.decode(event["base64"].as_str().unwrap()).unwrap();
                if event["stream"] == "stdout" {
                    stdout.extend(bytes);
                } else {
                    stderr.extend(bytes);
                }
            }
            if result["settled"] == true {
                assert_eq!(result["exitCode"], 7);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned synthetic child did not settle"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(String::from_utf8_lossy(&stdout).contains("synthetic-stdout:fixture-input"));
        assert!(String::from_utf8_lossy(&stdout).contains(&format!("synthetic-argv:{args:?}")));
        assert!(String::from_utf8_lossy(&stderr).contains("synthetic-stderr"));
        assert!(lease.processes.lock().unwrap().is_empty());
    }
    // This child waits on its own stdin; retirement terminates only its owned Job.
    let handle = spawn();
    let process = lease
        .processes
        .lock()
        .unwrap()
        .get(&handle)
        .unwrap()
        .clone();
    let job = process.lock().unwrap().job.clone();
    lease.retire();
    assert!(job.settled());
    assert!(lease.processes.lock().unwrap().is_empty());
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn complete_job_observation_does_not_use_early_parent_exit_or_consume_output() {
    let root=tempfile::tempdir().unwrap();let state=enabled(root.path());let lease=lease(&state.packages[0]);
    let executable=root.path().join("synthetic-job-order.exe");
    let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/desktop-api2-job-order-child.rs");
    assert!(std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(||"rustc".into()))
        .arg("--edition=2021").arg(source).arg("-o").arg(&executable).status().unwrap().success());
    let signal=root.path().join("release-leaf");
    let spawn=|mode:&str|process_operation(&lease,"spawn",&json!({"executable":executable,"cwd":root.path(),"args":[mode,signal]})).unwrap().as_str().unwrap().to_string();
    let a=spawn("parent");let parent=lease.processes.lock().unwrap().get(&a).unwrap().clone();
    assert!(parent.lock().unwrap().process.wait_for(Duration::from_secs(3)));
    let b=spawn("short");let short=lease.processes.lock().unwrap().get(&b).unwrap().clone();
    let deadline=std::time::Instant::now()+Duration::from_secs(5);
    loop {if short.lock().unwrap().observed_finish.is_some(){break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10));}
    assert!(parent.lock().unwrap().observed_finish.is_none(),"parent exit is not entire job completion");
    std::fs::write(&signal,b"release").unwrap();
    let deadline=std::time::Instant::now()+Duration::from_secs(5);
    loop {if parent.lock().unwrap().observed_finish.is_some(){break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10));}
    let b_order=short.lock().unwrap().observed_finish.unwrap();let a_order=parent.lock().unwrap().observed_finish.unwrap();assert!(b_order<a_order);
    let a_result=process_operation(&lease,"poll",&json!({"handle":a})).unwrap();let b_result=process_operation(&lease,"poll",&json!({"handle":b})).unwrap();
    assert_eq!(a_result["settled"],true);assert_eq!(b_result["settled"],true);
    let stdout=|result:&Value|result["events"].as_array().unwrap().iter().filter(|event|event["stream"]=="stdout")
        .flat_map(|event|B64.decode(event["base64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
    assert_eq!(stdout(&a_result),b"parent-output\n");assert_eq!(stdout(&b_result),b"short-output\n");
    for handle in [&a,&b] {assert!(process_operation(&lease,"poll",&json!({"handle":handle})).unwrap()["events"].as_array().unwrap().is_empty());}
    let cache=lease.terminals.lock().unwrap();let order:Vec<_>=cache.entries.iter().map(|(key,_,_)|key.as_str()).collect();assert_eq!(order,vec![b.as_str(),a.as_str()]);
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn concurrent_terminal_polls_return_output_once_without_losing_the_handle() {
    let root=tempfile::tempdir().unwrap();let state=enabled(root.path());let lease=lease(&state.packages[0]);
    let executable=root.path().join("synthetic-concurrent-poll.exe");
    let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/desktop-api2-job-order-child.rs");
    assert!(std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(||"rustc".into()))
        .arg("--edition=2021").arg(source).arg("-o").arg(&executable).status().unwrap().success());
    for _ in 0..8 {
        let handle=process_operation(&lease,"spawn",&json!({"executable":executable,"cwd":root.path(),"args":["short"]})).unwrap().as_str().unwrap().to_string();
        let entry=lease.processes.lock().unwrap().get(&handle).unwrap().clone();let deadline=std::time::Instant::now()+Duration::from_secs(5);
        loop {if entry.lock().unwrap().observed_finish.is_some(){break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10));}
        let gate=std::sync::Barrier::new(3);
        let results=std::thread::scope(|scope|{
            let call=||{gate.wait();process_operation(&lease,"poll",&json!({"handle":handle}))};
            let one=scope.spawn(call);let two=scope.spawn(call);gate.wait();[one.join().unwrap().unwrap(),two.join().unwrap().unwrap()]
        });
        assert!(results.iter().all(|result|result["settled"]==true));
        let bytes=results.iter().flat_map(|result|result["events"].as_array().unwrap()).filter(|event|event["stream"]=="stdout")
            .flat_map(|event|B64.decode(event["base64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
        assert_eq!(bytes,b"short-output\n");
        assert!(process_operation(&lease,"poll",&json!({"handle":handle})).unwrap()["events"].as_array().unwrap().is_empty());
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
#[test]
fn disable_update_and_exit_cleanup_reap_running_descendants() {
    use windows::Win32::Foundation::{CloseHandle,WAIT_OBJECT_0,WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess,WaitForSingleObject,PROCESS_SYNCHRONIZE};
    struct Watch(windows::Win32::Foundation::HANDLE);
    impl Drop for Watch {fn drop(&mut self){unsafe{let _=CloseHandle(self.0);}}}
    close_all();let root=tempfile::tempdir().unwrap();let executable=root.path().join("synthetic-lifecycle-tree.exe");
    let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/desktop-api2-job-order-child.rs");
    assert!(std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(||"rustc".into()))
        .arg("--edition=2021").arg(source).arg("-o").arg(&executable).status().unwrap().success());
    for action in ["disable","update","exit"] {
        let profile=root.path().join(action);std::fs::create_dir(&profile).unwrap();let state=enabled(&profile);
        let active_lease=lease(&state.packages[0]);let lease_id=format!("fixture-{action}");
        leases().lock().unwrap().insert(lease_id.clone(),active_lease.clone());
        let signal=profile.join("release-leaf");let handle=process_operation(&active_lease,"spawn",&json!({"executable":executable,"cwd":profile,"args":["parent",signal]})).unwrap().as_str().unwrap().to_string();
        let process=active_lease.processes.lock().unwrap().get(&handle).unwrap().clone();
        assert!(process.lock().unwrap().process.wait_for(Duration::from_secs(5)));
        let pid:u32=std::fs::read_to_string(signal.with_extension("pid")).unwrap().parse().unwrap();
        let child=Watch(unsafe{OpenProcess(PROCESS_SYNCHRONIZE,false,pid)}.expect("open own synthetic descendant"));
        assert_eq!(unsafe{WaitForSingleObject(child.0,0)},WAIT_TIMEOUT,"descendant must still be running before {action}");
        let job=process.lock().unwrap().job.clone();assert!(!job.settled());
        match action {
            "disable"=>{crate::extension_runtime::manage(&profile,env!("CARGO_PKG_VERSION"),Request::Disable{id:"test.api2-intake".into(),expected_revision:state.revision}).unwrap();},
            "update"=>{let updated=crate::extension_runtime::manage(&profile,env!("CARGO_PKG_VERSION"),Request::Update{package:package("1.0.1"),publisher_approved:true,expected_revision:state.revision}).unwrap();assert!(!updated.packages[0].enabled);},
            "exit"=>close_all(),
            _=>unreachable!(),
        }
        assert!(!active_lease.live.load(Ordering::Acquire));assert!(active_lease.processes.lock().unwrap().is_empty());
        assert_eq!(unsafe{WaitForSingleObject(child.0,5000)},WAIT_OBJECT_0,"descendant did not terminate after {action}");
        assert!(job.settled());assert!(matches!(authorized(&profile,&lease_id),Err(_)));
    }
    close_all();
}
