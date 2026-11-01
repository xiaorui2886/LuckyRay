# Linux per-user desktop integration

Autostart and browser registration use the current running Linux executable's
kernel object identity. They hold its file and parent directory, reject linked
or unsafe source paths, and recheck the object around writes. These checks do
not establish a release signature or replace sidecar package preparation.

## Autostart

The existing application settings commands manage
`$XDG_CONFIG_HOME/autostart/com.luckyray.desktop.desktop`, falling back to
`$HOME/.config`. Enabling writes a quoted absolute `Exec` path without a shell
or `PATH` lookup. Disabling retains the entry with `Hidden=true`, as defined by
the [XDG autostart specification](https://specifications.freedesktop.org/autostart/0.5/).
A status read does not create directories, locks or recovery files. Disabling
an absent user entry does not create one.

Writes require a matching managed entry. Foreign content, links, shared writable
directories and unsupported ACLs or extended attributes produce an error without
overwriting the entry. Existing file mode and group are preserved. Both the
previous inode and an independent byte copy remain available after a change.
Interrupted transactions report recovery required on reads; an explicit mutation
can recover only this entry and its exact enabled/disabled payload family.
An external replacement is retained and reported as a conflict.

## Native Messaging registration

Run the installed `luckyray-native-host` as the desktop user, with exactly one
browser name: `chrome`, `chromium`, `edge` or `chrome-for-testing`.

```sh
/absolute/install/path/luckyray-native-host --install-linux-manifest chromium
/absolute/install/path/luckyray-native-host --revoke-linux-registration chromium
```

The installer creates the selected browser's per-user `NativeMessagingHosts`
directory beneath the existing configuration root. It respects the supported
Chrome configuration environment variables and does not modify system-wide
registrations. New manifests use an unnamed inode and no-replace publication;
filesystems without that operation return an error. The manifest has a fixed
host name, the actual running binary's absolute path and the compiled extension
origin list. See the [Chrome Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
for the browser's registration format.

Revocation changes only the exact managed manifest to an empty
`allowed_origins` list. Reinstallation can re-enable that managed record.
Both operations retain backups and prior inodes, preserve file mode/group and
refuse foreign records, links, unsupported attributes or conflicting recovery
records. Repeated commands return an explicit already-installed, already-revoked
or absent outcome. Revoking an absent registration does not create a profile.

Registration does not issue a local-transport credential or approve an extension's
data-access grant. Registration revocation does not disconnect an already-running
client or revoke those separate grants; the application retains its existing
explicit origin-revocation action. Actual browser connection and refusal behavior
still require browser integration testing.

## Current boundaries

Both integrations reject root execution. Configuration paths must have safe
owners and permissions with no symlink components. An `APPIMAGE` environment
value alone cannot prove the persistent carrier of the running executable, so
AppImage autostart and Native Messaging registration return an explicit error
until carrier binding is implemented. No installer currently provisions these
integrations automatically.

File operations use optimistic conflict detection and recovery, rather than
mandatory exclusion against other processes of the same user. No privileged
service or system security change is required.
