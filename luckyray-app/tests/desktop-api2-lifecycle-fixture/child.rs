//! Synthetic fixture: either wait as an extension child or watch one such PID.
use std::{env, fs, io::{self, Write}, process, thread, time::Duration};

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, id: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, timeout: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("wait") => {
            println!("fixture-ready:{}", process::id());
            io::stdout().flush().unwrap();
            thread::sleep(Duration::from_secs(120));
        }
        #[cfg(windows)]
        Some("watch") => unsafe {
            let pid: u32 = args[2].parse().unwrap();
            let handle = OpenProcess(0x0010_0000, 0, pid); // SYNCHRONIZE
            if handle.is_null() || WaitForSingleObject(handle, 0) != 258 {
                if !handle.is_null() { CloseHandle(handle); }
                eprintln!("fixture-child-was-not-running");
                process::exit(2);
            }
            let mut ack = fs::OpenOptions::new().write(true).create_new(true).open(&args[3]).unwrap();
            ack.write_all(b"watching").unwrap();
            let result = WaitForSingleObject(handle, 20_000);
            CloseHandle(handle);
            if result != 0 { eprintln!("fixture-child-did-not-exit:{result}"); process::exit(3); }
            println!("fixture-child-signaled");
        },
        _ => process::exit(2),
    }
}
