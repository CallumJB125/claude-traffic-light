#define _DARWIN_C_SOURCE
#include "writer.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <membership.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>
#if !defined(__APPLE__)
#error Actual Darwin namespace/ACL fixtures are required.
#endif
static char base[PATH_MAX], profile[PATH_MAX], folder[PATH_MAX], file[PATH_MAX], hold[PATH_MAX];
static const char original[] = "ORIGINAL SYNTHETIC INSTRUCTIONS\r\n";
static const char desired[] = "ORIGINAL SYNTHETIC INSTRUCTIONS\r\nNEW OWNED BLOCK\r\n";
static int cases, failures, previous_failures, action, fired, fault, crash_stage, old_fd = -1;
static void must(int condition) { if (!condition) { perror("writer fixture"); fprintf(stderr, "retained fixture %s\n", base); exit(99); } }
static void join(char *out, const char *a, const char *b) { char value[PATH_MAX]; int n = snprintf(value, sizeof(value), "%s/%s", a, b); must(n > 0 && n < PATH_MAX); memcpy(out, value, (size_t)n+1); }
static void check(int condition, const char *label) { printf("%s %d - %s\n", condition ? "ok" : "not ok", ++cases, label); fflush(stdout); if (!condition) ++failures; }
static void put(const char *name, const char *bytes) {
  int fd = open(name, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600); must(fd >= 0);
  size_t at = 0, size = strlen(bytes); while (at < size) { ssize_t n = write(fd, bytes+at, size-at); must(n > 0); at += (size_t)n; }
  must(close(fd) == 0);
}
static int equals(const char *name, const char *bytes) {
  char got[1024]; int fd = open(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); if (fd < 0) return 0;
  struct stat st; if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return 0; }
  ssize_t n = read(fd, got, sizeof(got)); close(fd); return n == (ssize_t)strlen(bytes) && memcmp(got, bytes, (size_t)n) == 0;
}
static int clear_acl(const char *p, const struct stat *s, int type, struct FTW *info) {
  (void)s; (void)info; if (type == FTW_SL || type == FTW_SLN) return 0;
  acl_t empty = acl_init(0); must(empty != NULL); must(acl_set_file(p, ACL_TYPE_EXTENDED, empty) == 0); must(acl_free(empty) == 0); return 0;
}
static int remove_entry(const char *p, const struct stat *s, int type, struct FTW *info) { (void)s; (void)type; (void)info; return remove(p); }
static void reset(void) {
  if (old_fd >= 0) { must(close(old_fd) == 0); old_fd = -1; }
  if (base[0] && failures == previous_failures) { must(nftw(base, clear_acl, 32, FTW_PHYS) == 0); must(nftw(base, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0); }
  else if (base[0]) fprintf(stderr, "retained failed fixture %s\n", base);
  previous_failures = failures;
  char pattern[] = "/tmp/pf-writer-fixture-XXXXXX"; must(mkdtemp(pattern) != NULL); must(realpath(pattern, base) != NULL);
  join(profile, base, "profile"); must(mkdir(profile, 0700) == 0);
  join(folder, profile, ".codex"); must(mkdir(folder, 0700) == 0); join(file, folder, "AGENTS.md"); put(file, original);
  action = fired = fault = crash_stage = 0; hold[0] = 0;
}
static PFRoot *root_open(void) { PFRoot *root = NULL; must(pf_root_open(profile, NULL, &root) == PF_OK); return root; }
static PFWriteTxn *prepare(PFRoot *root, int exists) {
  PFStamp stamp; if (exists) must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK);
  PFWriteTxn *txn = NULL;
  PFResult result = pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, exists ? &stamp : NULL,
    (const unsigned char *)original, exists ? sizeof(original)-1 : 0, (const unsigned char *)desired, sizeof(desired)-1, &txn);
  if (result != PF_OK) fprintf(stderr, "prepare result %s\n", pf_result_name(result));
  must(result == PF_OK && txn != NULL);
  PFWriteReceipt receipt; must(pf_writer_check(txn, &receipt) == PF_OK); join(hold, profile, receipt.hold_id); return txn;
}
static void everyone(const char *target, const char *grant) {
  pid_t child = fork(); must(child >= 0);
  if (!child) { execl("/bin/chmod", "chmod", "+a", grant, target, (char *)NULL); _exit(99); }
  int status; must(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static unsigned acl_entries(const char *target) {
  int fd = open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); must(fd >= 0); errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) { must(errno == ENOENT); close(fd); return 0; }
  unsigned count = 0; acl_entry_t e; while (acl_get_entry(acl, count ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &e) == 0) count++;
  must(acl_free(acl) == 0 && close(fd) == 0); return count;
}
int pf_writer_test_fault(unsigned stage) { return fault == (int)stage; }
void pf_reader_test_barrier(unsigned stage) { (void)stage; }
void pf_writer_test_barrier(unsigned stage) {
  if (crash_stage == (int)stage) _exit(40);
  if (!action || fired) return;
  char moved[PATH_MAX], other[PATH_MAX];
  if (stage == 10 && action >= 22 && action <= 24) {
    fired = 1; DIR *dir = opendir(profile); must(dir != NULL); struct dirent *e;
    while ((e = readdir(dir)) != NULL) if (strncmp(e->d_name, ".plexiform-setups-hold-", sizeof(".plexiform-setups-hold-")-1) == 0) join(hold, profile, e->d_name);
    closedir(dir); join(other, hold, action == 24 ? "undo-stage" : "after");
    if (action == 22) must(chmod(other, 0640) == 0);
    if (action == 23) everyone(other, "everyone allow read,readattr,readsecurity");
    if (action == 24) { struct timespec times[2] = {{0, UTIME_OMIT}, {1, 0}}; must(utimensat(AT_FDCWD, other, times, AT_SYMLINK_NOFOLLOW) == 0); }
  }
  else if ((stage == 8 && action == 20) || (stage == 9 && action == 21)) {
    fired = 1; DIR *dir = opendir(profile); must(dir != NULL); struct dirent *e;
    while ((e = readdir(dir)) != NULL) if (strncmp(e->d_name, ".plexiform-setups-hold-", sizeof(".plexiform-setups-hold-")-1) == 0) join(hold, profile, e->d_name);
    closedir(dir);
    if (action == 20) { join(moved, base, "original-created-hold"); must(rename(hold, moved) == 0 && mkdir(hold, 0700) == 0); }
    everyone(hold, "everyone allow read,search"); join(other, hold, "foreign"); put(other, "FOREIGN-CREATE-GAP");
  }
  else if (stage == 3 && action == 18) { fired = 1; must(setxattr(file, "com.apple.quarantine", "SYNTHETIC-LATE-OPAQUE", 21, 0, 0) == 0); }
  else if (stage == 6 && action == 19) { fired = 1; must(setxattr(file, "com.apple.quarantine", "SYNTHETIC-UNDO-OPAQUE", 21, 0, 0) == 0); }
  else if (stage == 3 && action >= 1 && action <= 9) {
    fired = 1;
    if (action <= 5) {
      join(moved, profile, "external-original"); must(rename(file, moved) == 0);
      if (action == 1) put(file, "FOREIGN-LATE");
      if (action == 2) { join(other, base, "foreign-source"); put(other, "FOREIGN-DO-NOT-FOLLOW"); must(symlink(other, file) == 0); }
      if (action == 3) must(mkfifo(file, 0600) == 0);
      if (action == 4) { must(mkdir(file, 0700) == 0); join(other, file, "foreign-child"); put(other, "FOREIGN-DIRECTORY-BYTES"); }
      if (action == 5) { must(link(moved, file) == 0); }
    }
    if (action == 6) {
      join(moved, profile, ".codex-moved"); must(rename(folder, moved) == 0); must(mkdir(folder, 0700) == 0); put(file, "FOREIGN-PARENT");
    }
    if (action == 7) {
      join(moved, base, "profile-moved"); must(rename(profile, moved) == 0); must(mkdir(profile, 0700) == 0); must(mkdir(folder, 0700) == 0); put(file, "FOREIGN-ROOT");
    }
    if (action == 8) everyone(file, "everyone allow write");
    if (action == 9) everyone(folder, "everyone allow add_file,delete_child");
  } else if (stage == 4 && action >= 10 && action <= 13) {
    fired = 1;
    if (action == 10) { must(old_fd >= 0 && ftruncate(old_fd, 0) == 0 && write(old_fd, "OLD-FD-FOREIGN", 14) == 14); }
    if (action == 11) put(file, "FOREIGN-AFTER-SWAP");
    if (action == 12) everyone(folder, "everyone allow add_file");
    if (action == 13) fault = 33;
  } else if (stage == 6 && action >= 14 && action <= 16) {
    fired = 1;
    if (action <= 15) { join(moved, profile, "external-after"); must(rename(file, moved) == 0); put(file, "FOREIGN-UNDO"); }
    else { join(moved, profile, ".codex-moved"); must(rename(folder, moved) == 0); must(mkdir(folder, 0700) == 0); put(file, "FOREIGN-UNDO-PARENT"); }
  } else if (stage == 2 && action == 17) { fired = 1; put(file, "FOREIGN-DURING-PREPARE"); }
}
static unsigned hold_count(void) {
  DIR *dir = opendir(profile); must(dir != NULL); unsigned n = 0; struct dirent *e;
  while ((e = readdir(dir)) != NULL) if (strncmp(e->d_name, ".plexiform-setups-hold-", sizeof(".plexiform-setups-hold-")-1) == 0) n++;
  closedir(dir); return n;
}
static int regular_mode(const char *name, mode_t mode) { struct stat s; return lstat(name, &s) == 0 && S_ISREG(s.st_mode) && (s.st_mode & 0777) == mode; }
static int attr_equals(const char *target, const char *name, const unsigned char *bytes, size_t size) {
  unsigned char got[16384]; int fd = open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); if (fd < 0) return 0;
  ssize_t n = fgetxattr(fd, name, got, sizeof(got), 0, 0); close(fd); return n == (ssize_t)size && memcmp(got, bytes, size) == 0;
}
typedef struct { unsigned char magic[8]; uint32_t schema, bytes, phase, result, sequence, effect, existed, recipe; } RecordHeader;
static int record_header(const char *directory, unsigned index, unsigned phase, unsigned effect) {
  char name[64], filename[PATH_MAX]; (void)snprintf(name, sizeof(name), "record-%02u.bin", index); join(filename, directory, name);
  int fd = open(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); if (fd < 0) return 0;
  RecordHeader h; ssize_t n = read(fd, &h, sizeof(h)); struct stat s; int stat_ok = fstat(fd, &s) == 0; close(fd);
  return n == sizeof(h) && stat_ok && memcmp(h.magic, "PFWRTR01", 8) == 0 && h.schema == 1 && h.bytes == s.st_size && h.sequence == index && h.phase == phase && h.effect == effect;
}
static void race(unsigned code, const char *label) {
  reset(); PFRoot *root = root_open(); PFWriteTxn *txn = prepare(root, 1);
  if (code == 10) { old_fd = open(file, O_WRONLY); must(old_fd >= 0); }
  action = (int)code; PFWriteReceipt receipt; alarm(3); PFResult r = pf_writer_apply(txn, &receipt); alarm(0);
  char displaced[PATH_MAX]; join(displaced, hold, "after"); struct stat s;
  int retained = lstat(displaced, &s) == 0;
  if (code == 1) retained = retained && equals(displaced, "FOREIGN-LATE") && equals(file, desired);
  if (code == 2) { char foreign[PATH_MAX]; join(foreign, base, "foreign-source"); retained = retained && S_ISLNK(s.st_mode) && equals(foreign, "FOREIGN-DO-NOT-FOLLOW"); }
  if (code == 3) retained = retained && S_ISFIFO(s.st_mode);
  if (code == 4) { char child[PATH_MAX]; join(child, displaced, "foreign-child"); retained = retained && S_ISDIR(s.st_mode) && equals(child, "FOREIGN-DIRECTORY-BYTES"); }
  if (code == 5) retained = retained && S_ISREG(s.st_mode) && s.st_nlink == 2;
  if (code == 6) retained = retained && equals(file, "FOREIGN-PARENT");
  if (code == 7) { char moved_profile[PATH_MAX], moved_hold[PATH_MAX]; join(moved_profile, base, "profile-moved"); join(moved_hold, moved_profile, receipt.hold_id); join(displaced, moved_hold, "after"); retained = equals(displaced, original) && equals(file, "FOREIGN-ROOT"); }
  if (code == 8) retained = retained && acl_entries(displaced) > 0;
  if (code == 9 || code == 12 || code == 13) retained = retained && equals(displaced, original);
  if (code == 10) retained = retained && equals(displaced, "OLD-FD-FOREIGN") && equals(file, desired);
  if (code == 11) retained = retained && equals(displaced, original) && equals(file, "FOREIGN-AFTER-SWAP");
  check(fired && r != PF_OK && receipt.namespace_effect == 1 && retained && pf_writer_apply(txn, &receipt) == PF_INVALID && pf_writer_undo(txn, &receipt) == PF_INVALID, label);
  pf_writer_close(txn); pf_root_close(root);
}
static void crash(unsigned stage, const char *label) {
  reset(); pid_t child = fork(); must(child >= 0);
  if (!child) { PFRoot *root = root_open(); PFWriteTxn *txn = prepare(root, 1); PFWriteReceipt receipt; crash_stage = (int)stage; (void)pf_writer_apply(txn, &receipt); _exit(99); }
  int status; must(waitpid(child, &status, 0) == child);
  DIR *dir = opendir(profile); must(dir != NULL); struct dirent *e; hold[0] = 0;
  while ((e = readdir(dir)) != NULL) if (strncmp(e->d_name, ".plexiform-setups-hold-", sizeof(".plexiform-setups-hold-")-1) == 0) join(hold, profile, e->d_name);
  closedir(dir); char displaced[PATH_MAX]; join(displaced, hold, "after");
  PFRoot *root = root_open(); PFStamp stamp; int observed = pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK; pf_root_close(root);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 40 && observed && record_header(hold, 1, PF_WRITE_APPLY_INTENT, 0)
    && equals(file, stage == 3 ? original : desired) && equals(displaced, stage == 3 ? desired : original), label);
}
int main(void) {
  puts("TAP version 13"); reset(); PFRoot *root = root_open(); PFWriteTxn *txn = prepare(root, 1); PFWriteReceipt receipt;
  char path[PATH_MAX]; join(path, hold, "snapshot-before");
  check(equals(file, original) && equals(path, original) && record_header(hold, 0, PF_WRITE_PREPARED, 0), "prepare persists exact snapshots and native intent without touching target");
  struct stat hold_stat; must(lstat(hold, &hold_stat) == 0);
  check(S_ISDIR(hold_stat.st_mode) && (hold_stat.st_mode & 07777) == 0700 && acl_entries(hold) == 0 && regular_mode(path, 0600), "plaintext snapshots stay inside generated private directory");
  pf_root_close(root); root = NULL;
  check(pf_writer_apply(txn, &receipt) == PF_OK && receipt.phase == PF_WRITE_APPLIED && equals(file, desired) && record_header(hold, 1, PF_WRITE_APPLY_INTENT, 0) && record_header(hold, 2, PF_WRITE_APPLIED, 1), "retained native capability survives original reader close and applies exact bytes");
  join(path, hold, "after"); check(equals(path, original), "actual original inode retained after existing SWAP");
  check(pf_writer_apply(txn, &receipt) == PF_INVALID, "ordinary repeat Apply cannot duplicate mutation");
  check(pf_writer_undo(txn, &receipt) == PF_OK && receipt.phase == PF_WRITE_UNDONE && equals(file, original) && pf_writer_check(txn, &receipt) == PF_OK, "conditional existing Undo restores exact original bytes");
  check(equals(path, original) && record_header(hold, 3, PF_WRITE_UNDO_INTENT, 0) && record_header(hold, 4, PF_WRITE_UNDONE, 1), "Undo retains first displaced inode and durable records");
  join(path, hold, "undo-stage"); check(equals(path, desired) && pf_writer_undo(txn, &receipt) == PF_INVALID, "Undo retains actual removed after inode and refuses replay");
  put(file, "FOREIGN-POST-UNDO"); check(pf_writer_check(txn, &receipt) == PF_CHANGED && equals(file, "FOREIGN-POST-UNDO"), "later foreign edit is reported by Check without reverting");
  pf_writer_close(txn); check(hold_count() == 1, "closing capability never prunes private recovery objects");
  reset(); must(unlink(file) == 0); root = root_open(); txn = prepare(root, 0);
  check(pf_writer_apply(txn, &receipt) == PF_OK && equals(file, desired), "absent fixed leaf uses actual exclusive rename");
  check(pf_writer_undo(txn, &receipt) == PF_OK && access(file, F_OK) != 0 && pf_writer_check(txn, &receipt) == PF_OK, "new-file Undo retains claimed inode instead of unlink");
  join(path, hold, "undo-displaced"); check(equals(path, desired), "new-file Undo bytes remain recoverable"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); PFStamp stamp; must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK);
  must(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)original, sizeof(original)-1, &txn) == PF_OK);
  check(hold_count() == 0 && pf_writer_apply(txn, &receipt) == PF_OK && receipt.phase == PF_WRITE_NOOP && pf_writer_undo(txn, &receipt) == PF_OK && equals(file, original), "exact no-op leaves inode and storage untouched"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); stamp.inode++;
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_CHANGED && txn == NULL && hold_count() == 0, "stale planned inode refuses before private staging");
  check(pf_writer_prepare(root, PF_CODEX_CONFIG, NULL, NULL, 0, NULL, 0, &txn) == PF_UNSUPPORTED && txn == NULL, "remaining format recipes stay unavailable in first writer");
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, NULL, NULL, 0, NULL, PF_READER_MAX_BYTES+1, &txn) == PF_INVALID && txn == NULL, "invalid bytes cannot form a capability"); pf_root_close(root);
  reset(); root = root_open();
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, NULL, NULL, 0, (const unsigned char *)desired, PF_READER_MAX_BYTES+1, &txn) == PF_TOO_LARGE && txn == NULL && hold_count() == 0, "encoded-byte bound refuses before copying or staging"); pf_root_close(root);
  reset(); root = root_open(); char missing[PATH_MAX]; join(missing, profile, ".claude/settings.json");
  check(pf_writer_prepare(root, PF_CLAUDE_SETTINGS, NULL, NULL, 0, (const unsigned char *)"{}", 2, &txn) == PF_UNAVAILABLE && txn == NULL && access(missing, F_OK) != 0 && hold_count() == 0, "missing fixed parent refuses without directory creation"); pf_root_close(root);
  const char *folders[] = {".claude", ".gemini"};
  for (unsigned i = 0; i < 2; ++i) {
    reset(); char dir[PATH_MAX], target[PATH_MAX]; join(dir, profile, folders[i]); must(mkdir(dir, 0700) == 0); join(target, dir, "settings.json");
    const char *json_before = "{\r\n  \"foreign\" : [1, true],\r\n  \"ours\" : 1\r\n}\r\n";
    const char *json_after = "{\r\n  \"foreign\" : [1, true],\r\n  \"ours\" : 2\r\n}\r\n";
    put(target, json_before); must(chmod(target, 0644) == 0); root = root_open(); must(pf_inspect_fixed(root, (PFRecipe)(i+2), &stamp) == PF_OK);
    must(pf_writer_prepare(root, (PFRecipe)(i+2), &stamp, (const unsigned char *)json_before, strlen(json_before), (const unsigned char *)json_after, strlen(json_after), &txn) == PF_OK);
    check(pf_writer_apply(txn, &receipt) == PF_OK && equals(target, json_after) && regular_mode(target, 0644) && pf_writer_undo(txn, &receipt) == PF_OK && equals(target, json_before) && regular_mode(target, 0644), "fixed JSON recipe persists already-reviewed exact CRLF/foreign ranges and original mode");
    pf_writer_close(txn); pf_root_close(root);
  }
  for (unsigned i = 1; i <= 13; ++i) {
    const char *labels[] = {"", "late foreign regular inode retained and conflict reported", "late symlink exchanged but never followed or deleted", "late FIFO retained without blocking", "late foreign directory retained without traversal", "late hardlink refused after actual displacement and retained", "late parent retarget cannot redirect into replacement", "late profile retarget preserves new profile and actual intent", "late unsafe leaf ACL retained and fails observation", "late parent ACL stops subsequent effects with recoverable intent", "old open fd writes stay on actual retained original inode", "post-swap editor bytes survive without blind rollback", "post-swap ACL change produces uncertain receipt", "post-swap directory-sync failure retains both versions and intent"};
    race(i, labels[i]);
  }
  for (unsigned i = 14; i <= 16; ++i) {
    reset(); root = root_open(); int exists = i != 15; if (!exists) must(unlink(file) == 0); txn = prepare(root, exists); must(pf_writer_apply(txn, &receipt) == PF_OK);
    action = (int)i; PFResult result = pf_writer_undo(txn, &receipt); join(path, hold, exists ? "undo-stage" : "undo-displaced");
    check(fired && result != PF_OK && receipt.namespace_effect == 1 && (i == 16 ? equals(file, "FOREIGN-UNDO-PARENT") : equals(path, "FOREIGN-UNDO")), "actual foreign race during Undo is retained and reported, never called CAS"); pf_writer_close(txn); pf_root_close(root);
  }
  reset(); root = root_open(); txn = prepare(root, 1); old_fd = open(file, O_WRONLY); must(old_fd >= 0); must(pf_writer_apply(txn, &receipt) == PF_OK);
  must(ftruncate(old_fd, 0) == 0 && write(old_fd, "OLD-FD-LATE", 11) == 11); join(path, hold, "after");
  check(pf_writer_check(txn, &receipt) == PF_CHANGED && pf_writer_undo(txn, &receipt) == PF_CHANGED && equals(path, "OLD-FD-LATE") && equals(file, desired), "old-fd edit after accepted Apply prevents Undo and remains recoverable"); pf_writer_close(txn); pf_root_close(root);
  const char *tamper[] = {"after", "snapshot-before", "snapshot-after", "record-00.bin"};
  for (unsigned i = 0; i < 4; ++i) {
    reset(); root = root_open(); txn = prepare(root, 1); join(path, hold, tamper[i]); put(path, "FOREIGN-TAMPER");
    check(pf_writer_apply(txn, &receipt) == PF_CHANGED && receipt.namespace_effect == 0 && equals(file, original) && equals(path, "FOREIGN-TAMPER"), "changed owned stage/snapshot/native record refuses without target effect"); pf_writer_close(txn); pf_root_close(root);
  }
  reset(); root = root_open(); txn = prepare(root, 1); char moved_hold[PATH_MAX]; join(moved_hold, profile, "external-hold"); must(rename(hold, moved_hold) == 0 && mkdir(hold, 0700) == 0); join(path, hold, "foreign"); put(path, "FOREIGN-HOLD");
  check(pf_writer_apply(txn, &receipt) == PF_CHANGED && equals(file, original) && equals(path, "FOREIGN-HOLD"), "replacement hold is never adopted or cleaned"); pf_writer_close(txn); pf_root_close(root);
  reset(); everyone(profile, "everyone allow read,search,file_inherit,directory_inherit"); root = root_open(); txn = prepare(root, 1);
  check(acl_entries(profile) > 0 && acl_entries(hold) == 0 && pf_writer_apply(txn, &receipt) == PF_OK, "new exclusive private hold strips inherited read grants while existing profile ACL stays intact"); pf_writer_close(txn); pf_root_close(root);
  reset(); everyone(file, "everyone allow read,readattr,readsecurity"); root = root_open(); txn = prepare(root, 1);
  check(pf_writer_apply(txn, &receipt) == PF_OK && acl_entries(file) > 0 && pf_writer_undo(txn, &receipt) == PF_OK && acl_entries(file) > 0, "safe existing read ACL is preserved on approved replacement and Undo"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); must(setxattr(file, "com.example.synthetic", "MARKER", 6, 0, 0) == 0);
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_UNSUPPORTED && txn == NULL && equals(file, original), "unsupported extended metadata is refused rather than silently discarded"); pf_root_close(root);
  reset(); unsigned char provenance[8192]; ssize_t provenance_size = getxattr(file, "com.apple.provenance", provenance, sizeof(provenance), 0, 0); must(provenance_size > 0);
  const unsigned char quarantine[] = {'O','P','A','Q','U','E',0,';','N','O','T','-','T','R','U','S','T'};
  must(setxattr(file, "com.apple.quarantine", quarantine, sizeof(quarantine), 0, 0) == 0); root = root_open(); txn = prepare(root, 1);
  check(pf_writer_apply(txn, &receipt) == PF_OK && attr_equals(file, "com.apple.provenance", provenance, (size_t)provenance_size) && attr_equals(file, "com.apple.quarantine", quarantine, sizeof(quarantine))
    && pf_writer_undo(txn, &receipt) == PF_OK && attr_equals(file, "com.apple.provenance", provenance, (size_t)provenance_size) && attr_equals(file, "com.apple.quarantine", quarantine, sizeof(quarantine)), "opaque provenance/quarantine bytes and presence survive Apply and Undo without parsing"); pf_writer_close(txn); pf_root_close(root);
  reset(); unsigned char big_attr[8193]; memset(big_attr, 'X', sizeof(big_attr)); must(setxattr(file, "com.apple.quarantine", big_attr, sizeof(big_attr), 0, 0) == 0); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK);
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_TOO_LARGE && txn == NULL && equals(file, original) && hold_count() == 0, "actual attribute8193-byte limit refuses without stripping or target mutation"); pf_root_close(root);
  reset(); must(setxattr(file, "com.apple.quarantine", big_attr, 8192, 0, 0) == 0); root = root_open(); txn = prepare(root, 1);
  check(pf_writer_apply(txn, &receipt) == PF_OK && attr_equals(file, "com.apple.quarantine", big_attr, 8192) && pf_writer_undo(txn, &receipt) == PF_OK && attr_equals(file, "com.apple.quarantine", big_attr, 8192), "actual exact8192-byte opaque attribute succeeds through Apply and Undo"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); txn = prepare(root, 1); action = 18;
  PFResult changed_attr = pf_writer_apply(txn, &receipt); join(path, hold, "after");
  check(fired && changed_attr != PF_OK && receipt.namespace_effect == 1 && attr_equals(path, "com.apple.quarantine", (const unsigned char *)"SYNTHETIC-LATE-OPAQUE", 21), "attribute change in actual swap gap is retained and reported as conflict"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); txn = prepare(root, 1); must(pf_writer_apply(txn, &receipt) == PF_OK); action = 19;
  changed_attr = pf_writer_undo(txn, &receipt); join(path, hold, "undo-stage");
  check(fired && changed_attr != PF_OK && receipt.namespace_effect == 1 && attr_equals(path, "com.apple.quarantine", (const unsigned char *)"SYNTHETIC-UNDO-OPAQUE", 21), "attribute change in actual Undo gap preserves foreign metadata and reports conflict"); pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); action = 20;
  PFResult creation_race = pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn);
  join(path, hold, "foreign"); check(fired && creation_race == PF_CHANGED && txn == NULL && equals(file, original) && equals(path, "FOREIGN-CREATE-GAP") && acl_entries(hold) > 0, "new hold retarget after creation capture refuses without weakening foreign ACL or adopting its files"); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); action = 21;
  creation_race = pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn);
  join(path, hold, "foreign"); check(fired && creation_race == PF_CHANGED && txn == NULL && equals(file, original) && equals(path, "FOREIGN-CREATE-GAP") && acl_entries(hold) > 0, "nonempty newly created hold refuses before ACL change and preserves foreign contents"); pf_root_close(root);
  for (int i = 22; i <= 23; ++i) {
    reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); action = i;
    PFResult metadata_race = pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn);
    join(path, hold, "after"); check(fired && metadata_race == PF_CHANGED && txn == NULL && equals(file, original) && (i == 22 ? regular_mode(path, 0640) : acl_entries(path) > 0), "late approved stage mode/ACL mutation refuses before target effect and preserves changed metadata");
    if (txn) pf_writer_close(txn); pf_root_close(root);
  }
  reset(); root = root_open(); txn = prepare(root, 1); must(pf_writer_apply(txn, &receipt) == PF_OK); action = 24;
  PFResult time_race = pf_writer_undo(txn, &receipt); join(path, hold, "undo-stage"); struct stat changed_time; must(lstat(path, &changed_time) == 0);
  check(fired && time_race == PF_CHANGED && receipt.namespace_effect == 0 && equals(file, desired) && changed_time.st_mtimespec.tv_sec == 1, "late Undo stage original-mtime mutation refuses without changing target or removing the variant"); pf_writer_close(txn); pf_root_close(root);
  for (int i = 31; i <= 35; ++i) {
    reset(); root = root_open(); txn = prepare(root, 1); fault = i;
    PFResult result = pf_writer_apply(txn, &receipt); fault = 0;
    check(result != PF_OK && receipt.namespace_effect == 0 && equals(file, original) && pf_writer_apply(txn, &receipt) == PF_INVALID, "injected write/sync/intent/unsupported-rename failure consumes attempt without target effect"); pf_writer_close(txn); pf_root_close(root);
  }
  reset(); root = root_open(); txn = prepare(root, 1); must(pf_writer_apply(txn, &receipt) == PF_OK); fault = 36;
  check(pf_writer_undo(txn, &receipt) == PF_UNSUPPORTED && receipt.namespace_effect == 0 && equals(file, desired), "unsupported conditional Undo has no ordinary-rename fallback"); fault = 0; pf_writer_close(txn); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); action = 17;
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_CHANGED && txn == NULL && equals(file, "FOREIGN-DURING-PREPARE"), "final prepare recheck refuses late leaf edits while retaining intent"); pf_root_close(root);
  reset(); for (unsigned i = 0; i < PF_WRITER_MAX_HOLDS; ++i) { char name[64]; (void)snprintf(name, sizeof(name), ".plexiform-setups-hold-foreign-%u", i); join(path, profile, name); must(mkdir(path, 0700) == 0); }
  root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK);
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_TOO_LARGE && txn == NULL && equals(file, original) && hold_count() == PF_WRITER_MAX_HOLDS, "storage admission cap never prunes or adopts existing hold names"); pf_root_close(root);
  reset(); root = root_open(); must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK);
  for (unsigned i = 0; i < PF_WRITER_MAX_HOLDS; ++i) {
    must(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_OK); pf_writer_close(txn);
  }
  check(pf_writer_prepare(root, PF_CODEX_INSTRUCTIONS, &stamp, (const unsigned char *)original, sizeof(original)-1, (const unsigned char *)desired, sizeof(desired)-1, &txn) == PF_TOO_LARGE && txn == NULL && equals(file, original) && hold_count() == PF_WRITER_MAX_HOLDS, "reused retained root gets an independent directory cursor and cannot bypass hold admission cap"); pf_root_close(root);
  crash(3, "crash before namespace syscall preserves durable applying intent and untouched target");
  crash(5, "crash after actual SWAP preserves durable incomplete intent and both inode variants");
  reset(); must(nftw(base, clear_acl, 32, FTW_PHYS) == 0 && nftw(base, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0); base[0] = 0;
  printf("1..%d\n# tests %d\n# pass %d\n# fail %d\n# skipped 0\n", cases, cases, cases-failures, failures); return failures ? 1 : 0;
}
