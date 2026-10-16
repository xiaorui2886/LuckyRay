use super::*;
use crate::materials::{MaterialAssetPatch, MaterialFolderInput, PatchValue};

struct Download {
    url: String,
    bytes: Vec<u8>,
    count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Download {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let result = thread.join();
            if !std::thread::panicking() {
                result.expect("fixture download thread");
            }
        }
    }
}
impl Download {
    fn image(hook: Option<Box<dyn FnOnce() + Send>>) -> Self {
        let image = image::RgbImage::from_fn(48, 48, |x, y| {
            image::Rgb([
                (x.wrapping_mul(73).wrapping_add(y * 17) % 256) as u8,
                (x.wrapping_mul(13).wrapping_add(y * 89) % 256) as u8,
                (x.wrapping_mul(97).wrapping_add(y * 47) % 256) as u8,
            ])
        });
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Jpeg)
            .unwrap();
        assert!(bytes.get_ref().len() >= 1024);
        Self::serve(bytes.into_inner(), "image/jpeg", hook)
    }
    fn video() -> Self {
        let mut bytes = b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec();
        bytes.extend_from_slice(b"\0\0\0\x10mdatfixture!");
        Self::serve(bytes, "video/mp4", None)
    }
    fn serve(
        bytes: Vec<u8>,
        mime: &'static str,
        mut hook: Option<Box<dyn FnOnce() + Send>>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/synthetic", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_count = Arc::clone(&count);
        let thread_stop = Arc::clone(&stop);
        let payload = bytes.clone();
        let thread = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // Windows accept inherits the listener's nonblocking
                        // mode. Only the listener polls; a served request waits
                        // for its bytes with the bounded read timeout below.
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut request = [0; 4096];
                        socket.read(&mut request).unwrap();
                        thread_count.fetch_add(1, Ordering::SeqCst);
                        if let Some(hook) = hook.take() {
                            hook();
                        }
                        let _ = write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",payload.len());
                        let _ = socket.write_all(&payload);
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("fixture download listener: {error}"),
                }
            }
        });
        Self {
            url,
            bytes,
            count,
            stop,
            thread: Some(thread),
        }
    }
}

fn image_request(f: &Fixture, download: &Download, id: &str) -> Value {
    json!({"libraryId":f.target,"requestId":id,"name":"原图.jpg","url":download.url,"mediaType":"image"})
}
fn call(
    f: &Fixture,
    principal: &VerifiedTransportPrincipal,
    path: &str,
    body: &Value,
) -> (u16, Value) {
    let response = LegacyLocalTransportAdapter::new(Arc::clone(&f.backend)).dispatch_verified(
        principal,
        "POST",
        path,
        Some(&body.to_string()),
    );
    (
        response.status,
        serde_json::from_str(&response.body).unwrap(),
    )
}
fn lookup(
    f: &Fixture,
    principal: &VerifiedTransportPrincipal,
    id: &str,
    operation: &str,
) -> (u16, Value) {
    call(
        f,
        principal,
        "/api/material-libraries/media-receipt",
        &json!({"libraryId":f.target,"requestId":id,"operation":operation}),
    )
}
fn ledger(f: &Fixture) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = fs::read_dir(f._root.path().join("note-capture-receipts"))
        .into_iter()
        .flatten()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().to_string(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

#[test]
fn ordinary_media_real_tcp_original_bytes_frozen_library_organization_replay_and_readonly_receipt()
{
    let f = Fixture::new();
    let catalog = f.backend.material_catalog();
    let switch_catalog = catalog.clone();
    let other = f.other.clone();
    let download = Download::image(Some(Box::new(move || {
        switch_catalog.select_library(&other).unwrap();
    })));
    let target = catalog.for_library(&f.target).unwrap();
    let parent = target
        .create_folder(MaterialFolderInput {
            name: "父分类".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let handle = start_server(
        f.config.clone(),
        Arc::new(LegacyLocalTransportAdapter::new(Arc::clone(&f.backend))),
    )
    .unwrap();
    let caps = tcp(&handle, "GET", "/api/v1/capabilities", None);
    assert_eq!(caps.0, 200);
    assert_eq!(
        caps.1["data"]["namespaces"]["materials"]["mediaImport"]["version"],
        1
    );
    let mut input = image_request(&f, &download, "image-wire");
    input["newFolderName"] = json!("收集");
    input["parentFolderId"] = json!(parent.id);
    input["tagNames"] = json!(["原图"]);
    let first = tcp(&handle, "POST", "/api/v1/assets/import-media", Some(&input));
    assert_eq!(first.0, 200, "{}", first.1);
    let receipt = &first.1["data"];
    assert_eq!(receipt["libraryId"], f.target);
    assert_eq!(receipt["assetName"], "原图.jpg");
    assert_eq!(receipt["organization"]["state"], "applied");
    assert_eq!(receipt["asset"]["tagIds"].as_array().unwrap().len(), 1);
    let assets = target.list_assets(&Default::default()).unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(
        fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(),
        download.bytes
    );
    assert!(catalog
        .for_library(&f.other)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
    assert_eq!(catalog.library_state().unwrap().1, f.other);
    let replay = tcp(&handle, "POST", "/api/assets/import-media", Some(&input));
    assert_eq!(replay.0, 200);
    assert_eq!(&replay.1, receipt);
    assert_eq!(download.count.load(Ordering::SeqCst), 1);
    let before = ledger(&f);
    let version = target.read_library_change().unwrap().version;
    let read = json!({"libraryId":f.target,"requestId":"image-wire","operation":"image"});
    let recovered = tcp(
        &handle,
        "POST",
        "/api/v1/material-libraries/media-receipt",
        Some(&read),
    );
    assert_eq!(recovered.0, 200);
    assert_eq!(recovered.1["data"]["state"], "completed");
    assert_eq!(&recovered.1["data"]["receipt"], receipt);
    let mut wrong_library = read.clone();
    wrong_library["libraryId"] = json!(f.other);
    let hidden = tcp(
        &handle,
        "POST",
        "/api/v1/material-libraries/media-receipt",
        Some(&wrong_library),
    );
    assert_eq!(hidden.0, 200);
    assert_eq!(hidden.1["data"]["state"], "unknown");
    assert!(hidden.1["data"].get("receipt").is_none());
    assert_eq!(ledger(&f), before);
    assert_eq!(target.read_library_change().unwrap().version, version);
    input["tagNames"] = json!(["changed"]);
    assert_eq!(
        tcp(&handle, "POST", "/api/assets/import-media", Some(&input)).0,
        409
    );
    assert_eq!(download.count.load(Ordering::SeqCst), 1);
}

#[test]
fn ordinary_media_preflight_foreign_taxonomy_bad_names_and_unverified_dispatch_have_zero_downloads()
{
    let f = Fixture::new();
    let principal = f.principal(None);
    let download = Download::image(None);
    let foreign = f.backend.material_catalog().for_library(&f.other).unwrap();
    let folder = foreign
        .create_folder(MaterialFolderInput {
            name: "other".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let tag = foreign.create_tag("other", None).unwrap().value;
    for (key, value, status) in [
        ("targetFolderId", json!(folder.id), 403),
        ("tagIds", json!([tag.id]), 403),
        ("name", json!("../escape.jpg"), 400),
        ("name", json!("CON.jpg"), 400),
        ("parentFolderId", json!("unused"), 400),
        ("name", json!(format!("{}.jpg", "中".repeat(80))), 400),
    ] {
        let mut input = image_request(&f, &download, "preflight");
        input[key] = value;
        let result = call(&f, &principal, "/api/assets/import-media", &input);
        assert_eq!(result.0, status, "{result:?}");
    }
    let input = image_request(&f, &download, "unverified");
    let adapter = LegacyLocalTransportAdapter::new(Arc::clone(&f.backend));
    assert_eq!(
        adapter
            .dispatch("POST", "/api/assets/import-media", Some(&input.to_string()))
            .status,
        401
    );
    assert_eq!(download.count.load(Ordering::SeqCst), 0);
    assert!(ledger(&f).is_empty());
    assert!(f
        .backend
        .material_catalog()
        .for_library(&f.target)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
}

#[test]
fn ordinary_media_revocation_during_download_refuses_commit_and_cached_reads() {
    let f = Fixture::new();
    let principal = f.principal(None);
    let auth = Arc::clone(&f.auth);
    let download = Download::image(Some(Box::new(move || {
        auth.lock().unwrap().rotate_master().unwrap();
    })));
    let result = call(
        &f,
        &principal,
        "/api/assets/import-media",
        &image_request(&f, &download, "revoke-image"),
    );
    assert_eq!(result.0, 403);
    assert_eq!(download.count.load(Ordering::SeqCst), 1);
    assert!(f
        .backend
        .material_catalog()
        .for_library(&f.target)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
    assert_eq!(lookup(&f, &principal, "revoke-image", "image").0, 403);
}

#[test]
fn ordinary_media_duplicate_keeps_manual_metadata_without_unused_folder_or_tag() {
    let f = Fixture::new();
    let principal = f.principal(None);
    let download = Download::image(None);
    let first = call(
        &f,
        &principal,
        "/api/assets/import-media",
        &image_request(&f, &download, "original"),
    );
    assert_eq!(first.0, 200, "{first:?}");
    let id = first.1["assetId"].as_str().unwrap();
    let catalog = f.backend.material_catalog().for_library(&f.target).unwrap();
    let folder = catalog
        .create_folder(MaterialFolderInput {
            name: "人工".into(),
            parent_id: None,
        })
        .unwrap()
        .value;
    let tag = catalog.create_tag("人工标签", None).unwrap().value;
    catalog
        .update_asset(
            id,
            MaterialAssetPatch {
                name: Some("人工.jpg".into()),
                folder_id: PatchValue::Value(Some(folder.id.clone())),
                ..Default::default()
            },
            "test-manual",
        )
        .unwrap();
    catalog.set_asset_tags(id, vec![tag.id.clone()]).unwrap();
    let mut next = image_request(&f, &download, "duplicate");
    next["newFolderName"] = json!("不要创建");
    next["tagNames"] = json!(["不要创建"]);
    let duplicate = call(&f, &principal, "/api/assets/import-media", &next);
    assert_eq!(duplicate.0, 200, "{duplicate:?}");
    assert_eq!(duplicate.1["disposition"], "duplicate");
    assert_eq!(duplicate.1["assetName"], "人工.jpg");
    assert_eq!(duplicate.1["asset"]["folderId"], folder.id);
    assert_eq!(duplicate.1["asset"]["tagIds"], json!([tag.id]));
    assert_eq!(duplicate.1["organization"]["state"], "preserved");
    assert_eq!(catalog.list_folders().unwrap().len(), 1);
    assert_eq!(catalog.list_tags().unwrap().len(), 1);
}

#[test]
fn ordinary_media_receipt_strict_unknown_and_wrong_library_are_readonly() {
    let f = Fixture::new();
    let principal = f.principal(None);
    let unknown = lookup(&f, &principal, "missing", "video");
    assert_eq!(unknown.0, 200);
    assert_eq!(unknown.1["state"], "unknown");
    for (key, value) in [
        ("url", json!("https://example.test")),
        ("cookies", json!("private")),
        ("route", json!("/api/notes")),
        ("operation", json!("arbitrary")),
    ] {
        let mut body = json!({"libraryId":f.target,"requestId":"missing","operation":"image"});
        body[key] = value;
        assert_eq!(
            call(
                &f,
                &principal,
                "/api/material-libraries/media-receipt",
                &body
            )
            .0,
            400
        );
    }
    assert!(ledger(&f).is_empty());
    for prefix in ["/api", "/api/v1"] {
        let path = format!("{prefix}/material-libraries/media-receipt");
        assert_eq!(
            route_for("POST", &path).unwrap().tier,
            CapabilityTier::Dangerous
        );
        assert_eq!(route_for("GET", &path).err(), Some(405));
        assert_eq!(
            route_for("POST", &format!("{path}?route=other")).err(),
            Some(400)
        );
    }
}

#[test]
fn ordinary_media_video_real_worker_frozen_destination_owner_tiers_and_lost_job_unknown() {
    let f = Fixture::with_media_loopback(true);
    let principal = f.principal(None);
    let download = Download::video();
    let catalog = f.backend.material_catalog();
    catalog.select_library(&f.other).unwrap();
    let input = json!({"libraryId":f.target,"requestId":"video-real","url":download.url,"fileName":"片段.mp4","tagNames":["视频"]});
    let started = call(&f, &principal, "/api/media/transfers", &input);
    assert_eq!(started.0, 202, "{started:?}");
    assert!(started.1.get("receipt").is_none());
    assert_eq!(started.1["libraryId"], f.target);
    let id = started.1["transferId"].as_str().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let completed = loop {
        let snapshot = f.backend.media_transfer().status(id).unwrap();
        if matches!(
            snapshot.state,
            crate::media_transfer::MediaTransferState::Completed
                | crate::media_transfer::MediaTransferState::Failed
                | crate::media_transfer::MediaTransferState::Cancelled
        ) {
            break snapshot;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(
        completed.state,
        crate::media_transfer::MediaTransferState::Completed,
        "{completed:?}"
    );
    let assets = catalog
        .for_library(&f.target)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(
        fs::read(assets[0].library_path.as_ref().unwrap()).unwrap(),
        download.bytes
    );
    assert_eq!(
        completed.receipt.as_ref().unwrap()["organization"]["state"],
        "applied"
    );
    assert!(catalog
        .for_library(&f.other)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
    let native = f.auth.lock().unwrap().native_credential().unwrap();
    let headers = HashMap::from([("authorization".into(), format!("Bearer {native}"))]);
    let read_principal = authenticate(&headers, None, &f.config, &f.auth, CapabilityTier::Read)
        .unwrap_or_else(|_| panic!("test identity"));
    let adapter = LegacyLocalTransportAdapter::new(Arc::clone(&f.backend));
    let path = format!("/api/media/transfers/{id}");
    assert_eq!(
        adapter
            .dispatch_verified(&read_principal, "GET", &path, None)
            .status,
        200
    );
    f.auth
        .lock()
        .unwrap()
        .approve_origin(EDGE_DEV_EXTENSION_ORIGIN)
        .unwrap();
    let stranger = f.principal(Some(EDGE_DEV_EXTENSION_ORIGIN));
    assert_eq!(
        adapter
            .dispatch_verified(&stranger, "GET", &path, None)
            .status,
        403
    );
    assert_eq!(
        adapter
            .dispatch_verified(&stranger, "POST", &format!("{path}/cancel"), None)
            .status,
        403
    );
    assert_eq!(adapter.dispatch("GET", &path, None).status, 401);
    let before = ledger(&f);
    assert_eq!(
        lookup(&f, &principal, "video-real", "video").1["state"],
        "completed"
    );
    assert_eq!(ledger(&f), before);
    assert_eq!(call(&f, &principal, "/api/media/transfers", &input).0, 202);
    assert_eq!(download.count.load(Ordering::SeqCst), 1);
    let restarted = BackendServices::initialize(f._root.path()).unwrap();
    let result = crate::materials::media_import_transport::route(
        &restarted,
        &principal,
        "POST",
        "/api/material-libraries/media-receipt",
        Some(
            &json!({"libraryId":f.target,"requestId":"video-real","operation":"video"}).to_string(),
        ),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result.body).unwrap()["state"],
        "unknown"
    );
    let replay = LegacyLocalTransportAdapter::new(Arc::new(restarted)).dispatch_verified(
        &principal,
        "POST",
        "/api/media/transfers",
        Some(&input.to_string()),
    );
    assert_eq!(replay.status, 409);
    assert!(replay.body.contains("capture-commit-uncertain"));
    assert_eq!(download.count.load(Ordering::SeqCst), 1);
}

#[test]
fn ordinary_media_video_pending_cancelled_and_failed_are_not_saved() {
    let f = Fixture::with_media_loopback(true);
    let principal = f.principal(None);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let download = Download::serve(
        b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec(),
        "video/mp4",
        Some(Box::new(move || {
            entered_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        })),
    );
    let input = json!({"libraryId":f.target,"requestId":"video-cancel","url":download.url,"fileName":"cancel.mp4"});
    let started = call(&f, &principal, "/api/media/transfers", &input);
    assert_eq!(started.0, 202, "{started:?}");
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        lookup(&f, &principal, "video-cancel", "video").1["state"],
        "pending"
    );
    let cancelled = call(
        &f,
        &principal,
        &format!(
            "/api/media/transfers/{}/cancel",
            started.1["transferId"].as_str().unwrap()
        ),
        &json!({}),
    );
    assert_eq!(cancelled.0, 200);
    release_tx.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let receipt = lookup(&f, &principal, "video-cancel", "video");
        if receipt.1["state"] == "cancelled" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{receipt:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
    let bad_video = Download::image(None);
    let started = call(
        &f,
        &principal,
        "/api/media/transfers",
        &json!({"libraryId":f.target,"requestId":"video-fail","url":bad_video.url,"fileName":"bad.mp4"}),
    );
    assert_eq!(started.0, 202);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let receipt = lookup(&f, &principal, "video-fail", "video");
        if receipt.1["state"] == "failed" {
            assert!(receipt.1.get("receipt").is_none());
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{receipt:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(f
        .backend
        .material_catalog()
        .for_library(&f.target)
        .unwrap()
        .list_assets(&Default::default())
        .unwrap()
        .is_empty());
}
