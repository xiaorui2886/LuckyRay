/*
 * Disposable-runner probe only. It is not included in any product bundle.
 *
 * Explore whether unprivileged PID/user namespaces can enforce one part of
 * the Windows Job lifecycle: a namespace-init process bound to its parent's
 * death causes the kernel to kill even setsid() descendants. This does not
 * implement the product supervisor, signed runtime, or StableFileLease.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif

enum { STACK_SIZE = 1024 * 1024, WAIT_MS = 15000 };

struct init_args {
    int sync_read;
    int sync_write;
    int parent_pidfd;
    int events_write;
};

static int pidfd_open_local(pid_t pid) {
    return (int)syscall(SYS_pidfd_open, pid, 0);
}

static int ready(int fd, int timeout_ms) {
    struct pollfd entry = { .fd = fd, .events = POLLIN };
    int result;
    do { result = poll(&entry, 1, timeout_ms); } while (result < 0 && errno == EINTR);
    return result > 0 && (entry.revents & (POLLIN | POLLHUP));
}

static int write_map(pid_t pid, const char *name, const char *value) {
    char filename[128];
    int length = snprintf(filename, sizeof(filename), "/proc/%ld/%s", (long)pid, name);
    if (length <= 0 || (size_t)length >= sizeof(filename)) return -1;
    int fd = open(filename, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t expected = strlen(value);
    ssize_t written = write(fd, value, expected);
    int saved = errno;
    close(fd);
    errno = saved;
    return written == (ssize_t)expected ? 0 : -1;
}

static int map_identity(pid_t pid) {
    char value[80];
    snprintf(value, sizeof(value), "0 %lu 1\n", (unsigned long)getuid());
    if (write_map(pid, "uid_map", value) != 0) return -1;
    if (write_map(pid, "setgroups", "deny\n") != 0 && errno != ENOENT) return -1;
    snprintf(value, sizeof(value), "0 %lu 1\n", (unsigned long)getgid());
    return write_map(pid, "gid_map", value);
}

/* The procfs mount belongs to the outer namespace, so /proc/self names the
 * host-visible pid, allowing the outer observer to poll the correct pidfd. */
static long outer_pid(void) {
    char value[48] = {0};
    ssize_t count = readlink("/proc/self", value, sizeof(value) - 1);
    if (count <= 0 || (size_t)count >= sizeof(value)) return -1;
    value[count] = '\0';
    char *end = NULL;
    long pid = strtol(value, &end, 10);
    return end && *end == '\0' && pid > 1 ? pid : -1;
}

static int drop_caps(void) {
    for (int cap = 0; cap < 64; ++cap) {
        if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) return -1;
    }
    struct __user_cap_header_struct header = {
        .version = _LINUX_CAPABILITY_VERSION_3,
        .pid = 0
    };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, data) != 0) return -1;
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
}

static int namespace_init(void *raw) {
    struct init_args args = *(struct init_args *)raw;
    close(args.sync_write);
    char signal_byte = 0;
    if (read(args.sync_read, &signal_byte, 1) != 1 || signal_byte != 'g') _exit(80);
    close(args.sync_read);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) _exit(81);
    struct pollfd parent = { .fd = args.parent_pidfd, .events = POLLIN };
    /* An error or an already-dead parent both fail closed before any worker. */
    if (poll(&parent, 1, 0) != 0) _exit(81);
    close(args.parent_pidfd);
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) _exit(82);
    pid_t worker = fork();
    if (worker < 0) _exit(83);
    if (worker == 0) {
        if (drop_caps() != 0 || setsid() < 0) _exit(84);
        if (ptrace(PTRACE_ATTACH, 1, NULL, NULL) == 0) {
            (void)ptrace(PTRACE_DETACH, 1, NULL, NULL);
            dprintf(args.events_write, "E ptrace\n");
            _exit(85);
        }
        long target = outer_pid();
        if (target < 0) _exit(86);
        dprintf(args.events_write, "T %ld\n", target);
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(87);
        if (grandchild == 0) {
            if (setsid() < 0) _exit(88);
            long id = outer_pid();
            if (id < 0) _exit(89);
            dprintf(args.events_write, "G %ld\n", id);
            for (;;) pause();
        }
        for (;;) pause();
    }
    close(args.events_write);
    while (waitpid(-1, NULL, 0) > 0 || errno == EINTR) {}
    _exit(0);
}

static void launch(int event_fd) {
    int parent_pidfd = pidfd_open_local(getpid());
    int sync_pipe[2];
    if (parent_pidfd < 0 || pipe2(sync_pipe, O_CLOEXEC) != 0) {
        dprintf(event_fd, "B pidfd-or-pipe\n");
        _exit(77);
    }
    void *stack = malloc(STACK_SIZE);
    if (!stack) { dprintf(event_fd, "E memory\n"); _exit(1); }
    struct init_args args = { sync_pipe[0], sync_pipe[1], parent_pidfd, event_fd };
    pid_t init = clone(namespace_init, (char *)stack + STACK_SIZE,
                       CLONE_NEWUSER | CLONE_NEWPID | SIGCHLD, &args);
    if (init < 0) {
        dprintf(event_fd, "B clone-%d\n", errno);
        _exit(77);
    }
    close(sync_pipe[0]);
    if (map_identity(init) != 0) {
        int reason = errno;
        (void)kill(init, SIGKILL);
        (void)waitpid(init, NULL, 0);
        dprintf(event_fd, "B uid-map-%d\n", reason);
        _exit(77);
    }
    dprintf(event_fd, "I %ld\n", (long)init);
    if (write(sync_pipe[1], "g", 1) != 1) _exit(1);
    close(sync_pipe[1]);
    close(parent_pidfd);
    close(event_fd);
    for (;;) pause();
}

int main(void) {
    int events[2];
    if (pipe2(events, O_CLOEXEC) != 0) return 1;
    pid_t launcher = fork();
    if (launcher < 0) return 1;
    if (launcher == 0) { close(events[0]); launch(events[1]); }
    close(events[1]);

    FILE *input = fdopen(events[0], "r");
    if (!input) { kill(launcher, SIGKILL); waitpid(launcher, NULL, 0); return 1; }
    setvbuf(input, NULL, _IONBF, 0);
    long init = 0, target = 0, grandchild = 0;
    int status = 1;
    int init_fd = -1, target_fd = -1, child_fd = -1;
    for (int line_count = 0; line_count < 4 && (!init || !target || !grandchild); ++line_count) {
        char line[128];
        if (!ready(events[0], WAIT_MS) || !fgets(line, sizeof(line), input)) break;
        if (line[0] == 'B') {
            fprintf(stderr, "BLOCKED: unprivileged namespace or pidfd unavailable (%s)", line + 2);
            status = 77;
            goto done;
        }
        if (line[0] == 'E') { fprintf(stderr, "FAIL: %s", line + 2); goto done; }
        long value = 0;
        if (sscanf(line + 2, "%ld", &value) != 1 || value <= 1) goto done;
        if (line[0] == 'I') {
            init = value;
            /* Retain a stable handle as soon as the synthetic init is known,
             * so early failures can terminate it without a PID-reuse race. */
            init_fd = pidfd_open_local((pid_t)init);
            if (init_fd < 0) goto done;
        }
        else if (line[0] == 'T') target = value;
        else if (line[0] == 'G') grandchild = value;
        else goto done;
    }
    if (!init || !target || !grandchild) goto done;
    target_fd = pidfd_open_local((pid_t)target);
    child_fd = pidfd_open_local((pid_t)grandchild);
    if (init_fd < 0 || target_fd < 0 || child_fd < 0) goto done;
    if (ready(init_fd, 0)) goto done;
    /* Only the synthetic launcher created by this test is signalled. */
    if (kill(launcher, SIGKILL) != 0) goto done;
    (void)waitpid(launcher, NULL, 0);
    launcher = -1;
    if (!ready(init_fd, WAIT_MS) || !ready(target_fd, WAIT_MS) || !ready(child_fd, WAIT_MS)) goto done;
    puts("PASS: parent death stopped the namespace init and two setsid descendants");
    status = 0;
done:
    if (launcher > 0) { (void)kill(launcher, SIGKILL); (void)waitpid(launcher, NULL, 0); }
    if (init_fd >= 0 && !ready(init_fd, 0)) {
        /* Cleanup only the probe's own pidfd-bound init. PID namespace exit
         * then kills its synthetic children, including those that called setsid. */
        if (syscall(SYS_pidfd_send_signal, init_fd, SIGKILL, NULL, 0) != 0 && errno != ESRCH) {
            fprintf(stderr, "FAIL: could not stop synthetic namespace init (%s)\n", strerror(errno));
            status = 1;
        } else if (!ready(init_fd, WAIT_MS)) {
            fprintf(stderr, "FAIL: synthetic namespace init did not exit during cleanup\n");
            status = 1;
        }
    }
    if (init_fd >= 0) close(init_fd);
    if (target_fd >= 0) close(target_fd);
    if (child_fd >= 0) close(child_fd);
    fclose(input);
    return status;
}
