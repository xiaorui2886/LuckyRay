//! Real two-process Keychain record checks. Every operation is explicitly
//! scoped to a disposable fixture; no default-keychain or search-list APIs.
use super::*;
use security_framework::os::macos::keychain::CreateOptions;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const ORIGINAL: &[u8] = b"same synthetic record identity";
const DIFFERENT: &[u8] = b"different synthetic record identity";
const PASSWORD: &str = "synthetic-test-only";
const RENAMED_SERVICE: &str = "com.luckyray.companion.record-test.renamed";
const CHILD_TEST: &str = "companion_gateway::macos_identity::record_tests::macos_keychain_record_subprocess_helper";
const CHILD_DONE: &str = "macos-keychain-record-child-completed";
const AUTHORITY_FILE: &str = "record-child.authority";
const CHILD_PHASES: &[&str] = &[
    "macos-keychain-record-child-opened",
    "macos-keychain-record-child-deleted",
    "macos-keychain-record-child-recreated",
    "macos-keychain-record-child-verified",
    "macos-keychain-record-child-renamed",
];
const CHILD_FAILURES: &[&str] = &[
    "macos-keychain-record-child-source-invalid",
    "macos-keychain-record-child-target-invalid",
    "macos-keychain-record-child-old-key-remained",
    "macos-keychain-record-child-rename-failed",
    "macos-keychain-record-child-renamed-source-invalid",
    "macos-keychain-record-child-keychain-delete-failed",
    "macos-keychain-record-child-keychain-source-path-mismatch",
    "macos-keychain-record-child-keychain-delete-unconfirmed",
    "macos-keychain-record-child-keychain-recreated-path-mismatch",
    "macos-keychain-record-child-keychain-not-new",
    "macos-keychain-record-child-scope-invalid",
    "macos-keychain-swap-delete-unconfirmed",
];

// Public SecBase.h layouts, used only by this isolated attributes-only fixture.
#[repr(C)]
struct KeychainAttribute {
    tag: u32,
    length: u32,
    data: *mut std::ffi::c_void,
}
#[repr(C)]
struct KeychainAttributeList {
    count: u32,
    attr: *mut KeychainAttribute,
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    // These are documented public Keychain APIs. CFTypeRef has the same opaque
    // pointer ABI as SecKeychainRef, and only a concrete fixture ref is passed.
    fn SecKeychainGetPath(keychain: CFTypeRef, length: *mut u32, path: *mut std::os::raw::c_char) -> i32;
    fn SecKeychainDelete(keychain: CFTypeRef) -> i32;
    fn SecKeychainItemModifyAttributesAndData(item: CFTypeRef, attributes: *const KeychainAttributeList,
        length: u32, data: *const std::ffi::c_void) -> i32;
}

fn keychain_path(keychain: &SecKeychain) -> PathBuf {
    let mut bytes = vec![0u8; 4096];
    let mut length = bytes.len() as u32;
    let status = unsafe { SecKeychainGetPath(keychain.as_CFTypeRef(), &mut length, bytes.as_mut_ptr().cast()) };
    assert_eq!(status, 0, "macos-keychain-record-fixture-path-failed");
    assert!((length as usize) < bytes.len(), "macos-keychain-record-fixture-path-failed");
    bytes.truncate(length as usize);
    while bytes.last() == Some(&0) { bytes.pop(); }
    PathBuf::from(OsString::from_vec(bytes))
}

struct ChildInvocation {
    app: PathBuf,
    keychain: PathBuf,
    token: String,
    action: &'static str,
}
impl ChildInvocation {
    fn new(app: &Path, keychain: &SecKeychain, action: &'static str) -> Self {
        let token = format!("{:032x}", rand::random::<u128>());
        fs::write(app.parent().unwrap().join(AUTHORITY_FILE), token.as_bytes()).unwrap();
        Self { app: app.to_owned(), keychain: keychain_path(keychain), token, action }
    }

    fn run(self) {
        diagnostic("macos-keychain-swap-hook-entered");
        let output = Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--ignored", "--test-threads=1", "--quiet", "--nocapture", "--color=never"])
            .env("LUCKYRAY_RECORD_TEST_APP", &self.app)
            .env("LUCKYRAY_RECORD_TEST_KEYCHAIN", &self.keychain)
            .env("LUCKYRAY_RECORD_TEST_TOKEN", &self.token)
            .env("LUCKYRAY_RECORD_TEST_ACTION", self.action)
            .stdin(Stdio::null())
            .output().unwrap_or_else(|_| panic!("macos-keychain-record-child-spawn-failed"));
        // Child libtest summaries and raw failure output never reach the outer
        // native-case protocol. Relay only fixed, non-secret phase/error codes.
        let stderr = String::from_utf8_lossy(&output.stderr);
        for &phase in CHILD_PHASES {
            if stderr.lines().any(|line| line.trim() == phase) { diagnostic(phase); }
        }
        for &code in CHILD_FAILURES {
            if stderr.contains(code) { diagnostic(code); }
        }
        if output.status.code() == Some(86) { diagnostic("macos-keychain-record-child-timeout"); }
        assert!(output.status.success(), "macos-keychain-record-child-failed");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(stdout.lines().filter(|line| line.trim() == CHILD_DONE).count(), 1,
            "macos-keychain-record-child-protocol-invalid");
        assert_eq!(stdout.lines().filter(|line| line.trim() == "running 1 test").count(), 1,
            "macos-keychain-record-child-protocol-invalid");
        let summaries: Vec<_> = stdout.lines().filter(|line| line.starts_with("test result:")).collect();
        assert_eq!(summaries.len(), 1, "macos-keychain-record-child-protocol-invalid");
        assert!(summaries[0].starts_with("test result: ok. 1 passed; 0 failed; 0 ignored;"),
            "macos-keychain-record-child-protocol-invalid");
    }
}

fn arm_child(invocation: ChildInvocation) {
    AFTER_KEYCHAIN_SELECTION.with(|slot| *slot.borrow_mut() = Some(Box::new(move || invocation.run())));
}

fn assert_selection_hook_completed() {
    assert!(AFTER_KEYCHAIN_SELECTION.with(|slot| slot.borrow().is_none()),
        "macos-keychain-swap-hook-not-completed");
}

fn reject_item_replacement(action: &'static str, expected: &[u8]) {
    let (_temp, app, keychain) = tests::isolated_keychain();
    let store = MacIdentityStore::for_test(&app, keychain.clone());
    store.store(ORIGINAL).unwrap();
    arm_child(ChildInvocation::new(&app, &keychain, action));
    let result = store.load();
    assert_selection_hook_completed();
    assert!(result.is_err(), "macos-keychain-record-replacement-was-adopted");
    // The next independent selection may read the new item. The rejection
    // above must be attributable to the selected record changing mid-read.
    assert!(store.load().unwrap().unwrap().as_slice() == expected,
        "macos-keychain-record-replacement-fixture-invalid");
}

#[test]
fn macos_keychain_record_guard_rejects_other_process_same_bytes_replacement() {
    reject_item_replacement("replace-same", ORIGINAL);
}

#[test]
fn macos_keychain_record_guard_rejects_other_process_different_bytes_replacement() {
    reject_item_replacement("replace-different", DIFFERENT);
}

#[test]
fn macos_keychain_record_guard_keeps_selected_item_after_other_process_rename() {
    let (_temp, app, keychain) = tests::isolated_keychain();
    let store = MacIdentityStore::for_test(&app, keychain.clone());
    store.store(ORIGINAL).unwrap();
    arm_child(ChildInvocation::new(&app, &keychain, "rename-then-replace"));
    let result = store.load();
    assert_selection_hook_completed();
    // The declared direct-item policy keeps the original selected record when
    // only its attributes move. It must not re-query the old key and read R.
    assert!(result.unwrap().unwrap().as_slice() == ORIGINAL,
        "macos-keychain-record-renamed-selection-rebound");
    assert!(store.load().unwrap().unwrap().as_slice() == DIFFERENT,
        "macos-keychain-record-replacement-fixture-invalid");
}

#[test]
fn macos_keychain_record_guard_allows_other_process_reopen_without_replacement() {
    let (_temp, app, keychain) = tests::isolated_keychain();
    let store = MacIdentityStore::for_test(&app, keychain.clone());
    store.store(ORIGINAL).unwrap();
    arm_child(ChildInvocation::new(&app, &keychain, "reopen"));
    let result = store.load();
    assert_selection_hook_completed();
    assert!(result.unwrap().unwrap().as_slice() == ORIGINAL,
        "macos-keychain-record-reopen-changed-identity");
}

#[test]
fn macos_keychain_record_guard_rejects_other_process_keychain_delete_recreate() {
    let (_temp, app, keychain) = tests::isolated_keychain();
    let store = MacIdentityStore::for_test(&app, keychain.clone());
    store.store(ORIGINAL).unwrap();
    arm_child(ChildInvocation::new(&app, &keychain, "recreate-keychain"));
    let result = store.load();
    assert_selection_hook_completed();
    match &result {
        Ok(Some(bytes)) if bytes.as_slice() == ORIGINAL =>
            diagnostic("macos-keychain-record-recreated-returned-original"),
        Ok(Some(bytes)) if bytes.as_slice() == DIFFERENT =>
            diagnostic("macos-keychain-record-recreated-returned-different"),
        Ok(Some(_)) => diagnostic("macos-keychain-record-recreated-returned-other"),
        Ok(None) => diagnostic("macos-keychain-record-recreated-returned-missing"),
        Err(_) => diagnostic("macos-keychain-record-recreated-returned-error"),
    }
    // Distinct synthetic bytes distinguish an old snapshot from a replacement;
    // neither permits the paused read to succeed after confirmed DB recreation.
    // If the platform/guard cannot distinguish it, this test must remain failed.
    assert!(result.is_err(), "macos-keychain-record-recreated-keychain-was-adopted");
}

#[test]
#[ignore = "subprocess helper invoked by record tests"]
fn macos_keychain_record_subprocess_helper() {
    let app = PathBuf::from(std::env::var_os("LUCKYRAY_RECORD_TEST_APP").expect("macos-keychain-record-child-scope-invalid"));
    let path = PathBuf::from(std::env::var_os("LUCKYRAY_RECORD_TEST_KEYCHAIN").expect("macos-keychain-record-child-scope-invalid"));
    let token = std::env::var("LUCKYRAY_RECORD_TEST_TOKEN").expect("macos-keychain-record-child-scope-invalid");
    let action = std::env::var("LUCKYRAY_RECORD_TEST_ACTION").expect("macos-keychain-record-child-scope-invalid");
    let root = app.parent().expect("macos-keychain-record-child-scope-invalid");
    let temp = std::env::temp_dir().canonicalize().unwrap();
    assert!(app == root.join("app") && root.parent() == Some(temp.as_path())
        && app.canonicalize().unwrap() == app && path.parent() == Some(root),
        "macos-keychain-record-child-scope-invalid");
    assert!(matches!(path.file_name(), Some(name) if name == OsStr::new("fixture.keychain") || name == OsStr::new("fixture.keychain-db")),
        "macos-keychain-record-child-scope-invalid");
    assert!(token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
        && fs::read(root.join(AUTHORITY_FILE)).unwrap() == token.as_bytes(),
        "macos-keychain-record-child-scope-invalid");
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_file(),
        "macos-keychain-record-child-scope-invalid");
    assert!(matches!(action.as_str(), "replace-same" | "replace-different" | "rename-then-replace" | "reopen" | "recreate-keychain"),
        "macos-keychain-record-child-scope-invalid");
    // Bound this descendant independently of the parent's 120-second budget.
    // No join: on ordinary completion libtest exits before this timer fires.
    let _watchdog = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(60));
        std::process::exit(86);
    });
    let _interaction = SecKeychain::disable_user_interaction().unwrap();
    let mut keychain = SecKeychain::open(&path).unwrap();
    keychain.unlock(Some(PASSWORD)).unwrap();
    let account = account_for(&app).unwrap();
    let (password, item) = keychain.find_generic_password(SERVICE, &account).unwrap();
    assert!(password.as_ref() == ORIGINAL, "macos-keychain-record-child-source-invalid");
    drop(password);
    diagnostic(CHILD_PHASES[0]);
    let expected = match action.as_str() {
        "rename-then-replace" => {
            let renamed_account = format!("{account}-renamed");
            let mut attributes = [
                KeychainAttribute { tag: u32::from_be_bytes(*b"svce"), length: RENAMED_SERVICE.len() as u32,
                    data: RENAMED_SERVICE.as_ptr() as *mut std::ffi::c_void },
                KeychainAttribute { tag: u32::from_be_bytes(*b"acct"), length: renamed_account.len() as u32,
                    data: renamed_account.as_ptr() as *mut std::ffi::c_void },
            ];
            let list = KeychainAttributeList { count: attributes.len() as u32, attr: attributes.as_mut_ptr() };
            // NULL data is essential: Apple's attributes-only path modifies
            // the existing SSGroup/row; supplying data can delete and reinsert.
            let status = unsafe { SecKeychainItemModifyAttributesAndData(item.as_CFTypeRef(), &list, 0, std::ptr::null()) };
            assert_eq!(status, 0, "macos-keychain-record-child-rename-failed");
            drop(item);
            let missing = keychain.find_generic_password(SERVICE, &account).err()
                .expect("macos-keychain-record-child-old-key-remained");
            assert_eq!(missing.code(), ITEM_NOT_FOUND, "macos-keychain-record-child-old-key-remained");
            let (renamed, _) = keychain.find_generic_password(RENAMED_SERVICE, &renamed_account).unwrap();
            assert!(renamed.as_ref() == ORIGINAL, "macos-keychain-record-child-renamed-source-invalid");
            drop(renamed);
            diagnostic(CHILD_PHASES[4]);
            keychain.add_generic_password(SERVICE, &account, DIFFERENT).unwrap();
            diagnostic(CHILD_PHASES[2]);
            DIFFERENT
        }
        "replace-same" | "replace-different" => {
            item.delete();
            let missing = keychain.find_generic_password(SERVICE, &account).err()
                .expect("macos-keychain-swap-delete-unconfirmed");
            assert_eq!(missing.code(), ITEM_NOT_FOUND, "macos-keychain-swap-delete-unconfirmed");
            diagnostic(CHILD_PHASES[1]);
            let replacement = if action == "replace-same" { ORIGINAL } else { DIFFERENT };
            keychain.add_generic_password(SERVICE, &account, replacement).unwrap();
            diagnostic(CHILD_PHASES[2]);
            replacement
        }
        "recreate-keychain" => {
            // The source item was read as ORIGINAL above. Confirm the handle
            // names the same existing file before deleting that whole fixture.
            assert!(keychain_path(&keychain) == path,
                "macos-keychain-record-child-keychain-source-path-mismatch");
            assert!(matches!(fs::symlink_metadata(&path), Ok(metadata) if metadata.file_type().is_file()),
                "macos-keychain-record-child-source-invalid");
            drop(item);
            let status = unsafe { SecKeychainDelete(keychain.as_CFTypeRef()) };
            assert_eq!(status, 0, "macos-keychain-record-child-keychain-delete-failed");
            drop(keychain);
            assert!(matches!(fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
                "macos-keychain-record-child-keychain-delete-unconfirmed");
            diagnostic(CHILD_PHASES[1]);
            let mut options = CreateOptions::new();
            options.password(PASSWORD).prompt_user(false);
            keychain = options.create(&path).unwrap();
            keychain.unlock(Some(PASSWORD)).unwrap();
            assert!(keychain_path(&keychain) == path,
                "macos-keychain-record-child-keychain-recreated-path-mismatch");
            let missing = keychain.find_generic_password(SERVICE, &account).err()
                .expect("macos-keychain-record-child-keychain-not-new");
            assert_eq!(missing.code(), ITEM_NOT_FOUND, "macos-keychain-record-child-keychain-not-new");
            keychain.add_generic_password(SERVICE, &account, DIFFERENT).unwrap();
            diagnostic(CHILD_PHASES[2]);
            DIFFERENT
        }
        "reopen" => { drop(item); ORIGINAL }
        _ => unreachable!(),
    };
    let (password, _) = keychain.find_generic_password(SERVICE, &account).unwrap();
    assert!(password.as_ref() == expected, "macos-keychain-record-child-target-invalid");
    diagnostic(CHILD_PHASES[3]);
    println!("{CHILD_DONE}");
}
