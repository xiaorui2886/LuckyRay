//! Turn-scoped, read-only Agent Browser runtime.

mod gateway;
mod runtime;

pub(crate) use runtime::{
    AgentBrowserError, AgentBrowserRuntime, AgentBrowserScopeLease, AgentBrowserViewport,
};

#[cfg(feature = "browser-host-poc-fixture")]
pub mod test_support {
    use super::gateway::{GatewayPolicy, ValidatingGateway};
    use std::net::SocketAddr;

    /// Product gateway fixture for the real WebView2 integration contract.
    /// The loopback exception exists only in the explicit fixture feature.
    pub struct AgentBrowserGatewayFixture(ValidatingGateway);

    impl AgentBrowserGatewayFixture {
        pub fn start_exact_loopback(origin: SocketAddr) -> Result<Self, &'static str> {
            ValidatingGateway::start(GatewayPolicy::exact_loopback_for_fixture(origin)).map(Self)
        }

        pub fn address(&self) -> SocketAddr {
            self.0.address()
        }

        pub fn control_token(&self) -> &str {
            self.0.control_token()
        }
    }
}
