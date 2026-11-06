//! Synthetic process tree for extension job completion ordering tests.
use std::{path::PathBuf,process::{Command,Stdio},time::{Duration,Instant}};
fn main(){
 let mut args=std::env::args().skip(1);let mode=args.next();let signal=args.next().map(PathBuf::from);
 match mode.as_deref(){
  Some("leaf")=>{let signal=signal.expect("signal path");let deadline=Instant::now()+Duration::from_secs(15);while !signal.exists(){if Instant::now()>=deadline{std::process::exit(3);}std::thread::sleep(Duration::from_millis(10));}},
  Some("parent")=>{let signal=signal.expect("signal path");let child=Command::new(std::env::current_exe().unwrap()).arg("leaf").arg(&signal).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();std::fs::write(signal.with_extension("pid"),child.id().to_string()).unwrap();println!("parent-output");},
  Some("short")=>println!("short-output"),
  _=>std::process::exit(2),
 }
}
