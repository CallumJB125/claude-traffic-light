#include "reader.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/mount.h>
#include <time.h>
#endif

const char *pf_result_name(PFResult r) {
  static const char *const names[] = {"ok", "invalid", "unavailable", "unsafe", "changed", "too_large", "io", "deadline", "unsupported"};
  return (unsigned)r < sizeof(names) / sizeof(names[0]) ? names[r] : "invalid";
}
#if defined(__APPLE__) && defined(O_NOFOLLOW) && defined(O_NONBLOCK) && defined(O_DIRECTORY) && defined(O_CLOEXEC)
#define PF_COMPONENT_BYTES 256u
#define PF_TARGET_DEPTH 8u
#define PF_READ_NS UINT64_C(1000000000)
#ifdef PF_READER_TEST_HOOKS
extern void pf_reader_test_barrier(unsigned stage);
#define PF_BARRIER(stage) pf_reader_test_barrier(stage)
#else
#define PF_BARRIER(stage) ((void)0)
#endif
typedef struct { int fd; char name[PF_COMPONENT_BYTES]; PFStamp identity; } PFNode;
struct PFRoot { PFNode nodes[PF_READER_MAX_ANCESTORS]; size_t count; };
typedef struct { PFNode nodes[PF_TARGET_DEPTH]; size_t count; int fd; PFStamp stamp; } PFTarget;
/* This table must match transaction-targets.js. It is not a generic path API. */
static const char *recipe_path(PFRecipe recipe) {
  switch (recipe) {
    case PF_CODEX_INSTRUCTIONS: return ".codex/AGENTS.md";
    case PF_CLAUDE_SETTINGS: return ".claude/settings.json";
    case PF_GEMINI_SETTINGS: return ".gemini/settings.json";
    case PF_CODEX_CONFIG: return ".codex/config.toml";
    case PF_GIT_CONFIG: return ".gitconfig";
    case PF_GIT_XDG_CONFIG: return ".config/git/config";
    case PF_GHOSTTY_CONFIG: return ".config/ghostty/config";
    case PF_GHOSTTY_DARWIN_CONFIG: return "Library/Application Support/com.mitchellh.ghostty/config";
    default: return NULL;
  }
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
static int content_equal(const PFStamp *a, const PFStamp *b) {
  return identity_equal(a, b) && a->size == b->size && a->links == b->links
    && a->mtime_seconds == b->mtime_seconds && a->mtime_nanoseconds == b->mtime_nanoseconds
    && a->ctime_seconds == b->ctime_seconds && a->ctime_nanoseconds == b->ctime_nanoseconds;
}
static PFResult open_error(void) {
  if (errno == ENOENT) return PF_UNAVAILABLE;
  if (errno == ELOOP || errno == ENOTDIR) return PF_UNSAFE;
  return PF_IO;
}
static int component(const char *name) {
  size_t n = strlen(name);
  return n > 0 && n < PF_COMPONENT_BYTES && strcmp(name, ".") != 0 && strcmp(name, "..") != 0
    && strchr(name, '/') == NULL;
}
static PFResult directory(int parent, const char *name, int owned, PFNode *out) {
  struct stat st;
  if (!component(name)) return PF_INVALID;
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return open_error();
  if (fstat(fd, &st) != 0) { close(fd); return PF_IO; }
  if (!S_ISDIR(st.st_mode) || (owned && (st.st_uid != getuid() || (st.st_mode & 0022)))) { close(fd); return PF_UNSAFE; }
  out->fd = fd; strcpy(out->name, name); out->identity = stamp_of(&st);
  return PF_OK;
}
static PFResult node_current(int parent, const PFNode *node) {
  struct stat link, held;
  if (fstat(node->fd, &held) != 0 || fstatat(parent, node->name, &link, AT_SYMLINK_NOFOLLOW) != 0) return PF_CHANGED;
  PFStamp a = stamp_of(&held), b = stamp_of(&link);
  if (!S_ISDIR(link.st_mode) || !identity_equal(&node->identity, &a) || !identity_equal(&a, &b)) return PF_CHANGED;
  return PF_OK;
}
static PFResult root_current(PFRoot *root) {
  if (!root || root->count < 2 || root->count > PF_READER_MAX_ANCESTORS) return PF_INVALID;
  for (size_t i = 1; i < root->count; ++i) {
    PFResult r = node_current(root->nodes[i-1].fd, &root->nodes[i]); if (r != PF_OK) return r;
  }
  return PF_OK;
}
void pf_root_close(PFRoot *root) {
  if (!root) return;
  for (size_t i = 0; i < root->count; ++i) if (root->nodes[i].fd >= 0) close(root->nodes[i].fd);
  memset(root, 0, sizeof(*root)); free(root);
}
PFResult pf_root_open(const char *canonical_profile, const PFStamp *expected, PFRoot **out) {
  if (!out) return PF_INVALID;
  *out = NULL;
  if (!canonical_profile || canonical_profile[0] != '/' || strlen(canonical_profile) >= PATH_MAX
      || strcmp(canonical_profile, "/") == 0) return PF_INVALID;
  char resolved[PATH_MAX], copy[PATH_MAX];
  if (!realpath(canonical_profile, resolved)) return open_error();
  if (strcmp(resolved, canonical_profile) != 0) return PF_UNSAFE;
  strcpy(copy, canonical_profile + 1);
  PFRoot *root = calloc(1, sizeof(*root)); if (!root) return PF_IO;
  root->nodes[0].fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root->nodes[0].fd < 0) { free(root); return PF_IO; }
  root->count = 1;
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (root->count >= PF_READER_MAX_ANCESTORS) { pf_root_close(root); return PF_TOO_LARGE; }
    PFResult r = directory(root->nodes[root->count-1].fd, part, 0, &root->nodes[root->count]);
    if (r != PF_OK) { pf_root_close(root); return r; }
    root->count++;
  }
  PFStamp *last = &root->nodes[root->count-1].identity;
  struct statfs filesystem;
  if (last->uid != getuid() || (last->mode & 0022)) { pf_root_close(root); return PF_UNSAFE; }
  if (fstatfs(root->nodes[root->count-1].fd, &filesystem) != 0) { pf_root_close(root); return PF_IO; }
  if (!(filesystem.f_flags & MNT_LOCAL)) { pf_root_close(root); return PF_UNSUPPORTED; }
  if (expected && !identity_equal(expected, last)) { pf_root_close(root); return PF_CHANGED; }
  PFResult r = root_current(root); if (r != PF_OK) { pf_root_close(root); return r; }
  *out = root; return PF_OK;
}
PFResult pf_root_identity(PFRoot *root, PFStamp *out) {
  if (!out) return PF_INVALID;
  memset(out, 0, sizeof(*out)); PFResult r = root_current(root);
  if (r == PF_OK) *out = root->nodes[root->count-1].identity;
  return r;
}
static void target_close(PFTarget *target) {
  if (target->fd >= 0) close(target->fd);
  for (size_t i = 0; i < target->count; ++i) close(target->nodes[i].fd);
}
static PFResult target_current(PFRoot *root, PFTarget *target, const char *leaf) {
  PFResult r = root_current(root); if (r != PF_OK) return r;
  int parent = root->nodes[root->count-1].fd;
  for (size_t i = 0; i < target->count; ++i) {
    r = node_current(parent, &target->nodes[i]); if (r != PF_OK) return r;
    parent = target->nodes[i].fd;
  }
  struct stat named, opened;
  if (fstatat(parent, leaf, &named, AT_SYMLINK_NOFOLLOW) != 0 || fstat(target->fd, &opened) != 0) return PF_CHANGED;
  PFStamp a = stamp_of(&named), b = stamp_of(&opened);
  return S_ISREG(named.st_mode) && content_equal(&a, &b) && content_equal(&b, &target->stamp) ? PF_OK : PF_CHANGED;
}
static PFResult target_open(PFRoot *root, PFRecipe recipe, PFTarget *target, char *leaf) {
  memset(target, 0, sizeof(*target)); target->fd = -1;
  const char *relative = recipe_path(recipe); if (!relative) return PF_INVALID;
  PFResult r = root_current(root); if (r != PF_OK) return r;
  char copy[PATH_MAX]; strcpy(copy, relative); char *save = NULL;
  char *part = strtok_r(copy, "/", &save); int parent = root->nodes[root->count-1].fd;
  for (;;) {
    char *next = strtok_r(NULL, "/", &save);
    if (!next) break;
    if (target->count >= PF_TARGET_DEPTH) { target_close(target); return PF_TOO_LARGE; }
    r = directory(parent, part, 1, &target->nodes[target->count]);
    if (r != PF_OK) { target_close(target); return r; }
    if (target->nodes[target->count].identity.device != root->nodes[root->count-1].identity.device) {
      close(target->nodes[target->count].fd); target_close(target); return PF_UNSAFE;
    }
    parent = target->nodes[target->count++].fd; part = next;
  }
  strcpy(leaf, part);
  /* Nonblocking is set before open: FIFO replacement cannot block before fstat. */
  PF_BARRIER(1);
  target->fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (target->fd < 0) { r = open_error(); target_close(target); return r; }
  PF_BARRIER(2);
  struct stat st;
  if (fstat(target->fd, &st) != 0) { target_close(target); return PF_IO; }
  if (!S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 0022)) { target_close(target); return PF_UNSAFE; }
  target->stamp = stamp_of(&st);
  if (target->stamp.device != root->nodes[root->count-1].identity.device) { target_close(target); return PF_UNSAFE; }
  if (target->stamp.size > PF_READER_MAX_BYTES) { target_close(target); return PF_TOO_LARGE; }
  r = target_current(root, target, leaf); if (r != PF_OK) target_close(target);
  return r;
}
PFResult pf_inspect_fixed(PFRoot *root, PFRecipe recipe, PFStamp *out) {
  if (!out) return PF_INVALID;
  memset(out, 0, sizeof(*out)); PFTarget target; char leaf[PF_COMPONENT_BYTES];
  PFResult r = target_open(root, recipe, &target, leaf); if (r != PF_OK) return r;
  *out = target.stamp; target_close(&target); return PF_OK;
}
static uint64_t mono_ns(void) {
  struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
}
PFResult pf_read_fixed(PFRoot *root, PFRecipe recipe, const PFStamp *expected,
                      unsigned char *bytes, size_t capacity, size_t *size, PFStamp *out) {
  if (size) *size = 0;
  if (out) memset(out, 0, sizeof(*out));
  if (!expected || !bytes || !size || !out || capacity == 0 || capacity > PF_READER_MAX_BYTES) return PF_INVALID;
  PFTarget target; char leaf[PF_COMPONENT_BYTES]; PFResult r = target_open(root, recipe, &target, leaf);
  if (r != PF_OK) return r;
  if (!content_equal(expected, &target.stamp)) { target_close(&target); return PF_CHANGED; }
  if (target.stamp.size > capacity) { target_close(&target); return PF_TOO_LARGE; }
  size_t read_bytes = 0; uint64_t start = mono_ns(); if (!start) r = PF_IO;
  while (r == PF_OK && read_bytes < (size_t)target.stamp.size) {
    uint64_t now = mono_ns(); if (!now) { r = PF_IO; break; }
    if (now - start >= PF_READ_NS) { r = PF_DEADLINE; break; }
    size_t wanted = (size_t)target.stamp.size - read_bytes; if (wanted > 4096u) wanted = 4096u;
    ssize_t n = read(target.fd, bytes + read_bytes, wanted);
    if (n < 0) { if (errno == EINTR) continue; r = PF_IO; break; }
    if (n == 0) { r = PF_CHANGED; break; }
    read_bytes += (size_t)n;
    PF_BARRIER(3);
  }
  if (r == PF_OK) {
    unsigned char extra; ssize_t n;
    do { n = read(target.fd, &extra, 1); } while (n < 0 && errno == EINTR && mono_ns() - start < PF_READ_NS);
    if (n < 0) r = PF_IO; else if (n != 0) r = PF_CHANGED;
  }
  if (r == PF_OK) { PF_BARRIER(4); r = target_current(root, &target, leaf); }
  if (r == PF_OK && mono_ns() - start >= PF_READ_NS) r = PF_DEADLINE;
  if (r == PF_OK) { *size = read_bytes; *out = target.stamp; }
  else if (read_bytes) memset(bytes, 0, read_bytes);
  target_close(&target); return r;
}
#else
struct PFRoot { int unsupported; };
PFResult pf_root_open(const char *p, const PFStamp *e, PFRoot **o) { (void)p; (void)e; if (o) *o = NULL; return PF_UNSUPPORTED; }
PFResult pf_root_identity(PFRoot *r, PFStamp *o) { (void)r; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED; }
void pf_root_close(PFRoot *r) { (void)r; }
PFResult pf_inspect_fixed(PFRoot *r, PFRecipe p, PFStamp *o) { (void)r; (void)p; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED; }
PFResult pf_read_fixed(PFRoot *r, PFRecipe p, const PFStamp *e, unsigned char *b, size_t c, size_t *s, PFStamp *o) {
  (void)r; (void)p; (void)e; (void)b; (void)c; if (s) *s = 0; if (o) memset(o, 0, sizeof(*o)); return PF_UNSUPPORTED;
}
#endif
