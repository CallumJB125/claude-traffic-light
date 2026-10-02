#define _DARWIN_C_SOURCE
#include "writer.h"
#include "reader-private.h"
#include "writer-private.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <stdio.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <time.h>
#endif
#if defined(__APPLE__) && defined(RENAME_SWAP) && defined(RENAME_EXCL) && defined(F_FULLFSYNC)
#define PF_HOLD_PREFIX ".plexiform-setups-hold-"
#define PF_WRITER_ACL_BYTES 32768u
#define PF_WRITER_RECORD_LIMIT 8u
#define PF_WRITER_NS UINT64_C(5000000000)
#define PF_WRITER_XATTR_BYTES 8192u
#ifdef PF_WRITER_TEST_HOOKS
extern void pf_writer_test_barrier(unsigned stage);
extern int pf_writer_test_fault(unsigned stage);
#define W_BARRIER(n) pf_writer_test_barrier(n)
#define W_FAULT(n) pf_writer_test_fault(n)
#else
#define W_BARRIER(n) ((void)0)
#define W_FAULT(n) 0
#endif
static const char *const attributes[] = {"com.apple.provenance", "com.apple.quarantine"};
/* Fixed native observation record: no paths/content/commands. Its checksum
 * detects incomplete writes; it is NOT the authenticated encrypted app journal.
 * Records alone never create authority; only the private authenticated full
 * anchor/fresh-confirmation recovery bridge may reopen retained descriptors. */
typedef struct {
  unsigned char magic[8];
  uint32_t schema, bytes, phase, result, sequence, effect, existed, recipe;
  PFWriteMeta before, stage, target, displaced;
  PFStamp profile, parent, hold;
  unsigned char before_hash[32], after_hash[32];
  char hold_id[PF_WRITER_HOLD_ID_BYTES];
  unsigned char checksum[32];
} PFNativeRecord;
struct PFWriteTxn {
  PFNativeParent *parent;
  PFRecipe recipe;
  int hold_fd;
  PFStamp hold_identity, profile_identity, parent_identity;
  PFNativeBinding hold_binding;
  char hold_id[PF_WRITER_HOLD_ID_BYTES];
  unsigned char *before, *after;
  size_t before_size, after_size;
  acl_t before_acl;
  PFAttribute before_attrs[2];
  PFWriteMeta before_meta, stage_meta, after_meta, restored_meta, undo_displaced_meta;
  PFWriteMeta snapshots[2], records[PF_WRITER_RECORD_LIMIT];
  PFWriteReceipt receipt;
  unsigned sequence, apply_attempted, undo_attempted, poisoned;
  unsigned production_gate, apply_intent_ready, undo_intent_ready;
  uint64_t start, production_cutoff;
  unsigned recovered_undo_ready;
};
static PFResult before_current(PFWriteTxn *t);
static void wipe(void *memory, size_t size) {
  volatile unsigned char *bytes = memory;
  while (size--) *bytes++ = 0;
}
static void digest(const void *bytes, size_t size, unsigned char out[32]) {
  static const unsigned char empty = 0;
  (void)CC_SHA256(size ? bytes : &empty, (CC_LONG)size, out);
}
static PFStamp stamp_of(const struct stat *s) {
  PFStamp p = {0};
  p.device = (uint64_t)s->st_dev; p.inode = (uint64_t)s->st_ino;
  p.size = s->st_size < 0 ? UINT64_MAX : (uint64_t)s->st_size;
  p.uid = s->st_uid; p.mode = s->st_mode; p.links = s->st_nlink;
  p.mtime_seconds = s->st_mtimespec.tv_sec; p.mtime_nanoseconds = s->st_mtimespec.tv_nsec;
  p.ctime_seconds = s->st_ctimespec.tv_sec; p.ctime_nanoseconds = s->st_ctimespec.tv_nsec;
  return p;
}
static int identity_equal(const PFStamp *a, const PFStamp *b) {
  return a->device == b->device && a->inode == b->inode && a->uid == b->uid && a->mode == b->mode;
}
static int full_equal(const PFWriteMeta *a, const PFWriteMeta *b) { return memcmp(a, b, sizeof(*a)) == 0; }
/* Rename itself changes ctime. Compare observed content/approved metadata and
 * inode/mtime, not an invented expected-ctime atomic predicate. */
static int moved_equal(const PFWriteMeta *a, const PFWriteMeta *b) {
  PFWriteMeta x = *a, y = *b;
  x.stamp.ctime_seconds = y.stamp.ctime_seconds = 0;
  x.stamp.ctime_nanoseconds = y.stamp.ctime_nanoseconds = 0;
  return full_equal(&x, &y);
}
static uint64_t now_ns(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
}
static PFResult budget(PFWriteTxn *t) {
  uint64_t now = now_ns();
  return !now || !t->start ? PF_IO : now - t->start >= PF_WRITER_NS || (t->production_cutoff && now >= t->production_cutoff) ? PF_DEADLINE : PF_OK;
}
static PFResult io_error(void) {
  if (errno == EEXIST || errno == ENOENT) return PF_CHANGED;
  if (errno == ELOOP || errno == ENOTDIR) return PF_UNSAFE;
  if (errno == EOPNOTSUPP || errno == ENOTSUP || errno == EXDEV || errno == EINVAL) return PF_UNSUPPORTED;
  return PF_IO;
}
static PFResult acl_copy(int fd, acl_t *out, unsigned char hash[32]) {
  *out = NULL; errno = 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl && errno != ENOENT) return PF_IO;
  if (!acl) {
    acl = acl_init(0); if (!acl) return PF_IO;
    digest(NULL, 0, hash); *out = acl; return PF_OK;
  }
  ssize_t size = acl_size(acl);
  if (size < 0 || size > (ssize_t)PF_WRITER_ACL_BYTES || acl_valid(acl) != 0) { acl_free(acl); return PF_UNSAFE; }
  acl_entry_t first;
  if (acl_get_entry(acl, ACL_FIRST_ENTRY, &first) != 0) {
    if (errno != EINVAL) { acl_free(acl); return PF_IO; }
    digest(NULL, 0, hash); *out = acl; return PF_OK;
  }
  unsigned char bytes[PF_WRITER_ACL_BYTES];
  ssize_t copied = acl_copy_ext_native(bytes, acl, size);
  if (copied < 0 || copied > size) { acl_free(acl); return PF_IO; }
  digest(bytes, (size_t)copied, hash); wipe(bytes, sizeof(bytes)); *out = acl; return PF_OK;
}
/* Plaintext holds require an actually empty descriptor ACL, not merely the
 * reader's safe-write ACL policy (which intentionally permits read grants).
 * Absence with Darwin's documented ENOENT is a positively queried empty ACL.
 * No existing or newly observed hold ACL is ever rewritten. */
static PFResult empty_acl(int fd) {
  if (W_FAULT(38)) return PF_IO;
  if (W_FAULT(39)) return PF_UNSUPPORTED;
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT ? PF_OK : io_error();
  ssize_t size = acl_size(acl); PFResult r = PF_OK;
  if (size < 0 || size > (ssize_t)PF_WRITER_ACL_BYTES || acl_valid(acl) != 0) r = PF_UNSAFE;
  if (r == PF_OK) {
    acl_entry_t first; errno = 0;
    if (acl_get_entry(acl, ACL_FIRST_ENTRY, &first) == 0) r = PF_UNSAFE;
    else if (errno != EINVAL) r = io_error();
  }
  if (acl_free(acl) != 0 && r == PF_OK) r = PF_IO;
  return r;
}
static PFResult attribute_copy(int fd, PFAttributeMeta out[2], PFAttribute saved[2]) {
  char names[128]; ssize_t size = flistxattr(fd, names, sizeof(names), 0);
  if (size < 0) return errno == ERANGE ? PF_TOO_LARGE : PF_IO;
  if (size > (ssize_t)sizeof(names)) return PF_TOO_LARGE;
  unsigned found[2] = {0, 0};
  for (size_t at = 0; at < (size_t)size;) {
    size_t remaining = (size_t)size-at, n = strnlen(names+at, remaining);
    if (n == 0 || n == remaining) return PF_CHANGED;
    unsigned index;
    for (index = 0; index < 2u; ++index) if (strcmp(names+at, attributes[index]) == 0) break;
    if (index == 2u) return PF_UNSUPPORTED;
    if (found[index]++) return PF_CHANGED;
    at += n+1;
  }
  for (unsigned i = 0; i < 2u; ++i) {
    errno = 0; ssize_t wanted = fgetxattr(fd, attributes[i], NULL, 0, 0, 0);
    if (wanted < 0) {
      if (errno == ENOATTR && !found[i]) { memset(&out[i], 0, sizeof(out[i])); if (saved) memset(&saved[i], 0, sizeof(saved[i])); continue; }
      return errno == ENOATTR ? PF_CHANGED : PF_IO;
    }
    if (!found[i]) return PF_CHANGED;
    if (wanted > (ssize_t)PF_WRITER_XATTR_BYTES) return PF_TOO_LARGE;
    unsigned char bytes[PF_WRITER_XATTR_BYTES];
    ssize_t got = fgetxattr(fd, attributes[i], bytes, sizeof(bytes), 0, 0);
    if (got < 0) { PFResult r = errno == ERANGE || errno == ENOATTR ? PF_CHANGED : PF_IO; wipe(bytes, sizeof(bytes)); return r; }
    if (got != wanted) { wipe(bytes, sizeof(bytes)); return PF_CHANGED; }
    out[i].present = 1; out[i].size = (uint64_t)got; digest(bytes, (size_t)got, out[i].hash);
    if (saved) { memset(&saved[i], 0, sizeof(saved[i])); saved[i].present = 1; saved[i].size = (size_t)got; if (got) memcpy(saved[i].bytes, bytes, (size_t)got); }
    wipe(bytes, sizeof(bytes));
  }
  return PF_OK;
}
static PFResult metadata(int fd, PFWriteMeta *out, acl_t *saved, PFAttribute saved_attrs[2]) {
  memset(out, 0, sizeof(*out)); if (saved) *saved = NULL;
  struct stat before, after;
  if (fstat(fd, &before) != 0) return PF_IO;
  if (!S_ISREG(before.st_mode) || before.st_uid != getuid() || before.st_nlink != 1 || (before.st_mode & 0022)) return PF_UNSAFE;
  if ((before.st_mode & 07000) || before.st_flags != 0) return PF_UNSUPPORTED;
  if (before.st_size < 0 || (uint64_t)before.st_size > PF_READER_MAX_BYTES) return PF_TOO_LARGE;
  PFResult r = pf_native_acl_safe(fd); if (r != PF_OK) return r;
  r = attribute_copy(fd, out->attrs, saved_attrs); if (r != PF_OK) return r;
  acl_t acl = NULL; r = acl_copy(fd, &acl, out->acl_hash); if (r != PF_OK) return r;
  if (fstat(fd, &after) != 0) { acl_free(acl); return PF_IO; }
  PFStamp a = stamp_of(&before), b = stamp_of(&after);
  if (r == PF_OK && (memcmp(&a, &b, sizeof(a)) != 0 || before.st_gid != after.st_gid || before.st_flags != after.st_flags)) r = PF_CHANGED;
  if (r == PF_OK) { out->stamp = b; out->gid = after.st_gid; out->flags = after.st_flags; }
  if (r == PF_OK && saved) *saved = acl; else acl_free(acl);
  return r;
}
static PFResult read_exact(PFWriteTxn *t, int fd, unsigned char *bytes, size_t size) {
  size_t at = 0;
  while (at < size) {
    PFResult r = budget(t); if (r != PF_OK) return r;
    size_t wanted = size - at; if (wanted > 4096u) wanted = 4096u;
    ssize_t n = pread(fd, bytes + at, wanted, (off_t)at);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) return PF_IO;
    if (!n) return PF_CHANGED;
    at += (size_t)n;
  }
  unsigned char extra; ssize_t n;
  do { n = pread(fd, &extra, 1, (off_t)size); } while (n < 0 && errno == EINTR && budget(t) == PF_OK);
  return n == 0 ? budget(t) : n > 0 ? PF_CHANGED : PF_IO;
}
static PFResult observe(PFWriteTxn *t, int parent, const char *name, PFWriteMeta *out, acl_t *saved) {
  memset(out, 0, sizeof(*out)); if (saved) *saved = NULL;
  struct stat named;
  if (fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? PF_UNAVAILABLE : io_error();
  out->stamp = stamp_of(&named);
  /* Displaced directories/links/FIFOs are reported by identity, not traversed
   * or serialized. Nonblocking precedes every possible leaf fstat/read. */
  if (!S_ISREG(named.st_mode)) return PF_UNSAFE;
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return io_error();
  PFWriteMeta a, b; acl_t acl = NULL;
  PFAttribute attrs[2];
  PFResult r = metadata(fd, &a, saved ? &acl : NULL, saved ? attrs : NULL);
  PFStamp initial = stamp_of(&named);
  if (r == PF_OK && memcmp(&initial, &a.stamp, sizeof(initial)) != 0) r = PF_CHANGED;
  unsigned char *bytes = NULL;
  if (r == PF_OK) { bytes = calloc((size_t)a.stamp.size + 1, 1); if (!bytes) r = PF_IO; }
  if (r == PF_OK) r = read_exact(t, fd, bytes, (size_t)a.stamp.size);
  if (r == PF_OK) r = metadata(fd, &b, NULL, NULL);
  if (r == PF_OK && !full_equal(&a, &b)) r = PF_CHANGED;
  if (r == PF_OK && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0) r = PF_CHANGED;
  if (r == PF_OK) { PFStamp last = stamp_of(&named); if (memcmp(&last, &b.stamp, sizeof(last)) != 0) r = PF_CHANGED; }
  if (r == PF_OK) { digest(bytes, (size_t)a.stamp.size, a.hash); *out = a; if (saved) { *saved = acl; acl = NULL; memcpy(t->before_attrs, attrs, sizeof(attrs)); } }
  if (bytes) { wipe(bytes, (size_t)a.stamp.size); free(bytes); }
  if (acl) acl_free(acl);
  wipe(attrs, sizeof(attrs));
  close(fd); return r;
}
static PFResult current(PFWriteTxn *t) {
  PFResult r = budget(t); if (r != PF_OK) return r;
  r = pf_native_parent_current(t->parent); if (r != PF_OK) return r;
  if (t->hold_fd < 0) return PF_OK;
  struct stat held, named;
  if (fstat(t->hold_fd, &held) != 0 || fstatat(pf_native_profile_fd(t->parent), t->hold_id, &named, AT_SYMLINK_NOFOLLOW) != 0) return PF_CHANGED;
  PFStamp a = stamp_of(&held), b = stamp_of(&named);
  if (!S_ISDIR(held.st_mode) || held.st_uid != getuid() || (held.st_mode & 07777) != 0700
      || !identity_equal(&t->hold_identity, &a) || !identity_equal(&a, &b)) return PF_CHANGED;
  r = empty_acl(t->hold_fd); if (r != PF_OK) return r;
  PFNativeBinding permission; r = pf_native_binding_fd(t->hold_fd, &permission); if (r != PF_OK) return r;
  if (permission.flags != 0) return PF_UNSUPPORTED;
  if (t->hold_binding.inode && memcmp(&permission, &t->hold_binding, sizeof(permission)) != 0) return PF_CHANGED;
  if (!t->hold_binding.inode) t->hold_binding = permission;
  W_BARRIER(11);
  if (fstat(t->hold_fd, &held) != 0 || fstatat(pf_native_profile_fd(t->parent), t->hold_id, &named, AT_SYMLINK_NOFOLLOW) != 0) return PF_CHANGED;
  PFStamp fresh = stamp_of(&held), binding = stamp_of(&named);
  return memcmp(&a, &fresh, sizeof(a)) == 0 && memcmp(&fresh, &binding, sizeof(fresh)) == 0 ? PF_OK : PF_CHANGED;
}
static PFResult sync_file(int fd) {
  if (W_FAULT(32)) return PF_IO;
  return fsync(fd) == 0 && fcntl(fd, F_FULLFSYNC) == 0 ? PF_OK : PF_IO;
}
static PFResult sync_dir(int fd) { return !W_FAULT(33) && fsync(fd) == 0 ? PF_OK : PF_IO; }
static PFResult write_all(PFWriteTxn *t, int fd, const unsigned char *bytes, size_t size) {
  size_t at = 0;
  while (at < size) {
    PFResult r = budget(t); if (r != PF_OK) return r;
    if (W_FAULT(31)) return PF_IO;
    size_t wanted = size - at; if (wanted > 4096u) wanted = 4096u;
    ssize_t n = write(fd, bytes + at, wanted);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return PF_IO;
    at += (size_t)n;
  }
  return PF_OK;
}
static PFResult empty_directory(int held) {
  int fd = openat(held, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return PF_IO;
  DIR *dir = fdopendir(fd); if (!dir) { close(fd); return PF_IO; }
  PFResult result = PF_OK; struct dirent *entry; errno = 0;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) { result = PF_CHANGED; break; }
  }
  if (result == PF_OK && errno) result = PF_IO;
  closedir(dir); return result;
}
static PFResult stage_file(PFWriteTxn *t, const char *name, const unsigned char *bytes, size_t size,
                           int approved_metadata, int original_time, PFWriteMeta *out) {
  PFResult r = current(t); if (r != PF_OK) return r;
  int fd = openat(t->hold_fd, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
  if (fd < 0) return io_error();
  PFWriteMeta created;
  r = current(t);
  if (r == PF_OK) r = metadata(fd, &created, NULL, NULL);
  if (r == PF_OK && (created.stamp.mode & 07777) != 0600) r = PF_UNSAFE;
  if (r == PF_OK) r = write_all(t, fd, bytes, size);
  if (r == PF_OK) r = current(t);
  if (r == PF_OK && approved_metadata && t->receipt.existed) {
    struct stat st;
    if (fstat(fd, &st) != 0) r = PF_IO;
    if (r == PF_OK && st.st_gid != (gid_t)t->before_meta.gid && fchown(fd, (uid_t)-1, (gid_t)t->before_meta.gid) != 0) r = PF_UNSUPPORTED;
    if (r == PF_OK && fchmod(fd, (mode_t)t->before_meta.stamp.mode & 0777) != 0) r = PF_IO;
    if (r == PF_OK && acl_set_fd_np(fd, t->before_acl, ACL_TYPE_EXTENDED) != 0) r = PF_IO;
    for (unsigned i = 0; r == PF_OK && i < 2u; ++i) {
      if (t->before_attrs[i].present) {
        if (fsetxattr(fd, attributes[i], t->before_attrs[i].bytes, t->before_attrs[i].size, 0, 0) != 0) r = PF_IO;
      } else {
        /* Never strip an automatically added security attribute to make a
         * stage match. If exact absence cannot be preserved, refuse. */
        errno = 0;
        if (fgetxattr(fd, attributes[i], NULL, 0, 0, 0) >= 0) r = PF_UNSUPPORTED;
        else if (errno != ENOATTR) r = PF_IO;
      }
    }
    if (r == PF_OK && original_time) {
      struct timespec times[2] = {{0, UTIME_OMIT}, {t->before_meta.stamp.mtime_seconds, t->before_meta.stamp.mtime_nanoseconds}};
      if (futimens(fd, times) != 0) r = PF_IO;
    }
  }
  if (r == PF_OK && approved_metadata && t->receipt.existed) W_BARRIER(10);
  if (r == PF_OK) r = sync_file(fd);
  if (r == PF_OK) r = metadata(fd, &created, NULL, NULL);
  if (r == PF_OK && approved_metadata && t->receipt.existed) {
    if ((created.stamp.mode & 07777) != (t->before_meta.stamp.mode & 07777)
        || created.gid != t->before_meta.gid || created.flags != t->before_meta.flags
        || memcmp(created.acl_hash, t->before_meta.acl_hash, sizeof(created.acl_hash)) != 0
        || memcmp(created.attrs, t->before_meta.attrs, sizeof(created.attrs)) != 0) r = PF_CHANGED;
    if (r == PF_OK && original_time && (created.stamp.mtime_seconds != t->before_meta.stamp.mtime_seconds
        || created.stamp.mtime_nanoseconds != t->before_meta.stamp.mtime_nanoseconds)) r = PF_CHANGED;
  }
  if (r == PF_OK) r = sync_dir(t->hold_fd);
  if (r == PF_OK) r = current(t);
  if (r == PF_OK) r = observe(t, t->hold_fd, name, out, NULL);
  unsigned char expected[32]; digest(bytes, size, expected);
  if (r == PF_OK && memcmp(out->hash, expected, sizeof(expected)) != 0) r = PF_CHANGED;
  memcpy(created.hash, expected, sizeof(expected));
  if (r == PF_OK && !full_equal(&created, out)) r = PF_CHANGED;
  close(fd);
  return r;
}
static PFResult hold_create(PFWriteTxn *t) {
  PFResult r = current(t); if (r != PF_OK) return r;
  int profile = pf_native_profile_fd(t->parent);
  /* A dup shares the retained root's directory cursor and could miss all prior
   * holds on a reused capability. A fresh open of this held directory gives
   * this bounded scan its own offset; no caller component is accepted. */
  int fd = openat(profile, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return PF_IO;
  DIR *scan = fdopendir(fd); if (!scan) { close(fd); return PF_IO; }
  unsigned entries = 0, holds = 0; struct dirent *entry; errno = 0;
  while ((entry = readdir(scan)) != NULL) {
    if (++entries > 4096u) { r = PF_TOO_LARGE; break; }
    if (strncmp(entry->d_name, PF_HOLD_PREFIX, sizeof(PF_HOLD_PREFIX)-1) == 0 && ++holds >= PF_WRITER_MAX_HOLDS) { r = PF_TOO_LARGE; break; }
  }
  if (r == PF_OK && errno) r = PF_IO;
  closedir(scan); if (r != PF_OK) return r;
  r = current(t); if (r != PF_OK) return r;
  unsigned char random[16]; arc4random_buf(random, sizeof(random));
  memcpy(t->hold_id, PF_HOLD_PREFIX, sizeof(PF_HOLD_PREFIX)-1);
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(random); ++i) {
    t->hold_id[sizeof(PF_HOLD_PREFIX)-1+2*i] = hex[random[i]>>4];
    t->hold_id[sizeof(PF_HOLD_PREFIX)+2*i] = hex[random[i]&15];
  }
  if (mkdirat(profile, t->hold_id, 0700) != 0) return io_error();
  W_BARRIER(9);
  struct stat created, named;
  if (fstatat(profile, t->hold_id, &created, AT_SYMLINK_NOFOLLOW) != 0) return PF_CHANGED;
  W_BARRIER(8);
  t->hold_fd = openat(profile, t->hold_id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (t->hold_fd < 0) return io_error();
  struct stat st; if (fstat(t->hold_fd, &st) != 0) return PF_IO;
  PFStamp expected = stamp_of(&created), opened = stamp_of(&st);
  if (memcmp(&expected, &opened, sizeof(expected)) != 0) return PF_CHANGED;
  if (!S_ISDIR(st.st_mode) || st.st_uid != getuid() || st.st_dev != (dev_t)t->profile_identity.device || (st.st_mode & 07777) != 0700) return PF_UNSAFE;
  r = pf_native_parent_current(t->parent); if (r != PF_OK) return r;
  r = empty_directory(t->hold_fd); if (r != PF_OK) return r;
  if (fstatat(profile, t->hold_id, &named, AT_SYMLINK_NOFOLLOW) != 0) return PF_CHANGED;
  PFStamp binding = stamp_of(&named); if (memcmp(&binding, &opened, sizeof(binding)) != 0) return PF_CHANGED;
  if (fstat(t->hold_fd, &st) != 0) return PF_IO;
  PFStamp fresh = stamp_of(&st); if (memcmp(&fresh, &opened, sizeof(fresh)) != 0) return PF_CHANGED;
  /* mkdirat has no atomic created-inode return: an empty same-UID replacement
   * before first capture remains indistinguishable. Refuse any observed ACL
   * instead of clearing inherited or foreign metadata to manufacture privacy. */
  t->hold_identity = fresh;
  r = current(t); if (r != PF_OK) return r;
  r = sync_dir(t->hold_fd); if (r == PF_OK) r = sync_dir(profile);
  return r;
}
static PFResult record(PFWriteTxn *t, PFWritePhase phase, PFResult result, unsigned effect,
                       const PFWriteMeta *target, const PFWriteMeta *displaced) {
  PFResult r = current(t); if (r != PF_OK) return r;
  if (t->sequence >= PF_WRITER_RECORD_LIMIT) return PF_TOO_LARGE;
  PFNativeRecord entry; memset(&entry, 0, sizeof(entry)); memcpy(entry.magic, "PFWRTR01", 8);
  entry.schema = 1; entry.bytes = sizeof(entry); entry.phase = phase; entry.result = result;
  entry.sequence = t->sequence; entry.effect = effect; entry.existed = t->receipt.existed; entry.recipe = t->recipe;
  entry.before = t->before_meta; entry.stage = phase == PF_WRITE_UNDO_INTENT && t->receipt.existed ? t->restored_meta : t->stage_meta;
  if (target) entry.target = *target; if (displaced) entry.displaced = *displaced;
  entry.profile = t->profile_identity; entry.parent = t->parent_identity; entry.hold = t->hold_identity;
  digest(t->before, t->before_size, entry.before_hash); digest(t->after, t->after_size, entry.after_hash);
  memcpy(entry.hold_id, t->hold_id, sizeof(entry.hold_id));
  digest(&entry, offsetof(PFNativeRecord, checksum), entry.checksum);
  char name[32]; (void)snprintf(name, sizeof(name), "record-%02u.bin", t->sequence);
  int fd = openat(t->hold_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
  if (fd < 0) return io_error();
  unsigned char expected_hash[32]; digest(&entry, sizeof(entry), expected_hash);
  r = W_FAULT(34) ? PF_IO : write_all(t, fd, (const unsigned char *)&entry, sizeof(entry));
  PFWriteMeta opened;
  if (r == PF_OK) r = sync_file(fd);
  if (r == PF_OK) r = metadata(fd, &opened, NULL, NULL);
  if (r == PF_OK && (opened.stamp.mode & 07777) != 0600) r = PF_UNSAFE;
  wipe(&entry, sizeof(entry));
  if (r == PF_OK) r = sync_dir(t->hold_fd);
  if (r == PF_OK) r = current(t);
  if (r == PF_OK) {
    struct stat named;
    if (fstatat(t->hold_fd, name, &named, AT_SYMLINK_NOFOLLOW) != 0) r = PF_CHANGED;
    else { PFStamp stamp = stamp_of(&named); if (memcmp(&stamp, &opened.stamp, sizeof(stamp)) != 0) r = PF_CHANGED; }
  }
  PFWriteMeta observed;
  if (r == PF_OK) r = observe(t, t->hold_fd, name, &observed, NULL);
  memcpy(opened.hash, expected_hash, sizeof(expected_hash));
  if (r == PF_OK && !full_equal(&opened, &observed)) r = PF_CHANGED;
  close(fd);
  if (r == PF_OK) t->records[t->sequence++] = observed;
  return r;
}
static void receipt(PFWriteTxn *t, PFWritePhase phase, PFResult result, unsigned effect,
                    const PFWriteMeta *target, const PFWriteMeta *displaced, PFWriteReceipt *out) {
  t->receipt.phase = phase; t->receipt.result = result; t->receipt.sequence = t->sequence;
  t->receipt.namespace_effect = effect;
  memset(&t->receipt.target, 0, sizeof(t->receipt.target)); memset(&t->receipt.displaced, 0, sizeof(t->receipt.displaced));
  memset(t->receipt.target_hash, 0, sizeof(t->receipt.target_hash)); memset(t->receipt.displaced_hash, 0, sizeof(t->receipt.displaced_hash));
  if (target) { t->receipt.target = target->stamp; memcpy(t->receipt.target_hash, target->hash, 32); }
  if (displaced) { t->receipt.displaced = displaced->stamp; memcpy(t->receipt.displaced_hash, displaced->hash, 32); }
  memcpy(t->receipt.hold_id, t->hold_id, sizeof(t->hold_id));
  if (out) *out = t->receipt;
}
void pf_writer_close(PFWriteTxn *t) {
  if (!t) return;
  if (t->hold_fd >= 0) close(t->hold_fd);
  if (t->before_acl) acl_free(t->before_acl);
  if (t->before) { wipe(t->before, t->before_size); free(t->before); }
  if (t->after) { wipe(t->after, t->after_size); free(t->after); }
  pf_native_parent_close(t->parent); wipe(t, sizeof(*t)); free(t);
}
static PFResult writer_prepare_impl(PFRoot *root, PFRecipe recipe, const PFStamp *expected,
                          const unsigned char *before, size_t before_size,
                          const unsigned char *after, size_t after_size, PFWriteTxn **out, PFNativeWriterState *failure, uint64_t cutoff) {
  if (!out) return PF_INVALID;
  *out = NULL;
  if ((!before && before_size) || (!after && after_size) || (!expected && before_size)) return PF_INVALID;
  if (before_size > PF_READER_MAX_BYTES || after_size > PF_READER_MAX_BYTES) return PF_TOO_LARGE;
  PFWriteTxn *t = calloc(1, sizeof(*t)); if (!t) return PF_IO;
  t->hold_fd = -1; t->recipe = recipe; t->start = now_ns(); t->production_cutoff = cutoff; t->production_gate = cutoff != 0; t->receipt.existed = expected != NULL;
  PFResult r = pf_native_parent_open(root, recipe, &t->parent);
  struct stat st;
  if (r == PF_OK && fstat(pf_native_profile_fd(t->parent), &st) == 0) t->profile_identity = stamp_of(&st); else if (r == PF_OK) r = PF_IO;
  if (r == PF_OK && fstat(pf_native_parent_fd(t->parent), &st) == 0) t->parent_identity = stamp_of(&st); else if (r == PF_OK) r = PF_IO;
  if (r == PF_OK) {
    r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &t->before_meta, expected ? &t->before_acl : NULL);
    if (!expected && r == PF_UNAVAILABLE) r = PF_OK;
    else if (!expected && r == PF_OK) r = PF_CHANGED;
    else if (expected && r == PF_OK && memcmp(expected, &t->before_meta.stamp, sizeof(*expected)) != 0) r = PF_CHANGED;
  }
  unsigned char hash[32]; digest(before, before_size, hash);
  if (r == PF_OK && expected && (before_size != t->before_meta.stamp.size || memcmp(hash, t->before_meta.hash, 32) != 0)) r = PF_CHANGED;
  if (r == PF_OK) {
    t->before = calloc(before_size + 1, 1); t->after = calloc(after_size + 1, 1);
    if (!t->before || !t->after) r = PF_IO;
    else { if (before_size) memcpy(t->before, before, before_size); if (after_size) memcpy(t->after, after, after_size); t->before_size = before_size; t->after_size = after_size; }
  }
  if (r == PF_OK) r = current(t);
  if (r == PF_OK && expected && before_size == after_size && memcmp(t->before, t->after, before_size) == 0) {
    receipt(t, PF_WRITE_NOOP, PF_OK, 0, &t->before_meta, NULL, NULL); *out = t; return PF_OK;
  }
  if (r == PF_OK) { W_BARRIER(1); r = hold_create(t); }
  if (r == PF_OK) r = stage_file(t, "snapshot-before", t->before, before_size, 0, 0, &t->snapshots[0]);
  if (r == PF_OK) r = stage_file(t, "snapshot-after", t->after, after_size, 0, 0, &t->snapshots[1]);
  if (r == PF_OK) r = stage_file(t, "after", t->after, after_size, 1, 0, &t->stage_meta);
  if (r == PF_OK) r = record(t, PF_WRITE_PREPARED, PF_OK, 0, NULL, NULL);
  if (r == PF_OK) { W_BARRIER(2); r = before_current(t); }
  if (r != PF_OK) { if (failure) (void)pf_native_writer_state(t, failure); pf_writer_close(t); return r; }
  receipt(t, PF_WRITE_PREPARED, PF_OK, 0, NULL, NULL, NULL); *out = t; return PF_OK;
}
PFResult pf_writer_prepare(PFRoot *root, PFRecipe recipe, const PFStamp *expected,
 const unsigned char *before, size_t before_size, const unsigned char *after, size_t after_size, PFWriteTxn **out) {
 return writer_prepare_impl(root,recipe,expected,before,before_size,after,after_size,out,NULL,0);
}
PFResult pf_native_writer_prepare_observed(PFRoot *root, PFRecipe recipe, const PFStamp *expected, PFByteView before, PFByteView after, uint64_t cutoff, PFWriteTxn **out, PFNativeWriterState *failure) {
 if(failure)memset(failure,0,sizeof(*failure));
 PFResult r=writer_prepare_impl(root,recipe,expected,before.data,before.size,after.data,after.size,out,failure,cutoff);
 if(r==PF_OK)(*out)->production_gate=1;
 return r;
}
PFResult pf_native_writer_state(PFWriteTxn *t, PFNativeWriterState *out) {
 if(!out)return PF_INVALID;memset(out,0,sizeof(*out));if(!t)return PF_INVALID;
 out->recipe=t->recipe;out->receipt=t->receipt;
 if(t->undo_intent_ready&&!t->undo_attempted&&out->receipt.phase==PF_WRITE_APPLIED)out->receipt.phase=PF_WRITE_UNDO_INTENT;out->profile=t->profile_identity;out->parent=t->parent_identity;out->hold=t->hold_identity;out->hold_binding=t->hold_binding;
 out->before=t->before_meta;out->stage=t->stage_meta;out->accepted_after=t->after_meta;out->restore_stage=t->restored_meta;
 memcpy(out->snapshots,t->snapshots,sizeof(out->snapshots));memcpy(out->records,t->records,sizeof(out->records));
 out->record_count=t->sequence;memcpy(out->hold_id,t->hold_id,sizeof(out->hold_id));return PF_OK;
}
PFResult pf_native_writer_current(PFWriteTxn *t) { return t ? current(t) : PF_INVALID; }
PFResult pf_native_writer_restrict_cutoff(PFWriteTxn *t,uint64_t cutoff){if(!t||!t->production_gate||!cutoff||cutoff>t->production_cutoff)return PF_INVALID;t->production_cutoff=cutoff;return budget(t);}
PFResult pf_native_writer_stamp(PFWriteTxn *t,unsigned role,PFStamp *out) {
 if(!out)return PF_INVALID;memset(out,0,sizeof(*out));if(!t||role>4)return PF_INVALID;
 PFResult r=current(t);if(r!=PF_OK)return r;
 int fd=role? t->hold_fd:pf_native_parent_fd(t->parent);
 const char *name=role==0?pf_native_leaf(t->parent):role==1?"after":role==2?"undo-stage":role==3?"undo-displaced":"snapshot-before";
 if(fd<0)return PF_UNAVAILABLE;struct stat st;if(fstatat(fd,name,&st,AT_SYMLINK_NOFOLLOW)!=0)return io_error();*out=stamp_of(&st);return PF_OK;
}
PFResult pf_native_writer_snapshot(PFWriteTxn *t,unsigned role,PFSnapshot **out) {
 if(!out)return PF_INVALID;*out=NULL;if(!t||role>4)return PF_INVALID;
 PFResult r=current(t);if(r!=PF_OK)return r;
 const char *name=NULL;int fd=t->hold_fd;
 if(role==0){fd=pf_native_parent_fd(t->parent);name=pf_native_leaf(t->parent);}
 else if(role==1)name="after";else if(role==2)name="undo-stage";else if(role==3)name="undo-displaced";else name="snapshot-before";
 if(fd<0)return PF_UNAVAILABLE;
 return pf_snapshot_native(t->parent,fd,name,t->recipe,out);
}
static PFResult integrity(PFWriteTxn *t) {
  if (!t->sequence) return PF_OK;
  PFWriteMeta observed;
  for (unsigned i = 0; i < 2u; ++i) {
    PFResult r = observe(t, t->hold_fd, i ? "snapshot-after" : "snapshot-before", &observed, NULL);
    if (r != PF_OK) return r;
    if (!full_equal(&observed, &t->snapshots[i])) return PF_CHANGED;
  }
  for (unsigned i = 0; i < t->sequence; ++i) {
    char name[32]; (void)snprintf(name, sizeof(name), "record-%02u.bin", i);
    PFResult r = observe(t, t->hold_fd, name, &observed, NULL);
    if (r != PF_OK) return r;
    if (!full_equal(&observed, &t->records[i])) return PF_CHANGED;
  }
  return PF_OK;
}
static PFResult before_current(PFWriteTxn *t) {
  PFResult r = current(t); if (r != PF_OK) return r;
  r = integrity(t); if (r != PF_OK) return r;
  PFWriteMeta observed;
  r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &observed, NULL);
  if (!t->receipt.existed) return r == PF_UNAVAILABLE ? PF_OK : r == PF_OK ? PF_CHANGED : r;
  return r == PF_OK && !full_equal(&observed, &t->before_meta) ? PF_CHANGED : r;
}
PFResult pf_writer_apply(PFWriteTxn *t, PFWriteReceipt *out) {
  if (out) memset(out, 0, sizeof(*out));
  if (!t || !out || t->apply_attempted || t->poisoned) return PF_INVALID;
  t->apply_attempted = 1; if (!t->production_gate) t->start = now_ns();
  if (t->production_gate && !t->apply_intent_ready) return PF_INVALID;
  PFResult r = before_current(t);
  if (r == PF_OK && t->receipt.phase == PF_WRITE_NOOP) { *out = t->receipt; return PF_OK; }
  PFWriteMeta stage;
  if (r == PF_OK) r = observe(t, t->hold_fd, "after", &stage, NULL);
  if (r == PF_OK && !full_equal(&stage, &t->stage_meta)) r = PF_CHANGED;
  if (r == PF_OK && !t->apply_intent_ready) r = record(t, PF_WRITE_APPLY_INTENT, PF_OK, 0, NULL, NULL);
  if (r == PF_OK) r = before_current(t);
  if (r == PF_OK) r = observe(t, t->hold_fd, "after", &stage, NULL);
  if (r == PF_OK && !full_equal(&stage, &t->stage_meta)) r = PF_CHANGED;
  if (r == PF_OK) r = current(t);
  if (r != PF_OK) { t->poisoned = 1; receipt(t, PF_WRITE_CONFLICT, r, 0, NULL, NULL, out); return r; }
  W_BARRIER(3);
  int injected = W_FAULT(35);
  int renamed = injected ? -1 : renameatx_np(t->hold_fd, "after", pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), t->receipt.existed ? RENAME_SWAP : RENAME_EXCL);
  if (renamed != 0) { r = injected ? PF_UNSUPPORTED : io_error(); t->poisoned = 1; receipt(t, r == PF_IO ? PF_WRITE_UNKNOWN : PF_WRITE_CONFLICT, r, r == PF_IO ? 2u : 0u, NULL, NULL, out); return r; }
  W_BARRIER(4);
  PFWriteMeta target = {0}, displaced = {0};
  r = current(t);
  if (r == PF_OK) r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &target, NULL);
  if (r == PF_OK && !moved_equal(&target, &t->stage_meta)) r = PF_CHANGED;
  PFResult dr = t->receipt.existed ? observe(t, t->hold_fd, "after", &displaced, NULL) : PF_OK;
  if (r == PF_OK && dr != PF_OK) r = dr;
  if (r == PF_OK && t->receipt.existed && !moved_equal(&displaced, &t->before_meta)) r = PF_CHANGED;
  if (r == PF_OK) r = sync_dir(pf_native_parent_fd(t->parent));
  if (r == PF_OK) r = sync_dir(t->hold_fd);
  W_BARRIER(5);
  PFResult journal = record(t, r == PF_OK ? PF_WRITE_APPLIED : PF_WRITE_CONFLICT, r, 1, &target, &displaced);
  if (journal != PF_OK) { r = journal; t->poisoned = 1; receipt(t, PF_WRITE_UNKNOWN, r, 1, &target, &displaced, out); return r; }
  if (r != PF_OK) { t->poisoned = 1; receipt(t, PF_WRITE_CONFLICT, r, 1, &target, &displaced, out); return r; }
  PFWriteMeta final;
  r = current(t); if (r == PF_OK) r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &final, NULL);
  if (r == PF_OK && !full_equal(&final, &target)) r = PF_CHANGED;
  if (r != PF_OK) { t->poisoned = 1; receipt(t, PF_WRITE_UNKNOWN, r, 1, &target, &displaced, out); return r; }
  t->after_meta = target; receipt(t, PF_WRITE_APPLIED, PF_OK, 1, &target, &displaced, out); return PF_OK;
}
static PFResult after_current(PFWriteTxn *t, PFWriteMeta *target, PFWriteMeta *displaced) {
  PFResult r = current(t); if (r != PF_OK) return r;
  r = integrity(t); if (r != PF_OK) return r;
  r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), target, NULL);
  if (r == PF_OK && !full_equal(target, &t->after_meta)) r = PF_CHANGED;
  if (r == PF_OK && t->receipt.existed) {
    r = observe(t, t->hold_fd, "after", displaced, NULL);
    if (r == PF_OK && !moved_equal(displaced, &t->before_meta)) r = PF_CHANGED;
  }
  return r;
}
PFResult pf_writer_undo(PFWriteTxn *t, PFWriteReceipt *out) {
  if (out) memset(out, 0, sizeof(*out));
  if (!t || !out || t->undo_attempted || t->poisoned || (t->receipt.phase != PF_WRITE_APPLIED && t->receipt.phase != PF_WRITE_NOOP)) return PF_INVALID;
  t->undo_attempted = 1; if (!t->production_gate) t->start = now_ns();
  if (t->production_gate && !t->undo_intent_ready) return PF_INVALID;
  if (t->receipt.phase == PF_WRITE_NOOP) {
    PFResult r = before_current(t); if (r == PF_OK) *out = t->receipt; return r;
  }
  PFWriteMeta target = {0}, displaced = {0}, undo = {0};
  PFResult r = after_current(t, &target, &displaced);
  if (r == PF_OK && t->receipt.existed && !t->undo_intent_ready) r = stage_file(t, "undo-stage", t->before, t->before_size, 1, 1, &undo);
  if (r == PF_OK && t->receipt.existed && t->undo_intent_ready) undo = t->restored_meta;
  if (r == PF_OK && t->receipt.existed && !t->undo_intent_ready) t->restored_meta = undo;
  if (r == PF_OK && !t->undo_intent_ready) r = record(t, PF_WRITE_UNDO_INTENT, PF_OK, 0, &target, &displaced);
  if (r == PF_OK) r = after_current(t, &target, &displaced);
  if (r == PF_OK && t->receipt.existed) {
    PFWriteMeta staged;
    r = observe(t, t->hold_fd, "undo-stage", &staged, NULL);
    if (r == PF_OK && !full_equal(&staged, &undo)) r = PF_CHANGED;
  }
  if (r == PF_OK) r = current(t);
  if (r != PF_OK) { t->poisoned = 1; receipt(t, PF_WRITE_CONFLICT, r, 0, &target, &displaced, out); return r; }
  W_BARRIER(6);
  int injected = W_FAULT(36);
  int renamed = injected ? -1 : t->receipt.existed
    ? renameatx_np(t->hold_fd, "undo-stage", pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), RENAME_SWAP)
    : renameatx_np(pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), t->hold_fd, "undo-displaced", RENAME_EXCL);
  if (renamed != 0) { r = injected ? PF_UNSUPPORTED : io_error(); t->poisoned = 1; receipt(t, r == PF_IO ? PF_WRITE_UNKNOWN : PF_WRITE_CONFLICT, r, r == PF_IO ? 2u : 0u, NULL, NULL, out); return r; }
  W_BARRIER(7);
  PFWriteMeta actual = {0}, removed = {0}; r = current(t);
  PFResult dr = observe(t, t->hold_fd, t->receipt.existed ? "undo-stage" : "undo-displaced", &removed, NULL);
  if (r == PF_OK && dr != PF_OK) r = dr;
  if (r == PF_OK && !moved_equal(&removed, &t->after_meta)) r = PF_CHANGED;
  if (r == PF_OK && t->receipt.existed) {
    r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &actual, NULL);
    if (r == PF_OK && !moved_equal(&actual, &undo)) r = PF_CHANGED;
  } else if (r == PF_OK) {
    struct stat st;
    if (fstatat(pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) r = PF_CHANGED;
  }
  if (r == PF_OK) r = sync_dir(pf_native_parent_fd(t->parent));
  if (r == PF_OK) r = sync_dir(t->hold_fd);
  PFResult journal = record(t, r == PF_OK ? PF_WRITE_UNDONE : PF_WRITE_CONFLICT, r, 1, &actual, &removed);
  if (journal != PF_OK) { r = journal; t->poisoned = 1; receipt(t, PF_WRITE_UNKNOWN, r, 1, &actual, &removed, out); return r; }
  if (r == PF_OK) {
    PFWriteMeta last = {0}; r = current(t);
    if (r == PF_OK && t->receipt.existed) { r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &last, NULL); if (r == PF_OK && !full_equal(&last, &actual)) r = PF_CHANGED; }
    else if (r == PF_OK) { struct stat st; if (fstatat(pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) r = PF_CHANGED; }
  }
  if (r != PF_OK) t->poisoned = 1;
  else { t->restored_meta = actual; t->undo_displaced_meta = removed; }
  receipt(t, r == PF_OK ? PF_WRITE_UNDONE : PF_WRITE_CONFLICT, r, 1, &actual, &removed, out); return r;
}
static int generated_hold(const char name[PF_WRITER_HOLD_ID_BYTES]) {
 const size_t prefix=sizeof(PF_HOLD_PREFIX)-1,n=prefix+32;
 if(memcmp(name,PF_HOLD_PREFIX,prefix)||name[n]!=0)return 0;
 for(size_t i=prefix;i<n;i++)if(!((name[i]>='0'&&name[i]<='9')||(name[i]>='a'&&name[i]<='f')))return 0;
 for(size_t i=n+1;i<PF_WRITER_HOLD_ID_BYTES;i++)if(name[i])return 0;
 return 1;
}
/* This constructor is reachable only through an authenticated fresh local
 * grant. Names/records/checksums alone cannot call it over the transport. */
PFResult pf_native_writer_recover(PFRoot *root,const PFNativeWriterState *anchor,const PFSnapshot *before,uint64_t cutoff,PFWriteTxn **out) {
 if(!out)return PF_INVALID;*out=NULL;
 if(!anchor||!before||anchor->recipe!=before->recipe||anchor->recipe<1||anchor->recipe>3||anchor->record_count<1||anchor->record_count>PF_NATIVE_RECORDS||!generated_hold(anchor->hold_id)||memcmp(anchor->hold_id,anchor->receipt.hold_id,PF_WRITER_HOLD_ID_BYTES)||!anchor->hold.inode||cutoff<=now_ns())return PF_INVALID;
 if(anchor->receipt.existed!=before->exists||memcmp(&anchor->before,&before->meta,sizeof(anchor->before)))return PF_INVALID;
 PFWriteTxn *t=calloc(1,sizeof(*t));if(!t)return PF_IO;t->hold_fd=-1;t->start=now_ns();t->production_gate=1;t->production_cutoff=cutoff;t->recipe=anchor->recipe;t->receipt=anchor->receipt;
 PFResult r=pf_native_parent_open(root,t->recipe,&t->parent);PFBindingSet binding;
 if(r==PF_OK)r=pf_snapshot_bindings(t->parent,&binding);if(r==PF_OK&&memcmp(&binding,&before->bindings,sizeof(binding)))r=PF_CHANGED;
 struct stat st;if(r==PF_OK&&fstat(pf_native_profile_fd(t->parent),&st)==0)t->profile_identity=stamp_of(&st);else if(r==PF_OK)r=PF_IO;
 if(r==PF_OK&&!identity_equal(&t->profile_identity,&anchor->profile))r=PF_CHANGED;
 if(r==PF_OK&&fstat(pf_native_parent_fd(t->parent),&st)==0)t->parent_identity=stamp_of(&st);else if(r==PF_OK)r=PF_IO;
 if(r==PF_OK&&!identity_equal(&t->parent_identity,&anchor->parent))r=PF_CHANGED;
 memcpy(t->hold_id,anchor->hold_id,sizeof(t->hold_id));t->hold_identity=anchor->hold;t->hold_binding=anchor->hold_binding;
 if(r==PF_OK){t->hold_fd=openat(pf_native_profile_fd(t->parent),t->hold_id,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(t->hold_fd<0)r=io_error();}
 if(r==PF_OK)r=current(t);
 t->before_meta=before->meta;t->stage_meta=anchor->stage;t->before_size=(size_t)before->meta.stamp.size;t->after_size=(size_t)anchor->stage.stamp.size;
 if(r==PF_OK){t->before=calloc(t->before_size+1,1);t->after=calloc(t->after_size+1,1);if(!t->before||!t->after)r=PF_IO;else memcpy(t->before,before->bytes,t->before_size);}
 if(r==PF_OK){t->before_acl=before->acl_tag?acl_copy_int_native(before->acl):acl_init(0);if(!t->before_acl)r=PF_IO;memcpy(t->before_attrs,before->attrs,sizeof(t->before_attrs));}
 for(unsigned i=0;r==PF_OK&&i<2;i++){
  PFWriteMeta observed;r=observe(t,t->hold_fd,i?"snapshot-after":"snapshot-before",&observed,NULL);if(r==PF_OK&&!full_equal(&observed,&anchor->snapshots[i]))r=PF_CHANGED;else if(r==PF_OK)t->snapshots[i]=observed;
 }
 if(r==PF_OK){PFSnapshot *after=NULL;r=pf_snapshot_native(t->parent,t->hold_fd,"snapshot-after",t->recipe,&after);if(r==PF_OK&&(after->meta.stamp.size!=t->after_size||memcmp(after->meta.hash,anchor->stage.hash,32)))r=PF_CHANGED;if(r==PF_OK)memcpy(t->after,after->bytes,t->after_size);pf_snapshot_close(after);}
 for(unsigned i=0;r==PF_OK&&i<PF_NATIVE_RECORDS;i++){
  char name[32];(void)snprintf(name,sizeof(name),"record-%02u.bin",i);PFWriteMeta observed;PFResult found=observe(t,t->hold_fd,name,&observed,NULL);
  if(found==PF_UNAVAILABLE){if(i<anchor->record_count)r=PF_CHANGED;break;}
  if(found!=PF_OK){r=found;break;}
  if((observed.stamp.mode&07777)!=0600||observed.stamp.size!=sizeof(PFNativeRecord)){r=PF_UNSAFE;break;}
  if(i<anchor->record_count&&!full_equal(&observed,&anchor->records[i])){r=PF_CHANGED;break;}
  int fd=openat(t->hold_fd,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if(fd<0){r=io_error();break;}
  PFNativeRecord record_bytes;r=read_exact(t,fd,(unsigned char *)&record_bytes,sizeof(record_bytes));close(fd);
  unsigned char checksum[32];digest(&record_bytes,offsetof(PFNativeRecord,checksum),checksum);
  if(r==PF_OK&&(memcmp(record_bytes.magic,"PFWRTR01",8)||record_bytes.schema!=1||record_bytes.bytes!=sizeof(record_bytes)||record_bytes.recipe!=(unsigned)t->recipe||record_bytes.sequence!=i||record_bytes.phase<PF_WRITE_PREPARED||record_bytes.phase>PF_WRITE_UNKNOWN||record_bytes.result>PF_UNSUPPORTED||memcmp(checksum,record_bytes.checksum,32)||memcmp(record_bytes.hold_id,t->hold_id,sizeof(t->hold_id))))r=PF_UNSAFE;
  wipe(&record_bytes,sizeof(record_bytes));if(r==PF_OK){t->records[i]=observed;t->sequence=i+1;}
 }
 /* Reject unknown names, gaps or unsafe extras without traversing children. */
 if(r==PF_OK){int fd=openat(t->hold_fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);DIR *d=fd<0?NULL:fdopendir(fd);if(!d){if(fd>=0)close(fd);r=PF_IO;}else{struct dirent *e;unsigned count=0;errno=0;while((e=readdir(d))!=NULL){if(!strcmp(e->d_name,".")||!strcmp(e->d_name,".."))continue;if(++count>16){r=PF_TOO_LARGE;break;}int known=!strcmp(e->d_name,"after")||!strcmp(e->d_name,"snapshot-before")||!strcmp(e->d_name,"snapshot-after")||!strcmp(e->d_name,"undo-stage")||!strcmp(e->d_name,"undo-displaced");for(unsigned i=0;!known&&i<t->sequence;i++){char n[32];(void)snprintf(n,sizeof(n),"record-%02u.bin",i);known=!strcmp(n,e->d_name);}if(!known){r=PF_UNSAFE;break;}errno=0;}if(r==PF_OK&&errno)r=PF_IO;closedir(d);}}
 PFWriteMeta target={0},displaced={0},removed={0};int already_undone=0;
 if(r==PF_OK){PFResult observed=observe(t,pf_native_parent_fd(t->parent),pf_native_leaf(t->parent),&target,NULL);
  /* Only authenticated restore-stage identity authorizes this classification;
   * unsealed tail records never make an Undo stage trusted. */
  if(anchor->restore_stage.stamp.inode&&before->exists&&observed==PF_OK&&moved_equal(&target,&anchor->restore_stage)){
   r=observe(t,t->hold_fd,"undo-stage",&removed,NULL);if(r==PF_OK&&!moved_equal(&removed,&anchor->accepted_after))r=PF_CHANGED;already_undone=r==PF_OK;
  }else if(!before->exists&&observed==PF_UNAVAILABLE&&anchor->receipt.phase>=PF_WRITE_UNDO_INTENT){
   r=observe(t,t->hold_fd,"undo-displaced",&removed,NULL);if(r==PF_OK&&!moved_equal(&removed,&anchor->accepted_after))r=PF_CHANGED;already_undone=r==PF_OK;
  }else{
   r=observed;if(r==PF_OK){if(anchor->accepted_after.stamp.inode){if(!full_equal(&target,&anchor->accepted_after))r=PF_CHANGED;}else if(!moved_equal(&target,&anchor->stage))r=PF_CHANGED;}
  }
 }
 if(r==PF_OK&&before->exists){r=observe(t,t->hold_fd,"after",&displaced,NULL);if(r==PF_OK&&!moved_equal(&displaced,&before->meta))r=PF_CHANGED;}
 if(r==PF_OK&&!already_undone&&anchor->restore_stage.stamp.inode){
  PFWriteMeta staged;r=observe(t,t->hold_fd,"undo-stage",&staged,NULL);if(r==PF_OK&&!full_equal(&staged,&anchor->restore_stage))r=PF_CHANGED;
  if(r==PF_OK){t->restored_meta=staged;t->undo_intent_ready=1;t->recovered_undo_ready=1;}
 }
 if(r==PF_OK&&!already_undone&&t->sequence>PF_NATIVE_RECORDS-2)r=PF_TOO_LARGE;
 if(r==PF_OK){t->after_meta=already_undone?anchor->accepted_after:target;t->apply_attempted=1;
  if(already_undone){t->restored_meta=target;t->undo_displaced_meta=removed;t->undo_attempted=1;receipt(t,PF_WRITE_UNDONE,PF_OK,1,&target,&removed,NULL);}
  else receipt(t,PF_WRITE_APPLIED,PF_OK,1,&target,&displaced,NULL);
  r=current(t);
 }
 if(r!=PF_OK){pf_writer_close(t);return r;}*out=t;return PF_OK;
}
PFResult pf_native_writer_intent(PFWriteTxn *t,unsigned action,PFNativeWriterState *out) {
 if(out)memset(out,0,sizeof(*out));if(!t||!out||!t->production_gate||t->poisoned||(action!=1&&action!=2))return PF_INVALID;
 PFResult r;
 if(action==1){
  if(t->apply_attempted||t->apply_intent_ready)return PF_INVALID;
  r=before_current(t);PFWriteMeta stage;
  if(r==PF_OK&&t->receipt.phase!=PF_WRITE_NOOP)r=observe(t,t->hold_fd,"after",&stage,NULL);
  if(r==PF_OK&&t->receipt.phase!=PF_WRITE_NOOP&&!full_equal(&stage,&t->stage_meta))r=PF_CHANGED;
  if(r==PF_OK&&t->receipt.phase!=PF_WRITE_NOOP)r=record(t,PF_WRITE_APPLY_INTENT,PF_OK,0,NULL,NULL);
  if(r==PF_OK){t->apply_intent_ready=1;receipt(t,t->receipt.phase==PF_WRITE_NOOP?PF_WRITE_NOOP:PF_WRITE_APPLY_INTENT,PF_OK,0,NULL,NULL,NULL);}
 }else{
  if(t->undo_attempted||t->receipt.phase!=PF_WRITE_APPLIED)return PF_INVALID;
  if(t->undo_intent_ready){if(!t->recovered_undo_ready)return PF_INVALID;t->recovered_undo_ready=0;PFWriteMeta a,b,u;r=after_current(t,&a,&b);if(r==PF_OK&&t->receipt.existed){r=observe(t,t->hold_fd,"undo-stage",&u,NULL);if(r==PF_OK&&!full_equal(&u,&t->restored_meta))r=PF_CHANGED;}if(r!=PF_OK){t->poisoned=1;return r;}return pf_native_writer_state(t,out);}
  PFWriteMeta target,displaced,undo;r=after_current(t,&target,&displaced);
  if(r==PF_OK&&t->receipt.existed)r=stage_file(t,"undo-stage",t->before,t->before_size,1,1,&undo);
  if(r==PF_OK&&t->receipt.existed)t->restored_meta=undo;
  if(r==PF_OK)r=record(t,PF_WRITE_UNDO_INTENT,PF_OK,0,&target,&displaced);
  if(r==PF_OK){if(t->receipt.existed)t->restored_meta=undo;t->undo_intent_ready=1;}
 }
 if(r!=PF_OK){t->poisoned=1;return r;}return pf_native_writer_state(t,out);
}
PFResult pf_writer_check(PFWriteTxn *t, PFWriteReceipt *out) {
  if (out) memset(out, 0, sizeof(*out));
  if (!t || !out) return PF_INVALID;
  if (!t->production_gate) t->start = now_ns(); PFResult r = current(t);
  if (r == PF_OK) r = integrity(t);
  PFWriteMeta target = {0}, displaced = {0};
  if (r == PF_OK && t->receipt.phase == PF_WRITE_APPLIED) r = after_current(t, &target, &displaced);
  else if (r == PF_OK && (t->receipt.phase == PF_WRITE_PREPARED || t->receipt.phase == PF_WRITE_NOOP)) r = before_current(t);
  else if (r == PF_OK && t->receipt.phase == PF_WRITE_UNDONE) {
    if (t->receipt.existed) {
      r = observe(t, pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &target, NULL);
      if (r == PF_OK && !full_equal(&target, &t->restored_meta)) r = PF_CHANGED;
    } else { struct stat st; if (fstatat(pf_native_parent_fd(t->parent), pf_native_leaf(t->parent), &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) r = PF_CHANGED; }
    if (r == PF_OK) r = observe(t, t->hold_fd, t->receipt.existed ? "undo-stage" : "undo-displaced", &displaced, NULL);
    if (r == PF_OK && !full_equal(&displaced, &t->undo_displaced_meta)) r = PF_CHANGED;
    if (r == PF_OK && t->receipt.existed) { r = observe(t, t->hold_fd, "after", &displaced, NULL); if (r == PF_OK && !moved_equal(&displaced, &t->before_meta)) r = PF_CHANGED; }
  } else if (r == PF_OK) r = t->receipt.result;
  *out = t->receipt;
  if (r != PF_OK) { out->result = r; if (out->phase != PF_WRITE_UNKNOWN) out->phase = PF_WRITE_CONFLICT; }
  return r;
}
#else
struct PFWriteTxn { int unsupported; };
PFResult pf_writer_prepare(PFRoot *r, PFRecipe p, const PFStamp *e, const unsigned char *b, size_t n, const unsigned char *a, size_t m, PFWriteTxn **o) {
  (void)r; (void)p; (void)e; (void)b; (void)n; (void)a; (void)m; if (o) *o = NULL; return PF_UNSUPPORTED;
}
PFResult pf_writer_apply(PFWriteTxn *t, PFWriteReceipt *o) { (void)t; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED; }
PFResult pf_writer_undo(PFWriteTxn *t, PFWriteReceipt *o) { (void)t; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED; }
PFResult pf_writer_check(PFWriteTxn *t, PFWriteReceipt *o) { (void)t; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED; }
void pf_writer_close(PFWriteTxn *t) { (void)t; }
PFResult pf_native_writer_prepare_observed(PFRoot *r,PFRecipe p,const PFStamp *e,PFByteView b,PFByteView a,uint64_t c,PFWriteTxn **o,PFNativeWriterState *s){(void)r;(void)p;(void)e;(void)b;(void)a;(void)c;if(o)*o=NULL;if(s)memset(s,0,sizeof(*s));return PF_UNSUPPORTED;}
PFResult pf_native_writer_state(PFWriteTxn *t,PFNativeWriterState *s){(void)t;if(s)memset(s,0,sizeof(*s));return PF_UNSUPPORTED;}
PFResult pf_native_writer_intent(PFWriteTxn *t,unsigned a,PFNativeWriterState *s){(void)t;(void)a;if(s)memset(s,0,sizeof(*s));return PF_UNSUPPORTED;}
PFResult pf_native_writer_snapshot(PFWriteTxn *t,unsigned r,PFSnapshot **o){(void)t;(void)r;if(o)*o=NULL;return PF_UNSUPPORTED;}
PFResult pf_native_writer_current(PFWriteTxn *t){(void)t;return PF_UNSUPPORTED;}
PFResult pf_native_writer_restrict_cutoff(PFWriteTxn *t,uint64_t c){(void)t;(void)c;return PF_UNSUPPORTED;}
PFResult pf_native_writer_stamp(PFWriteTxn *t,unsigned r,PFStamp *o){(void)t;(void)r;if(o)memset(o,0,sizeof(*o));return PF_UNSUPPORTED;}
PFResult pf_native_writer_recover(PFRoot *r,const PFNativeWriterState *s,const PFSnapshot *b,uint64_t c,PFWriteTxn **o){(void)r;(void)s;(void)b;(void)c;if(o)*o=NULL;return PF_UNSUPPORTED;}
#endif
