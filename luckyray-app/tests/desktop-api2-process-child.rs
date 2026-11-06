//! Standalone synthetic child for Windows argv, stdio and Job acceptance.
use std::io::Read;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    println!("synthetic-argv:{args:?}");
    println!("synthetic-stdout:{input}");
    eprintln!("synthetic-stderr");
    std::process::exit(7);
}
