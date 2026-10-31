/* Disposable-runner experiment; not a product note transaction.
 *
 * Explore creation from an unnamed inode through a held directory descriptor.
 * This says nothing about safely obtaining the trusted directory descriptor,
 * exclusive access to existing notes, or protecting files after publication.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *message) {
    fprintf(stderr, "FAIL: %s: %s\n", message, strerror(errno));
    return 1;
}

int main(void) {
    const char *base = getenv("RUNNER_TEMP");
    if (!base || base[0] != '/') {
        fprintf(stderr, "BLOCKED: absolute RUNNER_TEMP required\n");
        return 77;
    }
    char root[PATH_MAX];
    int count = snprintf(root, sizeof(root), "%s/luckyray-atomic-XXXXXX", base);
    if (count < 0 || (size_t)count >= sizeof(root) || !mkdtemp(root)) return fail("mkdtemp");
    int root_fd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root_fd < 0) return fail("open synthetic root");
    int result = 1, parent_fd = -1, temporary = -1, check_fd = -1;
    if (mkdirat(root_fd, "parent", 0700) != 0) goto done;
    parent_fd = openat(root_fd, "parent", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (parent_fd < 0) goto done;
    temporary = openat(parent_fd, ".", O_TMPFILE | O_WRONLY | O_CLOEXEC, 0600);
    if (temporary < 0) {
        if (errno == EOPNOTSUPP || errno == EINVAL || errno == EISDIR) {
            fprintf(stderr, "BLOCKED: filesystem does not support O_TMPFILE\n");
            result = 77;
        }
        goto done;
    }
    if (write(temporary, "synthetic note", 14) != 14 || fsync(temporary) != 0) goto done;
    struct stat source;
    if (fstat(temporary, &source) != 0) goto done;

    /* Change the pathname after opening the directory; the held descriptor
     * should still address the originally opened directory, not its replacement. */
    if (renameat(root_fd, "parent", root_fd, "moved") != 0 || mkdirat(root_fd, "parent", 0700) != 0) goto done;
    char proc_fd[64];
    count = snprintf(proc_fd, sizeof(proc_fd), "/proc/self/fd/%d", temporary);
    if (count < 0 || (size_t)count >= sizeof(proc_fd)) goto done;
    if (linkat(AT_FDCWD, proc_fd, parent_fd, "note.md", AT_SYMLINK_FOLLOW) != 0) {
        if (errno == ENOENT || errno == EPERM || errno == EACCES || errno == EXDEV) {
            fprintf(stderr, "BLOCKED: unprivileged proc-fd publication unavailable (%s)\n", strerror(errno));
            result = 77;
        }
        goto done;
    }
    check_fd = openat(parent_fd, "note.md", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat linked;
    if (check_fd < 0 || fstat(check_fd, &linked) != 0 || linked.st_dev != source.st_dev || linked.st_ino != source.st_ino) goto done;
    if (faccessat(root_fd, "parent/note.md", F_OK, 0) == 0 || errno != ENOENT) goto done;
    errno = 0;
    if (linkat(AT_FDCWD, proc_fd, parent_fd, "note.md", AT_SYMLINK_FOLLOW) != -1 || errno != EEXIST) goto done;
    if (symlinkat("external", parent_fd, "existing-link") != 0) goto done;
    errno = 0;
    if (linkat(AT_FDCWD, proc_fd, parent_fd, "existing-link", AT_SYMLINK_FOLLOW) != -1 || errno != EEXIST) goto done;
    puts("PASS: unnamed source and opened directory remained bound; existing names were not replaced");
    result = 0;
done:
    if (result == 1) (void)fail("descriptor-based creation experiment");
    if (check_fd >= 0) close(check_fd);
    if (temporary >= 0) close(temporary);
    if (parent_fd >= 0) {
        (void)unlinkat(parent_fd, "note.md", 0);
        (void)unlinkat(parent_fd, "existing-link", 0);
        close(parent_fd);
    }
    (void)unlinkat(root_fd, "parent", AT_REMOVEDIR);
    (void)unlinkat(root_fd, "moved", AT_REMOVEDIR);
    close(root_fd);
    (void)rmdir(root);
    return result;
}
