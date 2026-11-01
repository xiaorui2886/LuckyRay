# Linux browser extension connection

Linux uses the registered Native Messaging host to bootstrap an extension
connection. The host first verifies the loopback server with the private native
credential. LuckyRay Main then requires an explicit decision for the configured
extension origin. Anonymous HTTP bootstrap cannot issue an extension credential
or create an approval prompt on Linux.

For an installed, stable Linux native-host executable, register the intended
per-user browser explicitly, for example:

```sh
/path/to/luckyray-native-host --install-linux-manifest chromium
```

Supported selectors are `chrome`, `chromium`, `edge` and `chrome-for-testing`.
The existing checked registration transaction preserves displaced files and
backups. Registration does not approve an extension's application-data access.
AppImage registration still requires a supported persistent carrier binding;
an unverified mounted executable is refused.

In the extension, request a connection. In LuckyRay **Settings → General →
Browser extension connection**, inspect the exact extension origin and choose
whether to allow it. A pending request expires after five minutes. Main can
permit a new request after denial or revocation; this does not grant access.
Pending and blocked request references belong to the current Main instance and
are discarded on app restart. Access remains unavailable until a fresh request
is explicitly approved. Durable approved grants survive app reopening.
Approval is bound to the observed request identifier and compiled allowlist.

The browser's own `runtime.getPlatformInfo` selects the Linux Native Messaging
path. Anonymous health responses cannot select an authentication downgrade. The
returned endpoint is checked before a credential is sent to the proof endpoint.
Native bootstrap bypasses HTTP proxies and uses the matched runtime profile;
diagnostic development binaries cannot borrow a production credential file.

Revoking access in Main removes the durable connection grant. Subsequent
authentication and bootstrap requests fail. Reapproval creates a new credential;
an old credential or bound connection cannot regain access. Already accepted
business operations are not rolled back by connection revocation. Independent
library and feature permissions continue to apply.

Native-host registration can separately be disabled with:

```sh
/path/to/luckyray-native-host --revoke-linux-registration chromium
```

That changes future browser host lookup. Main's access-revocation action is
needed to invalidate a credential already held by an extension. The consent
snapshot contains origins and opaque request/grant references, without native
or extension credentials. Only the trusted Main document can manage it.

This connection path is separate from the embedded Personal Browser's native
window host. It does not enable agent automation in a personal browser.

Protocol references: [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
and [runtime.getPlatformInfo](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getPlatformInfo).
