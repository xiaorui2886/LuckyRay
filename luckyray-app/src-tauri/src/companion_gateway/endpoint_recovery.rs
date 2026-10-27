//! Explicit, bounded endpoint recovery. Never changes identity, pairing or grants.
use super::*;

const MAX_BIND_ATTEMPTS: u8 = 4;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointRecoveryEnvelope {
    schema: u8,
    kind: &'static str,
    base_url: String,
    desktop_instance_id: String,
    certificate_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointRecoveryPresentation {
    envelope: EndpointRecoveryEnvelope,
    qr_size: usize,
    qr_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindFailure {
    stage: &'static str,
    kind: &'static str,
    os_code: Option<i32>,
    attempts: u8,
}

impl BindFailure {
    pub(super) fn new(kind: ErrorKind, os_code: Option<i32>, attempts: u8) -> Self {
        Self { stage: "bind", kind: match kind {
            ErrorKind::AddrInUse => "address-in-use",
            ErrorKind::PermissionDenied => "access-denied",
            ErrorKind::AddrNotAvailable => "address-unavailable",
            _ => "unknown",
        }, os_code, attempts }
    }
}

pub(super) fn bind_selected_endpoint(selection: BindSelection) -> Result<TcpListener, GatewayError> {
    bind_with(selection, TcpListener::bind)
}

fn bind_with(
    selection: BindSelection,
    mut bind: impl FnMut(SocketAddrV4) -> io::Result<TcpListener>,
) -> Result<TcpListener, GatewayError> {
    // Explicit nonzero ports are attempted once. Only a user-selected new
    // endpoint (port=0) asks the OS for a bounded number of alternatives.
    let attempts = if selection.port == 0 { MAX_BIND_ATTEMPTS } else { 1 };
    for attempt in 1..=attempts {
        let socket = SocketAddrV4::new(selection.address, selection.port);
        match bind(socket) {
            Ok(listener) => {
                let actual = listener.local_addr().map_err(classify_bind_error)?;
                if actual.ip() != IpAddr::V4(selection.address) || actual.port() == 0 {
                    return Err(GatewayError::new("gateway-bind-address-unavailable", "Bound endpoint differs from the explicitly selected interface"));
                }
                if (LOCAL_TRANSPORT_PORT_START..=LOCAL_TRANSPORT_PORT_END).contains(&actual.port()) {
                    if attempt < attempts { drop(listener); continue; }
                    return Err(GatewayError::new("gateway-local-transport-port-reserved", "No allowed Companion port was selected within the bounded attempt limit"));
                }
                return Ok(listener);
            }
            Err(error) => {
                let retryable = matches!(error.kind(), ErrorKind::AddrInUse | ErrorKind::PermissionDenied);
                let mut classified = classify_bind_error(error);
                if let Some(details) = &mut classified.bind_failure { details.attempts = attempt; }
                if !retryable || attempt == attempts { return Err(classified); }
            }
        }
    }
    unreachable!("positive bounded attempt count")
}

impl CompanionGateway {
    pub(super) fn endpoint_recovery_presentation(&self) -> Result<EndpointRecoveryPresentation, GatewayError> {
        let _transition = self.try_transition()?;
        let identity = self.identity()?;
        let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
        let running = lifecycle.running.as_ref().filter(|listener| listener.is_alive())
            .ok_or_else(|| GatewayError::new("gateway-not-running", "A live listener is required to share its endpoint"))?;
        if lifecycle.stopping_generation.is_some() {
            return Err(GatewayError::new("gateway-transition-in-progress", "The listener is stopping"));
        }
        let envelope = EndpointRecoveryEnvelope {
            schema: 1,
            kind: "luckyray.endpoint-recovery",
            base_url: format!("https://{}:{}", running.address.ip(), running.address.port()),
            desktop_instance_id: identity.instance_id.clone(),
            certificate_fingerprint: identity.fingerprint.clone(),
        };
        let bytes = serde_json::to_vec(&envelope).map_err(|_| GatewayError::new("gateway-recovery-presentation-failed", "Endpoint presentation is unavailable"))?;
        let code = QrCode::new(bytes).map_err(|_| GatewayError::new("gateway-recovery-presentation-failed", "Endpoint QR is unavailable"))?;
        let mut qr_path = String::with_capacity(code.width() * code.width() * 7);
        for y in 0..code.width() { for x in 0..code.width() {
            if code[(x, y)] == QrColor::Dark { let _ = write!(qr_path, "M{x} {y}h1v1h-1z"); }
        }}
        Ok(EndpointRecoveryPresentation { envelope, qr_size: code.width(), qr_path })
    }

    pub(crate) fn recover_endpoint(
        self: &Arc<Self>,
        expected_address: &str,
        expected_port: u16,
        confirmed: bool,
    ) -> Result<GatewayStatus, GatewayError> {
        let _transition = self.try_transition()?;
        if !confirmed {
            return Err(GatewayError::new("gateway-recovery-confirmation-required", "Confirm the same-interface endpoint change before recovery"));
        }
        {
            let lifecycle = self.lifecycle.lock().expect("companion lifecycle mutex");
            let config = lifecycle.resume_config.as_ref().ok_or_else(|| GatewayError::new("gateway-recovery-state-changed", "No saved endpoint is awaiting recovery"))?;
            if config.bind_address != expected_address || config.port != expected_port
                || lifecycle.running.is_some() || lifecycle.stopping_generation.is_some() {
                return Err(GatewayError::new("gateway-recovery-state-changed", "The saved endpoint changed; refresh before confirming recovery"));
            }
            if !lifecycle.resume_error.as_ref().is_some_and(|error| matches!(error.code,
                "gateway-bind-conflict" | "gateway-bind-access-denied" | "firewall/manual-permission-required" | "gateway-local-transport-port-reserved")) {
                return Err(GatewayError::new("gateway-recovery-not-port-related", "This failure does not establish that selecting another port can help"));
            }
        }
        // start_exclusive commits the actual bound address only after bind/TLS
        // validation. Failure retains the original saved endpoint and identity.
        self.start_recording_failure(expected_address, Some(0))
    }
}

#[tauri::command]
pub(crate) fn companion_gateway_endpoint_recovery_presentation(
    caller: tauri::Webview,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<EndpointRecoveryPresentation, GatewayError> {
    require_main_caller(&caller)?;
    gateway.inner().endpoint_recovery_presentation()
}

#[tauri::command]
pub(crate) fn companion_gateway_recover_endpoint(
    caller: tauri::Webview,
    expected_address: String,
    expected_port: u16,
    confirmed: bool,
    gateway: tauri::State<'_, Arc<CompanionGateway>>,
) -> Result<GatewayStatus, GatewayError> {
    require_main_caller(&caller)?;
    let interfaces = list_lan_ipv4_interfaces()?;
    validate_management_bind_address(&expected_address, &interfaces)?;
    gateway.inner().recover_endpoint(&expected_address, expected_port, confirmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_port_is_not_silently_changed_or_stolen() {
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut calls = 0;
        let result = bind_with(BindSelection { address: Ipv4Addr::LOCALHOST, port: held.local_addr().unwrap().port() }, |address| { calls += 1; TcpListener::bind(address) });
        let error = result.unwrap_err();
        assert_eq!(calls, 1);assert_eq!(error.code, "gateway-bind-conflict");
        assert_eq!(error.bind_failure.unwrap().attempts, 1);
        assert!(held.local_addr().is_ok());
    }

    #[test]
    fn controlled_binding_denial_is_bounded_and_reports_the_real_category() {
        let mut calls = 0;
        let error = bind_with(BindSelection { address: Ipv4Addr::LOCALHOST, port: 0 }, |_| {
            calls += 1;Err(io::Error::new(ErrorKind::PermissionDenied, "synthetic-no-policy-change"))
        }).unwrap_err();
        assert_eq!(calls, MAX_BIND_ATTEMPTS);assert_eq!(error.code, "gateway-bind-access-denied");
        let details = error.bind_failure.unwrap();assert_eq!(details.kind, "access-denied");assert_eq!(details.os_code, None);assert_eq!(details.attempts, 4);
    }

    #[test]
    fn unknown_or_missing_interface_failures_do_not_scan_ports() {
        for kind in [ErrorKind::AddrNotAvailable, ErrorKind::Other] {
            let mut calls = 0;
            let error = bind_with(BindSelection { address: Ipv4Addr::LOCALHOST, port: 0 }, |_| { calls += 1;Err(io::Error::new(kind, "synthetic")) }).unwrap_err();
            assert_eq!(calls, 1);
            assert_eq!(error.bind_failure.unwrap().kind, if kind == ErrorKind::AddrNotAvailable { "address-unavailable" } else { "unknown" });
        }
    }

    #[test]
    fn an_explicit_new_endpoint_keeps_the_selected_interface() {
        let mut calls = 0;
        let listener = bind_with(BindSelection { address: Ipv4Addr::LOCALHOST, port: 0 }, |address| {
            calls += 1;if calls == 1 { Err(io::Error::new(ErrorKind::PermissionDenied, "synthetic")) } else { TcpListener::bind(address) }
        }).unwrap();
        assert!(calls <= 4);assert_eq!(listener.local_addr().unwrap().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));assert_ne!(listener.local_addr().unwrap().port(), 0);
    }
}
