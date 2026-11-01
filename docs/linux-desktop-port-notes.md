# Linux desktop integration

The target is x86_64-unknown-linux-gnu on an Ubuntu 22.04 build baseline.
The source is an incomplete desktop candidate. A diagnostic executable can
exclude bundle inputs to investigate native code and UI behavior; it does not
establish resource identity, signed-runtime or package admission.

## Process lifecycle

Linux uses a separate process group created before exec. The executable is an
absolute, no-follow, single-link ELF opened through a held directory and executed
via its descriptor. Environment inheritance is cleared, and stdin/stdout/stderr
are explicit pipes.

The parent retains its unreaped group leader with waitid(WNOWAIT) while the
authority is live. This reserves the numeric leader/group identity. Normal
shutdown can signal the group and inspect its remaining non-zombie members;
loss of the child wait authority is treated as unknown and disables signaling
through that numeric ID. Closing the group authority attempts cleanup, and a
reaper thread handles the application's own leader.

A descendant may escape with setsid/setpgid. Abrupt desktop death can leave
tools running. A successful group-settlement sample covers that original
group, rather than all possible descendants. No user namespace, delegated
cgroup, service or additional privilege is required by this implementation.

## File commits and recovery

Linux path traversal opens every directory component without following links.
Regular files are opened nonblocking and without following the final name,
then checked for type, link count and filesystem object identity. Directory
identity is checked again at operation boundaries. These checks detect observed
changes; they cannot stop another process running as the same user from editing
or renaming objects between checks.

Writes compare the loaded object and content, create an independent durable
backup, draft and journal, move the old object to a separate recovery name,
and publish the new object with a no-replace rename. The moved and published
objects are checked again. Participating writers use a nonblocking advisory
directory lock. External edits and interrupted commits retain recovery files.

Startup recovery restores a validated prior object only into a vacant name.
An unrelated current file is retained and requires conflict review. Completed
writes retain backup copies and receipts. A draft retained after interrupted
recovery can be recovered manually. Automatic backup retention/cleanup and a
dedicated backup browser are not implemented. Note deletion retains an
independent copy and a deletion-attempt receipt.

Replacement preserves ordinary POSIX mode and group through opened descriptors.
Access ACLs, default directory ACLs, labels and extended file attributes are not
yet supported by the replacement path: it refuses them before changing the
target rather than dropping restrictions. Newly private profiles and credential
files also reject extended attributes. Existing inode paths are retained, so
an external editor's delayed writes remain recoverable in the displaced file.
Recovery restores that original inode; a missing original requires review of
the retained copy rather than guessing its original permissions.

## Credentials

Linux credentials use the same serialized authority and origin allowlist as
the other desktop backends. Their app-owned profile must belong to the current
user and have private directory permissions; credential files must be
single-link, user-owned regular files without group/other access. Existing
unsafe permissions or links are rejected without changing them.

Reads and writes use held directory descriptors. Persistence compares the
version loaded by that authority instance and retains recovery evidence.
Credential derivation rechecks the loaded credential/grant records, so an
instance with an observed stale rotation or grant change refuses authentication
until it reloads. A native host's read does not create a missing profile or
credential. Generic arbitrary-path manifest writing remains rejected on Linux;
the scoped installer uses its separate no-replace registration path.

## Runtime and graphical coverage

Linux runtime file leases retain descriptors, metadata and content digests and
revalidate them at use boundaries. They detect changes and do not provide
Windows mandatory exclusion for the whole use window.

The sealed Linux LSH closure, host lifecycle integration, request-mediated
browser host, Python, FFmpeg and redistribution inventories are still required.
The existing Windows records are not accepted as Linux runtime identities.
The current LSH descriptor/host paths remain unavailable until that actual
platform integration is implemented; directory and credential support alone
does not establish AI availability.

The Linux directory-opening command uses the desktop's GIO handler. Its
synthetic handler test validates the production GIO call, while the native
smoke script drives the real Tauri executable with WebKitWebDriver under Xvfb.
That script uses a fresh profile, synthetic notes and a PNG, and checks IPC
flows, normal exit and reopening. Neither a synthetic handler nor an IPC smoke
establishes every visible UI interaction, Wayland, hardware media or installer
behavior.

## Shared source coordination

Windows branches remain platform-gated. Shared source bytes still affect
compiled contract/adapter fingerprints, including lib.rs and tool_cli.rs.
Integrating a platform change requires rebuilding the corresponding sidecars
and reviewing their identities. The Linux branch does not update another
platform's checkout, formal publisher, version or installer.
