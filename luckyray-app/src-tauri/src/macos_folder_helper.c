// One-shot product worker. The application starts this before Tauri/profile
// initialization. stdin/stdout contain the bounded binary protocol, never logs.
// FSRef binds the selected objects; the process write policy contains writes to
// the captured vault path. No unscoped fallback is permitted.
#include <CoreServices/CoreServices.h>
#include <sandbox.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern int sandbox_init_with_parameters(const char *, uint64_t,
    const char *const [], char **) __attribute__((weak_import));

enum { MAGIC = 0x4c52464d, CAPTURE = 1, READY = 2, FINISHED = 3 };
enum { INVOKED = 1, VERIFIED = 2, NOT_EMPTY = 4 };
typedef struct { uint64_t device, inode; int64_t birth_seconds, birth_nanos; } Object;
typedef struct {
    uint32_t mode, require_empty;
    Object root, source, parent, target;
    char root_path[PATH_MAX], source_relative[PATH_MAX], target_relative[PATH_MAX];
    char name[PATH_MAX], source_path[PATH_MAX], parent_path[PATH_MAX];
    char target_path[PATH_MAX], result_path[PATH_MAX];
} Request;

static int transfer(int fd, void *bytes, size_t count, int writing) {
    size_t offset = 0;
    while (offset < count) {
        ssize_t n = writing ? write(fd, (char *)bytes + offset, count - offset)
            : read(fd, (char *)bytes + offset, count - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 0;
        offset += (size_t)n;
    }
    return 1;
}
static int read_u32(uint32_t *out) {
    unsigned char b[4]; if (!transfer(0, b, sizeof b, 0)) return 0;
    *out = (uint32_t)b[0] | (uint32_t)b[1] << 8
        | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
    return 1;
}
static int read_u64(uint64_t *out) {
    uint32_t lo, hi; if (!read_u32(&lo) || !read_u32(&hi)) return 0;
    *out = lo | (uint64_t)hi << 32; return 1;
}
static int read_object(Object *out) {
    uint64_t seconds, nanos;
    if (!read_u64(&out->device) || !read_u64(&out->inode)
        || !read_u64(&seconds) || !read_u64(&nanos)) return 0;
    out->birth_seconds = (int64_t)seconds; out->birth_nanos = (int64_t)nanos;
    return 1;
}
static int read_string(char *out) {
    uint32_t count; if (!read_u32(&count) || count >= PATH_MAX) return 0;
    if (!transfer(0, out, count, 0) || memchr(out, 0, count)) return 0;
    out[count] = 0; return 1;
}
static void response(uint32_t phase, int32_t status, uint32_t flags) {
    uint32_t values[] = { MAGIC, phase, (uint32_t)status, flags };
    unsigned char bytes[16];
    for (size_t i = 0; i < 4; ++i) for (size_t j = 0; j < 4; ++j)
        bytes[4 * i + j] = (unsigned char)(values[i] >> (8 * j));
    if (!transfer(1, bytes, sizeof bytes, 1)) _exit(90);
}
static int relative_path(const char *path, int allow_empty) {
    if (!*path) return allow_empty;
    if (*path == '/' || path[strlen(path) - 1] == '/') return 0;
    const char *p = path;
    while (*p) {
        const char *end = strchr(p, '/'); size_t n = end ? (size_t)(end - p) : strlen(p);
        if (!n || (n == 1 && p[0] == '.') || (n == 2 && !memcmp(p, "..", 2))) return 0;
        if (!end) break;
        p = end + 1;
    }
    return 1;
}
static int join(char *out, const char *a, const char *b) {
    int n = snprintf(out, PATH_MAX, "%s%s%s", a, *b ? "/" : "", b);
    return n > 0 && n < PATH_MAX;
}
static int object_matches(const struct stat *s, Object object) {
    return S_ISDIR(s->st_mode) && (uint64_t)s->st_dev == object.device
        && (uint64_t)s->st_ino == object.inode
        && s->st_birthtimespec.tv_sec == object.birth_seconds
        && s->st_birthtimespec.tv_nsec == object.birth_nanos;
}
// Component traversal rejects links at every level, including the vault root.
static int open_directory(const char *path) {
    if (*path != '/' || !relative_path(path + 1, 1)) return -1;
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    char copy[PATH_MAX]; strcpy(copy, path + 1);
    char *state = NULL;
    for (char *part = strtok_r(copy, "/", &state); part; part = strtok_r(NULL, "/", &state)) {
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        int saved = errno; close(fd); errno = saved;
        if (next < 0) return -1;
        fd = next;
    }
    return fd;
}
static int same(const char *path, Object object) {
    int fd = open_directory(path); if (fd < 0) return 0;
    struct stat s; int result = !fstat(fd, &s) && object_matches(&s, object);
    close(fd); return result;
}
static int empty(int fd) {
    int copy = dup(fd); if (copy < 0) return -1;
    DIR *dir = fdopendir(copy); if (!dir) { close(copy); return -1; }
    rewinddir(dir); int result = 1; errno = 0;
    for (struct dirent *item = readdir(dir); item; item = readdir(dir)) {
        if (strcmp(item->d_name, ".") && strcmp(item->d_name, "..")) { result = 0; break; }
    }
    if (errno) result = -1;
    closedir(dir); return result;
}
static int ref_at(const FSRef *ref, const char *path, Object object) {
    // Compare references rather than pathname bytes: APFS may preserve a
    // different Unicode normalization or letter case for the same entry.
    FSRef named; Boolean directory = 0;
    return !FSPathMakeRef((const UInt8 *)path, &named, &directory) && directory
        && !FSCompareFSRefs(ref, &named) && same(path, object);
}
static int capture(const char *path, Object expected, FSRef *ref, int *held) {
    *held = open_directory(path); if (*held < 0) return 0;
    struct stat s;
    if (fstat(*held, &s) || !object_matches(&s, expected)) return 0;
    Boolean directory = 0;
    return !FSPathMakeRef((const UInt8 *)path, ref, &directory)
        && directory && ref_at(ref, path, expected);
}

int luckyray_macos_folder_helper_main(void) {
    Request r; memset(&r, 0, sizeof r);
    uint32_t magic, version;
    if (!read_u32(&magic) || !read_u32(&version) || magic != MAGIC || version != 1
        || !read_u32(&r.mode) || !read_u32(&r.require_empty)
        || (r.mode != 1 && r.mode != 2) || r.require_empty > 1
        || !read_object(&r.root) || !read_object(&r.source)
        || !read_object(&r.parent) || !read_object(&r.target)
        || !read_string(r.root_path) || !read_string(r.source_relative)
        || !read_string(r.target_relative) || !read_string(r.name)
        || !relative_path(r.source_relative, 0)
        || !relative_path(r.target_relative, 1) || !relative_path(r.name, 0)
        || strchr(r.name, '/') || !strcmp(r.root_path, "/")) {
        response(CAPTURE, EINVAL, 0); return 0;
    }
    if (!join(r.source_path, r.root_path, r.source_relative)
        || !join(r.target_path, r.root_path, r.target_relative)
        || !join(r.result_path, r.target_path, r.name)) {
        response(CAPTURE, ENAMETOOLONG, 0); return 0;
    }
    strcpy(r.parent_path, r.source_path); *strrchr(r.parent_path, '/') = 0;
    const char *source_name = strrchr(r.source_path, '/') + 1;
    if ((r.mode == 1 && strcmp(r.parent_path, r.target_path))
        || (r.mode == 2 && strcmp(source_name, r.name))
        || !same(r.root_path, r.root) || !same(r.parent_path, r.parent)
        || r.root.device != r.source.device || r.root.device != r.target.device) {
        response(CAPTURE, ESTALE, 0); return 0;
    }
    FSRef source, target; int source_fd = -1, target_fd = -1;
    if (!capture(r.source_path, r.source, &source, &source_fd)
        || !capture(r.target_path, r.target, &target, &target_fd)) {
        response(CAPTURE, ESTALE, 0); return 0;
    }
    int parent_fd = open_directory(r.parent_path);
    if (parent_fd < 0) { response(CAPTURE, ESTALE, 0); return 0; }
    struct stat parent_info;
    if (fstat(parent_fd, &parent_info) || !object_matches(&parent_info, r.parent)) {
        response(CAPTURE, ESTALE, 0); return 0;
    }
    const char policy[] = "(version 1)(allow default)"
        "(deny file-write* (require-not (subpath (param \"VAULT\"))))";
    const char *parameters[] = { "VAULT", r.root_path, NULL };
    char *policy_error = NULL;
    if (!sandbox_init_with_parameters) { response(CAPTURE, ENOSYS, 0); return 0; }
    errno = 0;
    int scope = sandbox_init_with_parameters(policy, 0, parameters, &policy_error);
    int scope_errno = errno;
    if (policy_error) sandbox_free_error(policy_error);
    if (scope) { response(CAPTURE, scope_errno ? scope_errno : EPERM, 0); return 0; }
    response(READY, 0, 0);
    char command;
    // A parent that dies before its durable intent/GO cannot start a mutation.
    if (!transfer(0, &command, 1, 0) || command != 'G') return 0;
    if (!same(r.root_path, r.root) || !same(r.parent_path, r.parent)
        || !ref_at(&source, r.source_path, r.source)
        || !ref_at(&target, r.target_path, r.target)) {
        response(FINISHED, ESTALE, 0); return 0;
    }
    if (r.require_empty && empty(source_fd) != 1) {
        response(FINISHED, ENOTEMPTY, NOT_EMPTY); return 0;
    }
    FSRef after; OSStatus status;
    if (r.mode == 1) {
        CFStringRef name = CFStringCreateWithCString(NULL, r.name, kCFStringEncodingUTF8);
        if (!name || CFStringGetLength(name) > 255) {
            if (name) CFRelease(name);
            response(FINISHED, EINVAL, 0); return 0;
        }
        CFIndex length = CFStringGetLength(name); UniChar characters[255];
        CFStringGetCharacters(name, CFRangeMake(0, length), characters);
        status = FSRenameUnicode(&source, (UniCharCount)length, characters, kTextEncodingUnknown, &after);
        CFRelease(name);
    } else {
        status = FSMoveObject(&source, &target, &after);
    }
    uint32_t flags = INVOKED;
    if (!status && same(r.root_path, r.root) && same(r.parent_path, r.parent)
        && ref_at(&target, r.target_path, r.target)
        && ref_at(&after, r.result_path, r.source)
        && !fsync(parent_fd) && !fsync(target_fd)) flags |= VERIFIED;
    // A new child in an initially empty folder is preserved in the retained
    // folder. It is a review outcome, never a claim that an empty delete passed.
    if (r.require_empty && empty(source_fd) != 1) flags |= NOT_EMPTY;
    response(FINISHED, status, flags);
    close(source_fd); close(target_fd); close(parent_fd);
    return 0;
}

#ifdef LUCKYRAY_FOLDER_HELPER_STANDALONE
int main(void) { return luckyray_macos_folder_helper_main(); }
#endif
