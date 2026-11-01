//! Test the production GIO entry with an isolated, synthetic desktop handler.
//! No user's MIME association or desktop process is changed.

use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        // This name was created exclusively for this test under the temp directory.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn wait_until(deadline: Instant, mut condition: impl FnMut() -> bool) -> bool {
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "invoked by production_gio_uses_isolated_registered_directory_handler"]
fn invoke_production_gio_in_isolated_environment() {
    let directory = std::env::var_os("LUCKYRAY_TEST_DIRECTORY").unwrap();
    super::linux_directory::open(Path::new(&directory)).unwrap();
}

#[test]
fn production_gio_uses_isolated_registered_directory_handler() {
    let unique = format!(
        "luckyray-gio-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let fixture = Fixture(root);
    let config = fixture.0.join("config");
    let data = fixture.0.join("data");
    let applications = data.join("applications");
    let empty = fixture.0.join("empty");
    let directory = fixture.0.join("目录 #100%");
    for path in [&config, &data, &applications, &empty, &directory] {
        std::fs::create_dir(path).unwrap();
    }

    let handler = fixture.0.join("handler.sh");
    let marker = fixture.0.join("called");
    std::fs::write(&handler, "printf '%s' \"$1\" > \"$LUCKYRAY_TEST_OUTPUT\"\n").unwrap();
    // Desktop Entry quoting is not shell quoting. Quote the single absolute
    // argument and escape its reserved characters and literal field codes.
    let handler = handler
        .to_str()
        .unwrap()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    std::fs::write(
        applications.join("luckyray-gio-fixture.desktop"),
        format!("[Desktop Entry]\nType=Application\nName=LuckyRay synthetic test\nExec=/bin/sh \"{handler}\" %u\nMimeType=inode/directory;\nNoDisplay=true\nTerminal=false\n"),
    ).unwrap();
    std::fs::write(
        config.join("mimeapps.list"),
        "[Default Applications]\ninode/directory=luckyray-gio-fixture.desktop;\n",
    )
    .unwrap();

    // GIO caches XDG paths, so test in a subprocess with isolated associations.
    // The empty PATH also detects any accidental direct use of xdg-open.
    let stdout_path = fixture.0.join("helper.stdout");
    let stderr_path = fixture.0.join("helper.stderr");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("linux_directory_handler_test::invoke_production_gio_in_isolated_environment")
        .arg("--ignored")
        .env("HOME", &fixture.0)
        .env("XDG_CONFIG_HOME", &config)
        .env("XDG_CONFIG_DIRS", &empty)
        .env("XDG_DATA_HOME", &data)
        .env("XDG_DATA_DIRS", &empty)
        .env("XDG_CACHE_HOME", &empty)
        .env("XDG_CURRENT_DESKTOP", "")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/nonexistent-luckyray-test",
        )
        .env("PATH", &empty)
        .env("LUCKYRAY_TEST_DIRECTORY", &directory)
        .env("LUCKYRAY_TEST_OUTPUT", &marker)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .stdout(Stdio::from(std::fs::File::create(&stdout_path).unwrap()))
        .stderr(Stdio::from(std::fs::File::create(&stderr_path).unwrap()))
        .spawn()
        .unwrap();
    let mut result = None;
    let completed = wait_until(Instant::now() + Duration::from_secs(15), || {
        result = child.try_wait().unwrap();
        result.is_some()
    });
    if !completed {
        let _ = child.kill();
        let _ = child.wait();
        panic!("synthetic GIO launch timed out");
    }
    assert!(
        result.unwrap().success(),
        "production GIO helper failed: stdout={} stderr={}",
        std::fs::read_to_string(stdout_path).unwrap_or_default(),
        std::fs::read_to_string(stderr_path).unwrap_or_default()
    );
    assert!(
        wait_until(Instant::now() + Duration::from_secs(5), || {
            std::fs::metadata(&marker)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        }),
        "synthetic registered handler was not called"
    );
    let argument = std::fs::read_to_string(&marker).unwrap();
    // The desktop-entry specification permits either a file URI or local path.
    let actual = if argument.starts_with("file:") {
        gtk::glib::filename_from_uri(&argument).unwrap().0
    } else {
        PathBuf::from(argument)
    };
    assert_eq!(actual, directory);
}
