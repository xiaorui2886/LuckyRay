//! Explicit Windows PE acceptance against production Backend/Registry/HTTP/HMAC.
//! Every business file and credential belongs to this newly created fixture.
use super::*;
use crate::{
    backend::BackendServices, knowledge::KnowledgeVaultRegistration, LegacyLocalTransportAdapter,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};

struct Binaries {
    cli: PathBuf,
    mcp: PathBuf,
    root: PathBuf,
    cli_calls: Cell<usize>,
    pids: RefCell<Vec<u32>>,
}
impl Binaries {
    fn command(&self, binary: &Path) -> Command {
        let mut command = Command::new(binary);
        // This is an independent synthetic APPDATA, never a redirected Main
        // profile. Production sidecars still perform their normal discovery,
        // credential load and HMAC proof; no connect_with/mock seam is used.
        command
            .env("APPDATA", &self.root)
            .env_remove("LUCKYRAY_APP_PROFILE");
        command.current_dir(&self.root);
        command
    }
    fn cli(&self, args: &[&str], input: Option<&Value>, exit: i32) -> Value {
        self.cli_calls.set(self.cli_calls.get() + 1);
        let mut command = self.command(&self.cli);
        let mut child = command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        self.pids.borrow_mut().push(child.id());
        if let Some(input) = input {
            serde_json::to_writer(child.stdin.as_mut().unwrap(), input).unwrap();
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit),
            "CLI {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        if exit == 0 {
            assert!(output.stderr.is_empty());
            serde_json::from_slice(&output.stdout).unwrap()
        } else {
            assert!(output.stdout.is_empty());
            serde_json::from_slice(&output.stderr).unwrap()
        }
    }
    fn tool(&self, id: &str, input: Value) -> Value {
        self.cli(&["tools", "run", id, "--stdin"], Some(&input), 0)["result"].clone()
    }
    fn refused(&self, id: &str, input: Value, code: &str) {
        assert_eq!(
            self.cli(&["tools", "run", id, "--stdin"], Some(&input), 4)["error"]["code"],
            code
        );
    }
}

struct McpProcess {
    child: Child,
    input: Option<ChildStdin>,
    messages: Receiver<Value>,
    calls: usize,
}
impl McpProcess {
    fn start(binaries: &Binaries) -> Self {
        let mut child = binaries
            .command(&binaries.mcp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            input: child.stdin.take(),
            child,
            messages: receive,
            calls: 0,
        }
    }
    fn send(&mut self, message: Value) {
        let input = self.input.as_mut().unwrap();
        serde_json::to_writer(&mut *input, &message).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
    }
    fn rpc(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.calls += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let value = self
                .messages
                .recv_timeout(Duration::from_secs(25))
                .expect("MCP response before deadline");
            if value["id"] == id {
                return value;
            }
        }
    }
    fn tool(&mut self, id: &str, name: &str, args: Value) -> Value {
        let value = self.rpc(id, "tools/call", json!({"name":name,"arguments":args}));
        assert!(
            value.get("error").is_none(),
            "MCP protocol failure: {value}"
        );
        assert_ne!(
            value["result"]["isError"], true,
            "MCP tool failure: {value}"
        );
        value["result"]["structuredContent"].clone()
    }
    fn finish(&mut self) {
        drop(self.input.take());
        for _ in 0..100 {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("MCP did not exit after its own stdin closed");
    }
}
impl Drop for McpProcess {
    fn drop(&mut self) {
        drop(self.input.take());
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn sha_file(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn register(backend: &BackendServices, root: &Path, id: &str) -> KnowledgeVaultRegistration {
    fs::create_dir_all(root.join(".luckyray")).unwrap();
    let vault = KnowledgeVaultRegistration {
        id: id.into(),
        name: id.into(),
        root_path: root.to_string_lossy().into(),
        mode: "vault-bound".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        last_opened_at: "2026-10-29T00:00:00Z".into(),
        schema_version: 1,
        link_update_policy: Default::default(),
    };
    fs::write(
        root.join(".luckyray/vault.json"),
        serde_json::to_vec(&vault).unwrap(),
    )
    .unwrap();
    backend.knowledge().register_current_vault(&vault).unwrap();
    vault
}

#[test]
#[cfg(windows)]
#[ignore = "requires explicitly staged, matching Windows CLI/MCP executables and a synthetic evidence directory"]
fn staged_windows_cli_and_mcp_call_real_native_owners_without_user_data() {
    let bin = PathBuf::from(
        std::env::var_os("LUCKYRAY_NATIVE_TEST_BIN_DIR").expect("explicit staged binary directory"),
    );
    let evidence = PathBuf::from(
        std::env::var_os("LUCKYRAY_NATIVE_TEST_EVIDENCE_DIR")
            .expect("explicit synthetic evidence directory"),
    );
    fs::create_dir_all(&evidence).unwrap();
    let root = evidence.join(format!(
        "fixture-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    fs::create_dir(&root).unwrap();
    let binaries = Binaries {
        cli: bin.join("luckyray-cli-x86_64-pc-windows-msvc.exe"),
        mcp: bin.join("luckyray-mcp-x86_64-pc-windows-msvc.exe"),
        root: root.clone(),
        cli_calls: Cell::new(0),
        pids: RefCell::new(Vec::new()),
    };
    for file in [&binaries.cli, &binaries.mcp] {
        assert_eq!(&fs::read(file).unwrap()[..2], b"MZ");
    }
    let cli_hash = sha_file(&binaries.cli);
    let mcp_hash = sha_file(&binaries.mcp);
    let app = root.join("com.luckyray.desktop");
    let backend = Arc::new(BackendServices::initialize(&app).unwrap());
    let vault_a = register(&backend, &root.join("vault-a"), "vault-native-binary-a");
    let vault_b_root = root.join("vault-b");
    let catalog = backend.material_catalog();
    let library = |name: &str| {
        let p = root.join(name);
        fs::create_dir(&p).unwrap();
        catalog.create_library(name, &p, "managed").unwrap().id
    };
    let library_a = library("material-a");
    let library_b = library("material-b");
    catalog.select_library(&library_b).unwrap();
    let mut config = ServerConfig::test(app.clone());
    config.ports = (37418..=37467).collect();
    config.max_connections = 16;
    config.read_timeout = Duration::from_secs(5);
    config.write_timeout = Duration::from_secs(5);
    let transport = start_server(
        config,
        Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
    )
    .unwrap();
    let list = binaries.cli(&["tools", "list"], None, 0);
    assert_eq!(list.as_array().unwrap().len(), 26);
    assert_eq!(
        binaries.cli(&["tools", "describe", "canvas.save"], None, 0)["risk"],
        "dangerous"
    );
    assert_eq!(binaries.cli(&["status"], None, 0)["serverVerified"], true);
    assert_eq!(binaries.cli(&["doctor"], None, 0)["toolCount"], 26);
    for args in [
        &["--help", "--json"][..],
        &["--version", "--json"][..],
        &["protocol", "identity"][..],
    ] {
        assert_eq!(binaries.cli(args, None, 0)["ok"], true);
    }
    fs::write(
        root.join("package.json"),
        r#"{"name":"native-binary-synthetic"}"#,
    )
    .unwrap();
    assert_eq!(
        binaries.cli(&["verify", "workspace-manifest"], None, 0)["status"],
        "passed"
    );
    let create = json!({"expectedVaultId":vault_a.id,"relativePath":"Native.md","content":"seed","requestId":"binary-note-create"});
    let made = binaries.tool("knowledge.create", create.clone());
    assert_eq!(binaries.tool("knowledge.create", create), made);
    let reference = made["documentRef"].clone();
    let replace = json!({"expectedVaultId":vault_a.id,"documentRef":reference,"expectedRevision":made["revision"],"content":"safe","requestId":"binary-note-replace"});
    let replaced = binaries.tool("knowledge.replace", replace.clone());
    assert_eq!(
        binaries.tool("knowledge.replace", replace.clone()),
        replaced
    );
    let note_path = PathBuf::from(&vault_a.root_path).join("Native.md");
    let note_before = fs::read(&note_path).unwrap();
    let mut stale = replace.clone();
    stale["requestId"] = json!("binary-note-stale");
    stale["content"] = json!("must not write");
    binaries.refused("knowledge.replace", stale, "knowledge-revision-conflict");
    let vault_b = register(&backend, &vault_b_root, "vault-native-binary-b");
    binaries.refused(
        "knowledge.replace",
        replace.clone(),
        "knowledge-vault-not-current",
    );
    assert!(!vault_b_root.join("Native.md").exists());
    backend
        .knowledge()
        .register_current_vault(&vault_a)
        .unwrap();
    assert_eq!(binaries.tool("knowledge.replace", replace), replaced);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let inserted=binaries.tool("knowledge.insert",json!({"expectedVaultId":vault_a.id,"documentRef":reference,"expectedRevision":replaced["document"]["revision"],"offset":4,"text":"!","requestId":"binary-note-insert"}));
    let moved=binaries.tool("knowledge.move",json!({"expectedVaultId":vault_a.id,"documentRef":reference,"expectedRevision":inserted["document"]["revision"],"relativePath":"Moved.md","requestId":"binary-note-move"}));
    let moved_ref = moved["document"]["documentRef"].clone();
    assert_eq!(
        binaries.tool("knowledge.read", json!({"documentRef":moved_ref}))["content"],
        "safe!"
    );
    assert_eq!(binaries.tool("knowledge.list", json!({}))["total"], 1);
    let tagged=binaries.tool("knowledge.set_tags",json!({"expectedVaultId":vault_a.id,"documentRef":moved_ref,"expectedRevision":moved["document"]["revision"],"tags":["synthetic"],"requestId":"binary-note-tags"}));
    assert!(binaries.tool("knowledge.tags", json!({}))["tags"].is_array());
    assert!(
        binaries.tool("knowledge.relations", json!({"documentRef":moved_ref}))["backlinks"]
            .is_array()
    );
    let created = binaries.tool(
        "canvas.create",
        json!({"name":"Native binary Canvas","requestId":"binary-canvas-create"}),
    );
    let id = created["canvas"]["canvasId"].as_str().unwrap();
    let read = binaries.tool("canvas.read", json!({"canvasId":id}));
    let save = json!({"canvasId":id,"expectedRevision":read["revision"],"expectedContentDigest":read["contentDigest"],"requestId":"binary-canvas-save","nodes":[{"id":"n1","type":"spike","position":{"x":10,"y":20},"data":{"kind":"text","label":"Native synthetic","text":"saved","preservedExtension":{"key":"kept"}}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"generationHistory":[]});
    let saved = binaries.tool("canvas.save", save.clone());
    assert_eq!(binaries.tool("canvas.save", save.clone()), saved);
    let disk = app.join("canvases").join(format!("{id}.json"));
    let canvas_before = fs::read(&disk).unwrap();
    let mut stale = save.clone();
    stale["requestId"] = json!("binary-canvas-stale");
    binaries.refused("canvas.save", stale, "canvas-agent-revision-conflict");
    let mut invalid = save;
    invalid["requestId"] = json!("binary-canvas-invalid");
    invalid["nodes"] = json!([null]);
    binaries.refused("canvas.save", invalid, "tool-input-invalid");
    assert_eq!(fs::read(&disk).unwrap(), canvas_before);
    let read = binaries.tool("canvas.read", json!({"canvasId":id}));
    assert_eq!(
        read["nodes"][0]["data"]["preservedExtension"]["key"],
        "kept"
    );
    binaries.tool("canvas.rename",json!({"canvasId":id,"expectedRevision":read["revision"],"expectedContentDigest":read["contentDigest"],"name":"Renamed binary Canvas","requestId":"binary-canvas-rename"}));
    let libraries = binaries.tool("materials.libraries", json!({}));
    assert!(libraries["libraries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["libraryId"] == library_a));
    let import = json!({"libraryId":library_a,"requestId":"binary-import","name":"Synthetic.md","mimeType":"text/markdown","bytesBase64":STANDARD.encode(b"# Native material")});
    let imported = binaries.tool("materials.import_bytes", import.clone());
    assert_eq!(binaries.tool("materials.import_bytes", import), imported);
    let asset = imported["assetId"].as_str().unwrap();
    assert_eq!(
        binaries.tool("materials.list", json!({"libraryId":library_a}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        binaries.tool("materials.list", json!({"libraryId":library_b}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        binaries.tool(
            "materials.library_preview",
            json!({"libraryId":library_a,"assetId":asset})
        )["content"],
        "# Native material"
    );
    binaries.refused(
        "materials.detail",
        json!({"libraryId":library_b,"assetId":asset}),
        "material-library-scope",
    );
    let detail = binaries.tool(
        "materials.detail",
        json!({"libraryId":library_a,"assetId":asset}),
    );
    let revision = detail["asset"]["revision"].clone();
    let updated=binaries.tool("materials.update",json!({"libraryId":library_a,"assetId":asset,"expectedRevision":revision,"requestId":"binary-update","patch":{"description":"synthetic updated","rating":4}}));
    binaries.refused("materials.update",json!({"libraryId":library_a,"assetId":asset,"expectedRevision":revision,"requestId":"binary-update-stale","patch":{"description":"must not write"}}),"material-revision-conflict");
    let folder=binaries.tool("materials.organize",json!({"libraryId":library_a,"requestId":"binary-folder","action":{"op":"create_folder","name":"native"}}));
    binaries.tool("materials.organize",json!({"libraryId":library_a,"requestId":"binary-categorize","action":{"op":"categorize","assetId":asset,"expectedRevision":updated["asset"]["revision"],"folderId":folder["folder"]["id"]}}));
    assert_eq!(
        binaries.tool("materials.library_taxonomy", json!({"libraryId":library_a}))["folders"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut mcp = McpProcess::start(&binaries);
    let mcp_pid = mcp.child.id();
    let initialized=mcp.rpc("init","initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"native-binary-synthetic","version":"1"}}));
    assert!(initialized.get("error").is_none());
    mcp.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    assert_eq!(
        mcp.rpc("list", "tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        26
    );
    assert_eq!(
        mcp.tool("read-canvas", "canvas.read", json!({"canvasId":id}))["nodes"][0]["data"]["text"],
        "saved"
    );
    let mcp_create = json!({"name":"MCP binary Canvas","requestId":"ignored-client-request"});
    let second = mcp.tool("mcp-create-once", "canvas.create", mcp_create.clone());
    assert_eq!(
        mcp.tool("mcp-create-once", "canvas.create", mcp_create),
        second
    );
    let append = json!({"expectedVaultId":vault_a.id,"documentRef":moved_ref,"expectedRevision":tagged["document"]["revision"],"content":"\nMCP","requestId":"ignored-client-append"});
    let appended = mcp.tool("mcp-append-once", "knowledge.append", append.clone());
    let moved_path = PathBuf::from(&vault_a.root_path).join("Moved.md");
    let appended_bytes = fs::read(&moved_path).unwrap();
    assert_eq!(
        mcp.tool("mcp-append-once", "knowledge.append", append),
        appended
    );
    assert_eq!(fs::read(&moved_path).unwrap(), appended_bytes);
    let content = fs::read_to_string(&moved_path).unwrap();
    assert_eq!(content.matches("MCP").count(), 1);
    assert_eq!(
        mcp.tool(
            "mcp-note-read",
            "knowledge.read",
            json!({"documentRef":moved_ref})
        )["content"],
        content
    );
    assert_eq!(
        mcp.tool(
            "mcp-material-read",
            "materials.detail",
            json!({"libraryId":library_a,"assetId":asset})
        )["asset"]["description"],
        "synthetic updated"
    );
    assert_eq!(binaries.tool("canvas.list", json!({}))["total"], 2);
    assert_eq!(
        catalog
            .for_library(&library_b)
            .unwrap()
            .list_assets(&Default::default())
            .unwrap()
            .len(),
        0
    );
    assert_eq!(sha_file(&binaries.cli), cli_hash);
    assert_eq!(sha_file(&binaries.mcp), mcp_hash);
    let mcp_calls = mcp.calls;
    mcp.finish();
    drop(transport);
    let report = json!({"result":"PASS","windowsPe":true,"proofAuthenticated":true,"host":"production BackendServices/LocalTransport/ToolRegistry; isolated synthetic profile","toolCount":26,"cliSha256":cli_hash,"mcpSha256":mcp_hash,"cliProcesses":binaries.pids.borrow().len(),"cliInvocations":binaries.cli_calls.get(),"mcpPid":mcp_pid,"mcpRpcRequests":mcp_calls,"notesReadWrite":true,"canvasReadWrite":true,"materialExplicitLibrary":true,"staleRevisionNoOverwrite":true,"sameRequestNoSecondWrite":true,"canvasSavedNodes":1,"savedCanvases":2,"materialACount":1,"materialBCount":0,"fixturePath":root,"fixtureVaultB":vault_b.id,"realUserDataTouched":false,"credentialsRecorded":false,"modelRequests":0});
    fs::write(
        evidence.join("native-binary-acceptance.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("native-binary-acceptance PASS:26 tools, exact Windows PE, synthetic files only; see native-binary-acceptance.json");
}
