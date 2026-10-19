#define _DARWIN_C_SOURCE
#include "reader.h"
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if !defined(__APPLE__)
#error This acceptance driver requires actual Darwin filesystem primitives.
#endif
static char base[PATH_MAX], profile[PATH_MAX], target[PATH_MAX];
static int failures, cases, action, triggered, read_calls;
static const char original[] = "SYNTHETIC-PRIVATE-CONTENT\n";
static void must(int condition) { if (!condition) { fputs("fixture setup failed\n", stderr); exit(99); } }
static void joined(char *out, const char *a, const char *b) { char value[PATH_MAX]; int n = snprintf(value, sizeof(value), "%s/%s", a, b); must(n > 0 && (size_t)n < sizeof(value)); memcpy(out, value, (size_t)n + 1); }
static void write_file(const char *file, const unsigned char *bytes, size_t size) {
  int fd = open(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600); must(fd >= 0);
  size_t at = 0; while (at < size) { ssize_t n = write(fd, bytes + at, size - at); must(n > 0); at += (size_t)n; }
  must(close(fd) == 0);
}
static int remove_entry(const char *p, const struct stat *s, int type, struct FTW *info) { (void)s; (void)type; (void)info; return remove(p); }
static void reset(void) {
  if (base[0]) must(nftw(base, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
  char pattern[] = "/tmp/pf-reader-fixture-XXXXXX"; char *made = mkdtemp(pattern); must(made != NULL);
  must(realpath(made, base) != NULL); joined(profile, base, "profile"); must(mkdir(profile, 0700) == 0);
  char dir[PATH_MAX]; joined(dir, profile, ".codex"); must(mkdir(dir, 0700) == 0);
  joined(target, dir, "AGENTS.md"); write_file(target, (const unsigned char *)original, sizeof(original)-1);
  action = 0; triggered = 0; read_calls = 0;
}
static void check(int condition, const char *name) {
  ++cases; printf("%s %d - %s\n", condition ? "ok" : "not ok", cases, name); if (!condition) ++failures;
}
static PFRoot *opened(void) { PFRoot *root = NULL; must(pf_root_open(profile, NULL, &root) == PF_OK); return root; }
static PFStamp inspected(PFRoot *root) { PFStamp stamp; must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); return stamp; }
void pf_reader_test_barrier(unsigned stage) {
  if (stage == 3) ++read_calls;
  if (triggered || !action) return;
  char other[PATH_MAX], dir[PATH_MAX], moved[PATH_MAX];
  if (stage == 1 && (action == 1 || action == 2 || action == 3)) {
    triggered = 1;
    if (action == 1) { must(unlink(target) == 0); must(mkfifo(target, 0600) == 0); }
    if (action == 2) { must(unlink(target) == 0); must(mkdir(target, 0700) == 0); }
    if (action == 3) {
      joined(dir, profile, ".codex"); joined(moved, profile, ".codex-moved"); must(rename(dir, moved) == 0);
      joined(other, base, "foreign"); must(mkdir(other, 0700) == 0); must(symlink(other, dir) == 0);
      joined(other, other, "AGENTS.md"); write_file(other, (const unsigned char *)"FOREIGN", 7);
    }
  } else if (stage == 2 && action == 4) {
    triggered = 1; joined(moved, profile, "held-file"); must(rename(target, moved) == 0);
    write_file(target, (const unsigned char *)"FOREIGN", 7);
  } else if (stage == 3 && action == 5) {
    triggered = 1; int fd = open(target, O_WRONLY | O_NOFOLLOW); must(fd >= 0);
    must(pwrite(fd, "FOREIGN", 7, 0) == 7); must(close(fd) == 0);
  } else if (stage == 4 && action == 6) {
    triggered = 1; joined(moved, base, "profile-moved"); must(rename(profile, moved) == 0); must(mkdir(profile, 0700) == 0);
  }
}
static PFResult reading(PFRoot *root, const PFStamp *stamp, unsigned char *bytes, size_t *size, PFStamp *after) {
  return pf_read_fixed(root, PF_CODEX_INSTRUCTIONS, stamp, bytes, PF_READER_MAX_BYTES, size, after);
}
static void fifo_child(PFRoot *root, const PFStamp *stamp, const char *name) {
  pid_t pid = fork(); must(pid >= 0);
  if (pid == 0) {
    alarm(2); unsigned char bytes[PF_READER_MAX_BYTES]; size_t size = 55; PFStamp after;
    action = 1; read_calls = 0; PFResult result = reading(root, stamp, bytes, &size, &after);
    _exit(result == PF_UNSAFE && triggered && size == 0 && read_calls == 0 ? 0 : 1);
  }
  int status; must(waitpid(pid, &status, 0) == pid); check(WIFEXITED(status) && WEXITSTATUS(status) == 0, name);
}
static int equals_file(const char *file, const char *value) {
  char data[128]; int fd = open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data)); close(fd);
  return size == (ssize_t)strlen(value) && memcmp(data, value, (size_t)size) == 0;
}
static void create_recipe(const char *relative) {
  char copy[PATH_MAX], current[PATH_MAX], next[PATH_MAX]; must(strlen(relative) < sizeof(copy)); strcpy(copy, relative); strcpy(current, profile);
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  for (;;) { char *after = strtok_r(NULL, "/", &save); joined(next, current, part);
    if (!after) { write_file(next, (const unsigned char *)original, sizeof(original)-1); break; }
    must(mkdir(next, 0700) == 0 || errno == EEXIST); strcpy(current, next); part = after;
  }
}
int main(void) {
  puts("TAP version 13"); unsigned char *bytes = malloc(PF_READER_MAX_BYTES); must(bytes != NULL); size_t size; PFStamp stamp, after;
  reset(); PFRoot *root = opened(); stamp = inspected(root);
  check(reading(root, &stamp, bytes, &size, &after) == PF_OK && size == sizeof(original)-1 && memcmp(bytes, original, size) == 0, "fixed regular recipe reads exact bytes");
  check(pf_inspect_fixed(root, (PFRecipe)999, &after) == PF_INVALID, "unknown recipe refuses");
  check(pf_inspect_fixed(root, PF_GIT_CONFIG, &after) == PF_UNAVAILABLE, "absent fixed file stays unavailable");
  check(pf_inspect_fixed(root, PF_CLAUDE_SETTINGS, &after) == PF_UNAVAILABLE, "absent target ancestor stays unavailable");
  check(pf_read_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp, bytes, 2, &size, &after) == PF_TOO_LARGE && size == 0, "capacity bounds refuse before read");
  PFStamp identity; must(pf_root_identity(root, &identity) == PF_OK); PFRoot *second = NULL; identity.inode++;
  check(pf_root_open(profile, &identity, &second) == PF_CHANGED && second == NULL, "expected root identity is bound");
  fifo_child(root, &stamp, "actual regular to FIFO swap refuses without blocking before fstat"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); action = 2;
  check(reading(root, &stamp, bytes, &size, &after) == PF_UNSAFE && triggered && size == 0, "regular to directory race refuses before read"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); action = 3;
  check(reading(root, &stamp, bytes, &size, &after) == PF_CHANGED && triggered && size == 0 && read_calls == 0, "anchored parent retarget cannot read foreign replacement"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); action = 4;
  check(reading(root, &stamp, bytes, &size, &after) == PF_CHANGED && triggered && size == 0 && read_calls == 0, "leaf replacement after open is unavailable");
  char held[PATH_MAX]; joined(held, profile, "held-file"); check(equals_file(target, "FOREIGN") && equals_file(held, original), "replaced foreign and displaced original bytes stay accessible"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); action = 5; memset(bytes, 0xee, PF_READER_MAX_BYTES);
  PFResult result = reading(root, &stamp, bytes, &size, &after); int zero = 1; for (size_t i = 0; i < sizeof(original)-1; ++i) if (bytes[i] != 0) zero = 0;
  check(result == PF_CHANGED && triggered && size == 0 && zero, "in-place foreign edit after read clears withheld bytes");
  char edited[sizeof(original)]; memcpy(edited, original, sizeof(original)); memcpy(edited, "FOREIGN", 7); check(equals_file(target, edited), "foreign in-place edit remains intact"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); action = 6;
  check(reading(root, &stamp, bytes, &size, &after) == PF_CHANGED && triggered && size == 0, "root rename after read invalidates lexical capability"); pf_root_close(root);
  reset(); root = opened(); stamp = inspected(root); write_file(target, (const unsigned char *)"LATER", 5);
  check(reading(root, &stamp, bytes, &size, &after) == PF_CHANGED && size == 0, "stale planned file metadata refuses"); pf_root_close(root);
  reset(); root = opened(); must(unlink(target) == 0); char foreign[PATH_MAX]; joined(foreign, base, "foreign-file"); write_file(foreign, (const unsigned char *)original, sizeof(original)-1); must(symlink(foreign, target) == 0);
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "leaf symlink refuses"); pf_root_close(root);
  reset(); root = opened(); must(unlink(target) == 0); int sock = socket(AF_UNIX, SOCK_STREAM, 0); must(sock >= 0);
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  must(strlen(target) < sizeof(address.sun_path)); strcpy(address.sun_path, target); must(bind(sock, (const struct sockaddr *)&address, sizeof(address)) == 0);
  PFResult socket_result = pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after);
  check(socket_result == PF_IO || socket_result == PF_UNSAFE, "actual Unix socket target refuses without reading"); must(close(sock) == 0); pf_root_close(root);
  reset(); second = NULL; check(pf_root_open(target, NULL, &second) == PF_UNSAFE && second == NULL, "regular file cannot be a profile directory");
  reset(); root = opened(); joined(foreign, profile, "hardlink"); must(link(target, foreign) == 0);
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "hardlinked file refuses"); pf_root_close(root);
  reset(); root = opened(); must(chmod(target, 0666) == 0);
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "foreign-writable file refuses"); pf_root_close(root);
  reset(); root = opened(); char dir[PATH_MAX]; joined(dir, profile, ".codex"); must(chmod(dir, 0777) == 0);
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "foreign-writable target ancestor refuses"); pf_root_close(root);
  reset(); must(chmod(profile, 0777) == 0); second = NULL;
  check(pf_root_open(profile, NULL, &second) == PF_UNSAFE && second == NULL, "foreign-writable profile refuses");
  reset(); joined(foreign, base, "profile-alias"); must(symlink(profile, foreign) == 0); second = NULL;
  check(pf_root_open(foreign, NULL, &second) == PF_UNSAFE && second == NULL, "noncanonical root alias refuses");
  reset(); root = opened(); memset(bytes, 'x', PF_READER_MAX_BYTES); write_file(target, bytes, PF_READER_MAX_BYTES); stamp = inspected(root);
  check(reading(root, &stamp, bytes, &size, &after) == PF_OK && size == PF_READER_MAX_BYTES, "exact byte limit succeeds");
  int fd = open(target, O_WRONLY | O_APPEND); must(fd >= 0 && write(fd, "x", 1) == 1 && close(fd) == 0);
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_TOO_LARGE, "byte limit plus one refuses"); pf_root_close(root);
  reset(); root = opened(); const char *paths[] = {".codex/AGENTS.md", ".claude/settings.json", ".gemini/settings.json", ".codex/config.toml", ".gitconfig", ".config/git/config", ".config/ghostty/config", "Library/Application Support/com.mitchellh.ghostty/config"};
  for (unsigned i = 0; i < sizeof(paths)/sizeof(paths[0]); ++i) { create_recipe(paths[i]); must(pf_inspect_fixed(root, (PFRecipe)(i+1), &stamp) == PF_OK);
    check(pf_read_fixed(root, (PFRecipe)(i+1), &stamp, bytes, PF_READER_MAX_BYTES, &size, &after) == PF_OK && size == sizeof(original)-1 && memcmp(bytes, original, size) == 0, "closed recipe maps to independently expected registry path");
  } pf_root_close(root);
  reset(); root = opened(); write_file(target, (const unsigned char *)"", 0); stamp = inspected(root);
  check(reading(root, &stamp, bytes, &size, &after) == PF_OK && size == 0, "empty regular file reads truthfully"); pf_root_close(root);
  reset(); char deep[PATH_MAX], next[PATH_MAX]; strcpy(deep, profile);
  for (int i = 0; i < 70; ++i) { joined(next, deep, "a"); must(mkdir(next, 0700) == 0); strcpy(deep, next); }
  second = NULL; check(pf_root_open(deep, NULL, &second) == PF_TOO_LARGE && second == NULL, "root ancestor storage cap refuses deep profiles");
  free(bytes); must(nftw(base, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0); base[0] = 0;
  printf("1..%d\n# tests %d\n# pass %d\n# fail %d\n# skipped 0\n", cases, cases, cases-failures, failures);
  return failures ? 1 : 0;
}
