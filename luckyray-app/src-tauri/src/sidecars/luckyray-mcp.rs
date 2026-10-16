fn main() {
    std::process::exit(luckyray_app_lib::tool_mcp::run(std::env::args_os().skip(1)));
}
