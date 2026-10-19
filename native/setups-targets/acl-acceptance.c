#define _DARWIN_C_SOURCE
#include "reader.h"
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <membership.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if !defined(__APPLE__)
#error This acceptance driver requires actual Darwin extended ACLs.
#endif
static char base[PATH_MAX], profile[PATH_MAX], folder[PATH_MAX], file[PATH_MAX];
static int cases, failures, action, changed, read_calls;
static const char content[] = "SYNTHETIC-ACL-CONTENT";
static void must(int condition) { if (!condition) { perror("ACL fixture"); exit(99); } }
static void check(int condition, const char *name) { printf("%s %d - %s\n", condition ? "ok" : "not ok", ++cases, name); if (!condition) ++failures; }
static void joined(char *out, const char *a, const char *b) { int n = snprintf(out, PATH_MAX, "%s/%s", a, b); must(n > 0 && n < PATH_MAX); }
static int clear_acl(const char *p, const struct stat *s, int type, struct FTW *info) {
  (void)s; (void)type; (void)info;
  /* Clear only this driver's fresh synthetic ACLs before fixture cleanup;
   * deny-delete intentionally applies to the fixture's current user too. */
  acl_t empty = acl_init(0); must(empty != NULL);
  must(acl_set_file(p, ACL_TYPE_EXTENDED, empty) == 0); must(acl_free(empty) == 0);
  return 0;
}
static int remove_entry(const char *p, const struct stat *s, int type, struct FTW *info) { (void)s; (void)type; (void)info; return remove(p); }
static void cleanup(void) {
  must(nftw(base, clear_acl, 32, FTW_PHYS) == 0);
  must(nftw(base, remove_entry, 32, FTW_DEPTH | FTW_PHYS) == 0);
  base[0] = 0;
}
static void reset(void) {
  if (base[0]) cleanup();
  char pattern[] = "/tmp/pf-reader-acl-XXXXXX"; must(mkdtemp(pattern) != NULL); must(realpath(pattern, base) != NULL);
  joined(profile, base, "profile"); must(mkdir(profile, 0700) == 0);
  joined(folder, profile, ".codex"); must(mkdir(folder, 0700) == 0); joined(file, folder, "AGENTS.md");
  int fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600); must(fd >= 0);
  must(write(fd, content, sizeof(content)-1) == (ssize_t)sizeof(content)-1); must(close(fd) == 0);
  action = 0; changed = 0; read_calls = 0;
}
static void everyone(const char *target, const char *grant) {
  pid_t child = fork(); must(child >= 0);
  if (child == 0) { execl("/bin/chmod", "chmod", "+a", grant, target, (char *)NULL); _exit(99); }
  int status; must(waitpid(child, &status, 0) == child); must(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static void principal(const char *target, int group, id_t identity, acl_permset_mask_t permissions) {
  uuid_t uuid; must((group ? mbr_gid_to_uuid(identity, uuid) : mbr_uid_to_uuid(identity, uuid)) == 0);
  int fd = open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); must(fd >= 0);
  acl_t acl = acl_init(1); must(acl != NULL); acl_entry_t entry;
  must(acl_create_entry(&acl, &entry) == 0); must(acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) == 0);
  must(acl_set_qualifier(entry, uuid) == 0); must(acl_set_permset_mask_np(entry, permissions) == 0);
  must(acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) == 0); must(acl_free(acl) == 0); must(close(fd) == 0);
}
static PFRoot *opened(void) { PFRoot *root = NULL; must(pf_root_open(profile, NULL, &root) == PF_OK); return root; }
static PFStamp inspected(PFRoot *root) { PFStamp stamp; must(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp) == PF_OK); return stamp; }
static int private_mode(const char *path, mode_t expected) { struct stat st; must(lstat(path, &st) == 0); return (st.st_mode & 0777) == expected; }
static int native_has_acl(const char *path) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); must(fd >= 0); acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); must(acl != NULL);
  acl_entry_t entry; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == 0; must(acl_free(acl) == 0); must(close(fd) == 0); return result;
}
static int read_ok(PFRoot *root) {
  PFStamp stamp = inspected(root), after; unsigned char bytes[64]; size_t size = 999;
  return pf_read_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp, bytes, sizeof(bytes), &size, &after) == PF_OK
    && size == sizeof(content)-1 && memcmp(bytes, content, size) == 0;
}
void pf_reader_test_barrier(unsigned stage) {
  if (stage == 3) ++read_calls;
  if (!action || changed) return;
  if (stage == 2 && action == 5) { everyone(file, "everyone allow write"); changed = 1; }
  if (stage != 3 || action == 5) return;
  const char *target = action == 1 ? file : action == 2 ? folder : action == 3 ? profile : base;
  everyone(target, action == 1 ? "everyone allow write" : "everyone allow add_file,delete_child"); changed = 1;
}
int main(void) {
  puts("TAP version 13"); PFRoot *root; PFStamp after;
  reset(); root = opened(); check(read_ok(root), "supported filesystem with absent ACL permits exact read"); pf_root_close(root);
  reset(); everyone(profile, "everyone deny delete"); everyone(folder, "everyone deny delete"); root = opened();
  check(native_has_acl(profile) && native_has_acl(folder) && read_ok(root), "ordinary deny-only profile and ancestor ACLs remain usable"); pf_root_close(root);
  reset(); everyone(profile, "everyone allow read,search,readattr,readextattr,readsecurity");
  everyone(folder, "everyone allow read,search,readsecurity"); everyone(file, "everyone allow read,readattr,readextattr,readsecurity");
  root = opened(); check(native_has_acl(file) && read_ok(root), "known Everyone read and directory search grants remain usable"); pf_root_close(root);
  reset(); principal(file, 0, getuid(), ACL_WRITE_DATA | ACL_APPEND_DATA | ACL_WRITE_SECURITY | ACL_CHANGE_OWNER);
  principal(folder, 0, getuid(), ACL_ADD_FILE | ACL_ADD_SUBDIRECTORY | ACL_DELETE_CHILD);
  root = opened(); check(native_has_acl(file) && read_ok(root), "positively mapped current user write grants remain usable"); pf_root_close(root);
  reset(); principal(file, 1, getgid(), ACL_WRITE_DATA); root = opened();
  check(native_has_acl(file) && pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "group containing current user cannot establish exclusive write authority"); pf_root_close(root);
  reset(); principal(file, 0, getuid() == 0 ? 65534 : 0, ACL_WRITE_DATA); root = opened();
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "other positively mapped user write grant refuses"); pf_root_close(root);
  const char *grants[] = {"everyone allow write", "everyone allow append", "everyone allow delete", "everyone allow delete_child", "everyone allow writeattr", "everyone allow writeextattr", "everyone allow writesecurity", "everyone allow chown"};
  for (unsigned i = 0; i < sizeof(grants)/sizeof(grants[0]); ++i) {
    reset(); everyone(file, grants[i]); root = opened();
    check(private_mode(file, 0600) && native_has_acl(file) && pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, grants[i]); pf_root_close(root);
  }
  const char *directory_grants[] = {"everyone allow add_file", "everyone allow add_subdirectory", "everyone allow delete_child"};
  for (unsigned i = 0; i < sizeof(directory_grants)/sizeof(directory_grants[0]); ++i) {
    reset(); everyone(folder, directory_grants[i]); root = opened();
    check(private_mode(folder, 0700) && pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, directory_grants[i]); pf_root_close(root);
  }
  reset(); everyone(folder, "everyone deny add_file,delete_child"); everyone(folder, "everyone allow add_file,delete_child"); root = opened();
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "deny ordering does not justify a foreign dangerous allow"); pf_root_close(root);
  reset(); everyone(folder, "everyone allow add_file,file_inherit,directory_inherit,only_inherit"); root = opened();
  check(pf_inspect_fixed(root, PF_CODEX_INSTRUCTIONS, &after) == PF_UNSAFE, "inherit-only dangerous grant is conservatively refused"); pf_root_close(root);
  reset(); everyone(base, "everyone allow add_file,delete_child"); root = NULL;
  check(pf_root_open(profile, NULL, &root) == PF_UNSAFE && root == NULL, "retained canonical ancestor outside profile is inspected");
  for (int i = 1; i <= 5; ++i) {
    reset(); root = opened(); PFStamp stamp = inspected(root); unsigned char bytes[64]; memset(bytes, 0xee, sizeof(bytes)); size_t size = 999; memset(&after, 0xee, sizeof(after)); action = i;
    PFResult result = pf_read_fixed(root, PF_CODEX_INSTRUCTIONS, &stamp, bytes, sizeof(bytes), &size, &after);
    int clear = 1; if (i != 5) for (size_t j = 0; j < sizeof(content)-1; ++j) if (bytes[j] != 0) clear = 0;
    const char *labels[] = {"", "late leaf ACL withholds and clears read bytes", "late target ancestor ACL withholds and clears read bytes", "late profile ACL withholds and clears read bytes", "late canonical ancestor ACL withholds and clears read bytes", "ACL grant after leaf open refuses before first content read"};
    check((result == PF_UNSAFE || result == PF_CHANGED) && changed && size == 0 && after.inode == 0 && clear && (i == 5 ? read_calls == 0 : read_calls > 0), labels[i]);
    pf_root_close(root);
  }
  reset(); root = opened(); everyone(profile, "everyone allow add_file"); memset(&after, 0xee, sizeof(after));
  check(pf_root_identity(root, &after) == PF_UNSAFE && after.inode == 0, "fresh root identity refuses a late unsafe ACL without metadata output"); pf_root_close(root);
  cleanup();
  printf("1..%d\n# tests %d\n# pass %d\n# fail %d\n# skipped 0\n", cases, cases, cases-failures, failures); return failures ? 1 : 0;
}
