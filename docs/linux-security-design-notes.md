# Linux ownership and file-safety design notes

These notes compare Linux facilities and describe the platform's different
lifecycle and optimistic file-concurrency contract. The Linux desktop and its
sealed runtime remain incomplete.

## Process lifecycle

The unprivileged synthetic namespace test in
[run 41235425979](https://github.com/xiaorui2886/LuckyRay/actions/runs/41235425979)
successfully created a user/PID namespace, dropped worker capabilities, killed
the synthetic launcher and observed the namespace init and two `setsid`
descendants exit. This is evidence for that environment and sequence only.

Linux's [PID namespace documentation](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
describes the kernel killing namespace members when its init exits. The
[Linux 5.15 namespace teardown code](https://github.com/torvalds/linux/blob/v5.15/kernel/pid_namespace.c)
also waits for namespace processes during init teardown. A candidate design
could use an independently supervised namespace init and wait for its actual
reaping before admitting a replacement generation. That is more promising than
a process group, but it has not been implemented or shown equivalent to the
current Windows Job contract. In particular, it must still prove:

1. Assignment before any untrusted child instruction, with no escape through
   inherited descriptors, namespace handles, capabilities or process launch.
2. Owner-handle close and abrupt owner-process exit, including races and a
   multithreaded desktop. `PR_SET_PDEATHSIG` alone concerns the creating thread,
   has a setup race, and can be cleared by credential changes; see its
   [manual](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html).
3. A reliable settled-zero condition, including descendant namespaces,
   interrupted shutdown and stuck processes, on each supported kernel.
4. Compatibility with the actual sealed Node/native-addons, inherited stdio,
   browser host and permitted child execution. User namespaces may be disabled
   or restricted; failure must remain closed and must not trigger an attempt to
   change AppArmor, sysctls, privileges or system settings.

Another possible architecture is a delegated cgroup v2 and an external lifecycle
owner. The [kernel cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
describes `cgroup.kill` and descendant cleanup, but normal user processes
cannot assume a writable delegated cgroup or automatic cleanup when their own
handle closes. A system-managed/delegated supervisor would be an explicit
product and installation choice, not a hidden prerequisite.

## Runtime files and notes

Linux [`flock`](https://man7.org/linux/man-pages/man2/flock.2.html) on ordinary
local files is advisory. Linux [file leases](https://man7.org/linux/man-pages/man2/F_SETLEASE.2const.html)
can be broken and do not by themselves secure every directory name and inode
for an entire multi-file runtime use window. Mode bits on files owned by the
same OS user do not prevent that user from changing those bits. The successful
`O_TMPFILE` experiment binds one new file to a directory descriptor and refuses
an existing target name; it does not establish trusted parent acquisition,
prevention of external writes/deletes, or an exclusive existing-note update.

Potential directions need separate threat-model and compatibility review:

- Protected, separately owned storage and/or a broker could keep ordinary
  user processes from modifying the runtime, but installation and access policy
  would become a visible product decision. Existing user-owned note folders
  and external editors would need a separately specified access model.
- Sealed in-memory file descriptors may help for individual immutable inputs,
  but the Node closure and native modules currently resolve many paths and
  dependencies. A descriptor-based redesign must prove the entire launch and
  module-loading chain; sealing a single executable is insufficient.
- Optimistic conflict detection is the Linux note-write contract. External
  edits are handled through conflict detection and retained recovery material;
  this does not provide mandatory exclusion for the whole edit window.
- New attachments and their staging files are created 0600 inside an owned
  Vault root; a published name is never overwritten. Material deletion proves
  object identity before quarantine and again before permanent delete, and
  keeps the file when it cannot. These checks, like the others, do not stop a
  same-user process between checks.

The current Linux implementation uses process groups and descriptor-relative,
optimistic file transactions with independent backups and recovery journals.
It detects observed conflicts and preserves recovery material, while accepting
the escaped-descendant, abrupt-exit and same-user modification limitations
described above. No privileged broker or system configuration change is used.
See [Linux integration](linux-desktop-port-notes.md) for the implemented paths
and remaining runtime requirements. The namespace experiments remain historical
investigation evidence and are not product lifecycle authority.
