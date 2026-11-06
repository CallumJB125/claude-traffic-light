#include "keeper.h"
#include <util.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <Security/Security.h>
#include <ApplicationServices/ApplicationServices.h>

// The post-fork path is entirely C and async-signal-safe. Swift/ObjC never runs
// in the child of this multithreaded keeper before execve.
int pf_spawn(const char *file, char *const argv[], char *const env[], const char *cwd, unsigned short cols, unsigned short rows, int *master, char *tty) {
  struct winsize size = {.ws_col = cols, .ws_row = rows};
  pid_t pid = forkpty(master, tty, NULL, &size);
  if (pid == 0) {
    signal(SIGPIPE, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGHUP, SIG_DFL);
    if (chdir(cwd) != 0) _exit(126);
    execve(file, argv, env);
    const char msg[] = "\r\nPlexiform: executable could not start.\r\n";
    write(STDERR_FILENO, msg, sizeof(msg)-1); _exit(127);
  }
  return pid;
}

static int code_info(SecCodeRef code, char *identifier, int capacity, int *build, CFStringRef *team) {
  CFDictionaryRef info = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) != errSecSuccess) return 0;
  CFStringRef ident = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
  int ok = ident && CFGetTypeID(ident) == CFStringGetTypeID() && CFStringGetCString(ident, identifier, capacity, kCFStringEncodingUTF8);
  CFDictionaryRef plist = CFDictionaryGetValue(info, kSecCodeInfoPList);
  *build = 0;
  if (plist && CFGetTypeID(plist) == CFDictionaryGetTypeID()) {
    CFStringRef ver = CFDictionaryGetValue(plist, CFSTR("CFBundleVersion"));
    if (ver && CFGetTypeID(ver) == CFStringGetTypeID()) *build = CFStringGetIntValue(ver);
  }
  CFStringRef t = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
  if (t && CFGetTypeID(t) == CFStringGetTypeID()) *team = CFRetain(t);
  CFRelease(info); return ok;
}

int pf_peer(int fd, int development, const char *expectedTeam, char *identifier, int capacity, int *build) {
  uid_t uid; gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0 || uid != getuid()) return 0;
  audit_token_t token; socklen_t len = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) != 0 || len != sizeof(token)) return 0;
  CFDataRef audit = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  const void *keys[] = {kSecGuestAttributeAudit}; const void *values[] = {audit};
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL; int ok = 0; CFStringRef actualTeam = NULL;
  OSStatus guest = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
  OSStatus valid = code ? SecCodeCheckValidity(code, kSecCSStrictValidate, NULL) : -1;
#ifdef PF_AUTH_TRACE
  fprintf(stderr, "auth guest=%d valid=%d\n", (int)guest, (int)valid);
#endif
  if (guest == errSecSuccess && valid == errSecSuccess && code_info(code, identifier, capacity, build, &actualTeam)) {
    if (development) ok = 1;
    else if (actualTeam && expectedTeam && expectedTeam[0]) {
      CFStringRef want = CFStringCreateWithCString(NULL, expectedTeam, kCFStringEncodingUTF8);
      ok = CFEqual(actualTeam, want); CFRelease(want);
      if (ok) {
        SecRequirementRef req = NULL;
        if (SecRequirementCreateWithString(CFSTR("anchor apple generic"), kSecCSDefaultFlags, &req) != errSecSuccess) ok = 0;
        else { ok = SecCodeCheckValidity(code, kSecCSStrictValidate, req) == errSecSuccess; CFRelease(req); }
      }
    }
  }
  if (actualTeam) CFRelease(actualTeam); if (code) CFRelease(code); CFRelease(attrs); CFRelease(audit); return ok;
}

int pf_verify_executable(const char *file, const char *requirement) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)file, strlen(file), false);
  SecStaticCodeRef code = NULL; SecRequirementRef req = NULL; int ok = 0;
  CFStringRef text = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
  if (url && text && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
      SecRequirementCreateWithString(text, kSecCSDefaultFlags, &req) == errSecSuccess)
    ok = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, req) == errSecSuccess;
  if (req) CFRelease(req); if (code) CFRelease(code); if (text) CFRelease(text); if (url) CFRelease(url); return ok;
}
int pf_locked(void) {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (!session) return 1;
  CFBooleanRef locked = CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked"));
  CFBooleanRef active = CFDictionaryGetValue(session, kCGSessionOnConsoleKey);
  int result = (locked && CFGetTypeID(locked) == CFBooleanGetTypeID() && CFBooleanGetValue(locked)) || !active || !CFBooleanGetValue(active);
  CFRelease(session); return result;
}
