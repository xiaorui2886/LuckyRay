//! An uninhabited host handle until macOS runtime sealing and process
//! ownership are implemented. This module cannot launch or attest a host.
use super::DshNativeSurfaceBootstrap;
use std::convert::Infallible;
use std::time::Duration;

pub(super) struct HostHandle {
    pub(super) surface_binding_generation: u64,
    _unavailable: Infallible,
}

impl HostHandle {
    pub(super) fn process_id(&self) -> Option<u32> {
        match self._unavailable {}
    }
    pub(super) fn generation(&self) -> u64 {
        match self._unavailable {}
    }
    pub(super) fn is_running(&self) -> bool {
        match self._unavailable {}
    }
    pub(super) fn diagnostic_only(&self, _generation: u64) -> bool {
        match self._unavailable {}
    }
    pub(super) fn validate_host(&mut self) -> bool {
        match self._unavailable {}
    }
    pub(super) fn shutdown(self) -> bool {
        match self._unavailable {}
    }
    pub(super) fn open_surface(&mut self) -> Result<DshNativeSurfaceBootstrap, String> {
        match self._unavailable {}
    }
    pub(super) fn close_surface(&mut self) -> Result<(), ()> {
        match self._unavailable {}
    }
    pub(super) fn compat_request(
        &mut self,
        _kind: &str,
        _payload: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        match self._unavailable {}
    }
    pub(super) fn remote_request(
        &mut self,
        _kind: &str,
        _payload: &serde_json::Value,
        _expected: &str,
        _timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        match self._unavailable {}
    }
    pub(super) fn update_request(
        &mut self,
        _kind: &str,
        _id: &str,
    ) -> Result<serde_json::Value, &'static str> {
        match self._unavailable {}
    }
}
