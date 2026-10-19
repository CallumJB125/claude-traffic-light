// Fixed launch-provenance gate for the account-storage worker. No credentials,
// caller-supplied identity, environment authority or Keychain APIs enter here.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

typedef struct {
  struct proc_bsdinfo info;
  struct stat executable;
  char path[PROC_PIDPATHINFO_MAXSIZE];
} Process;

static bool process_snapshot(pid_t pid, Process *result) {
  if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &result->info,
      (int)sizeof(result->info)) != (int)sizeof(result->info) ||
      result->info.pbi_pid != (uint32_t)pid ||
      result->info.pbi_uid != geteuid() || result->info.pbi_ruid != getuid()) return false;
  char raw[PROC_PIDPATHINFO_MAXSIZE] = {0};
  const int length = proc_pidpath(pid, raw, (uint32_t)sizeof(raw));
  if (length <= 0 || length >= (int)sizeof(raw) ||
      realpath(raw, result->path) == NULL ||
      stat(result->path, &result->executable) != 0 || !S_ISREG(result->executable.st_mode)) return false;
  return true;
}

static bool same_process(const Process *first, const Process *second) {
  return first->info.pbi_pid == second->info.pbi_pid &&
    first->info.pbi_ppid == second->info.pbi_ppid &&
    first->info.pbi_start_tvsec == second->info.pbi_start_tvsec &&
    first->info.pbi_start_tvusec == second->info.pbi_start_tvusec &&
    first->executable.st_dev == second->executable.st_dev &&
    first->executable.st_ino == second->executable.st_ino &&
    strcmp(first->path, second->path) == 0;
}

static bool same_executable(const Process *first, const Process *second) {
  return first->executable.st_dev == second->executable.st_dev &&
    first->executable.st_ino == second->executable.st_ino &&
    strcmp(first->path, second->path) == 0;
}

static SecCodeRef copy_process_code(pid_t pid) CF_RETURNS_RETAINED;
static SecCodeRef copy_process_code(pid_t pid) {
  SecCodeRef code = NULL;
  NSDictionary *attributes = @{ (__bridge NSString *)kSecGuestAttributePid: @(pid) };
  if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes,
      kSecCSDefaultFlags, &code) != errSecSuccess) return NULL;
  return code;
}

static NSDictionary *signing_information(SecCodeRef code) {
  SecStaticCodeRef static_code = NULL;
  CFDictionaryRef information = NULL;
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code) != errSecSuccess) return nil;
  const OSStatus status = SecCodeCopySigningInformation(static_code, kSecCSSigningInformation, &information);
  CFRelease(static_code);
  if (status != errSecSuccess) return nil;
  return CFBridgingRelease(information);
}

static bool valid_code_identity(pid_t worker_pid, pid_t gui_pid) {
  SecCodeRef worker = copy_process_code(worker_pid), gui = copy_process_code(gui_pid), own = NULL;
  SecStaticCodeRef gui_static = NULL;
  SecRequirementRef requirement = NULL;
  bool valid = false;
  if (worker != NULL && gui != NULL &&
      SecCodeCopySelf(kSecCSDefaultFlags, &own) == errSecSuccess &&
      SecCodeCheckValidity(own, kSecCSDefaultFlags, NULL) == errSecSuccess &&
      SecCodeCheckValidity(gui, kSecCSDefaultFlags, NULL) == errSecSuccess &&
      SecCodeCopyStaticCode(gui, kSecCSDefaultFlags, &gui_static) == errSecSuccess &&
      SecCodeCopyDesignatedRequirement(gui_static, kSecCSDefaultFlags, &requirement) == errSecSuccess &&
      SecCodeCheckValidity(worker, kSecCSDefaultFlags, requirement) == errSecSuccess) {
    NSDictionary *worker_info = signing_information(worker), *gui_info = signing_information(gui), *own_info = signing_information(own);
    id worker_hash = worker_info[(__bridge NSString *)kSecCodeInfoUnique];
    id gui_hash = gui_info[(__bridge NSString *)kSecCodeInfoUnique];
    id worker_id = worker_info[(__bridge NSString *)kSecCodeInfoIdentifier];
    id gui_id = gui_info[(__bridge NSString *)kSecCodeInfoIdentifier];
    id gui_team = gui_info[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    id own_team = own_info[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    valid = [worker_hash isKindOfClass:[NSData class]] && [worker_hash length] > 0 &&
      [gui_hash isKindOfClass:[NSData class]] && [worker_hash isEqual:gui_hash] &&
      [worker_id isKindOfClass:[NSString class]] && [worker_id length] > 0 &&
      [gui_id isKindOfClass:[NSString class]] && [worker_id isEqual:gui_id] &&
      ((gui_team == nil && own_team == nil) || [gui_team isEqual:own_team]);
  }
  if (requirement != NULL) CFRelease(requirement);
  if (gui_static != NULL) CFRelease(gui_static);
  if (own != NULL) CFRelease(own);
  if (gui != NULL) CFRelease(gui);
  if (worker != NULL) CFRelease(worker);
  return valid;
}

static bool forbidden_argument(const char *argument) {
  const char *prefixes[] = {
    "--eval", "--print", "--interactive", "--inspect", "--remote-debugging",
    "--plexiform-account-storage-worker", "--buddy-hook", "--uninstall-hooks", "--rename-dry-run"
  };
  for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
    if (strncmp(argument, prefixes[i], strlen(prefixes[i])) == 0) return true;
  }
  return argument[0] == '-' && (argument[1] == 'e' || argument[1] == 'p' || argument[1] == 'i');
}

static char *take_string(char **cursor, const char *end) {
  if (*cursor >= end) return NULL;
  char *start = *cursor, *nul = memchr(start, '\0', (size_t)(end - start));
  if (nul == NULL) return NULL;
  *cursor = nul + 1;
  return start;
}

// KERN_PROCARGS2 is read only for the kernel-selected worker and GUI PIDs. It
// supplements LaunchServices/signatures; no environment value grants authority.
static bool kernel_launch_arguments(pid_t pid, const char *expected_path, bool worker) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t length = 0;
  if (sysctl(mib, 3, NULL, &length, NULL, 0) != 0 || length <= sizeof(int) || length > 1024 * 1024) return false;
  unsigned char *bytes = calloc(length, 1);
  if (bytes == NULL) return false;
  const size_t allocated = length;
  bool valid = false;
  if (sysctl(mib, 3, bytes, &length, NULL, 0) == 0 && length <= allocated && length > sizeof(int)) {
    int argument_count = 0;
    memcpy(&argument_count, bytes, sizeof(argument_count));
    char *cursor = (char *)bytes + sizeof(int), *end = (char *)bytes + length;
    char *executable = take_string(&cursor, end);
    char canonical[PROC_PIDPATHINFO_MAXSIZE];
    valid = argument_count > 0 && argument_count <= 4096 && executable != NULL &&
      realpath(executable, canonical) != NULL && strcmp(canonical, expected_path) == 0;
    unsigned int worker_flags = 0;
    while (cursor < end && *cursor == '\0') cursor++;
    for (int i = 0; valid && i < argument_count; i++) {
      const char *argument = take_string(&cursor, end);
      if (argument == NULL) valid = false;
      else if (worker && strcmp(argument, "--plexiform-account-storage-worker") == 0) worker_flags++;
      else if (forbidden_argument(argument)) valid = false;
    }
    if (worker && worker_flags != 1) valid = false;
    while (valid && cursor < end) {
      const char *entry = take_string(&cursor, end);
      if (entry == NULL) { valid = false; break; }
      const char node_mode[] = "ELECTRON_RUN_AS_NODE=";
      if (strncmp(entry, node_mode, sizeof(node_mode) - 1) == 0 && entry[sizeof(node_mode) - 1] != '\0') valid = false;
    }
  }
  volatile unsigned char *wipe = bytes;
  for (size_t i = 0; i < allocated; i++) wipe[i] = 0;
  free(bytes);
  return valid;
}

static bool approved_parent(void) {
  const pid_t own_pid = getpid(), worker_pid = getppid();
  Process own, worker, gui, own_after, worker_after, gui_after;
  if (!process_snapshot(own_pid, &own) || !process_snapshot(worker_pid, &worker)) return false;
  const pid_t gui_pid = (pid_t)worker.info.pbi_ppid;
  if (!process_snapshot(gui_pid, &gui) || !same_executable(&worker, &gui)) return false;
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:gui_pid];
  if (application == nil || application.processIdentifier != gui_pid || application.terminated || !application.finishedLaunching ||
      ![application.bundleIdentifier isEqualToString:@"dev.plexiform.app"] ||
      (application.activationPolicy != NSApplicationActivationPolicyRegular && application.activationPolicy != NSApplicationActivationPolicyAccessory) ||
      !application.bundleURL.isFileURL || !application.executableURL.isFileURL) return false;
  char bundle[PROC_PIDPATHINFO_MAXSIZE], executable[PROC_PIDPATHINFO_MAXSIZE];
  if (realpath(application.bundleURL.fileSystemRepresentation, bundle) == NULL ||
      realpath(application.executableURL.fileSystemRepresentation, executable) == NULL || strcmp(executable, gui.path) != 0) return false;
  NSString *bundle_path = [[NSString alloc] initWithUTF8String:bundle];
  if (![bundle_path.pathExtension isEqualToString:@"app"]) return false;
  NSString *expected_gui = [bundle_path stringByAppendingPathComponent:@"Contents/MacOS/Plexiform"];
  NSString *expected_guard = [bundle_path stringByAppendingPathComponent:@"Contents/Resources/account-storage/buddy-account-storage-parent"];
  if (strcmp(expected_gui.fileSystemRepresentation, gui.path) != 0 ||
      strcmp(expected_guard.fileSystemRepresentation, own.path) != 0 ||
      !kernel_launch_arguments(gui_pid, gui.path, false) ||
      !kernel_launch_arguments(worker_pid, worker.path, true) ||
      !valid_code_identity(worker_pid, gui_pid)) return false;
  // PID reuse, process replacement and reparenting during validation deny the
  // request. The guard's fixed location must also remain the same vnode.
  return getppid() == worker_pid && process_snapshot(own_pid, &own_after) &&
    process_snapshot(worker_pid, &worker_after) && process_snapshot(gui_pid, &gui_after) &&
    same_process(&own, &own_after) && same_process(&worker, &worker_after) && same_process(&gui, &gui_after) &&
    !application.terminated;
}

int main(int argc, const char *argv[]) {
  (void)argv;
  if (argc != 1) return 1;
  @autoreleasepool {
    if (!approved_parent()) return 1;
    return fputs("approved\n", stdout) < 0 ? 1 : 0;
  }
}
