// Diagnostic-only observation for pinned tauri-driver 2.1.0. No requests/retries.
use std::error::Error as StdError;
use std::io::{ErrorKind, Write};

pub fn emit(error: &hyper_util::client::legacy::Error) {
  let mut current: Option<&(dyn StdError + 'static)> = Some(error);
  let mut hyper_kind = "NONE";
  let mut io_kind = "NONE";
  let mut depth = 0;
  while let Some(value) = current {
    if depth == 8 { break; }
    depth += 1;
    if let Some(value) = value.downcast_ref::<hyper::Error>() {
      if hyper_kind == "NONE" {
        hyper_kind = if value.is_incomplete_message() { "INCOMPLETE_MESSAGE" }
          else if value.is_canceled() { "CANCELED" }
          else if value.is_closed() { "CLOSED" }
          else if value.is_timeout() { "TIMEOUT" }
          else if value.is_parse() { "PARSE" }
          else if value.is_body_write_aborted() { "BODY_WRITE_ABORTED" }
          else if value.is_user() { "USER" }
          else { "OTHER" };
      }
    }
    if let Some(value) = value.downcast_ref::<std::io::Error>() {
      io_kind = match value.kind() {
        ErrorKind::ConnectionRefused => "CONNECTION_REFUSED",
        ErrorKind::ConnectionReset => "CONNECTION_RESET",
        ErrorKind::ConnectionAborted => "CONNECTION_ABORTED",
        ErrorKind::BrokenPipe => "BROKEN_PIPE",
        ErrorKind::TimedOut => "TIMEOUT",
        ErrorKind::NotConnected => "NOT_CONNECTED",
        ErrorKind::UnexpectedEof => "UNEXPECTED_EOF",
        ErrorKind::WouldBlock => "WOULD_BLOCK",
        _ => "OTHER",
      };
    }
    current = value.source();
  }
  let _ = writeln!(std::io::stdout().lock(), "[luckyray-forward-v1] connect={} hyper={} io={} depth={} truncated={}",
    error.is_connect(), hyper_kind, io_kind, depth, current.is_some());
}
