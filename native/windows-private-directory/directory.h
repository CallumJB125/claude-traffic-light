#ifndef PLEXIFORM_WINDOWS_PRIVATE_DIRECTORY_H
#define PLEXIFORM_WINDOWS_PRIVATE_DIRECTORY_H

#ifndef _WIN32
#error This module requires the Windows SDK; POSIX mode bits cannot substitute for DACL inspection.
#endif
#include <windows.h>

#define PF_DIRECTORY_DEPTH 64
#define PF_COMPONENT_LIMIT 128
#define PF_ROOT_LIMIT 4096

typedef enum {
    PF_OK = 0,
    PF_BAD_COMPONENT,
    PF_UNSUPPORTED_ROOT,
    PF_OPEN_FAILED,
    PF_EXISTS,
    PF_REPARSE,
    PF_NOT_DIRECTORY,
    PF_UNSUPPORTED_VOLUME,
    PF_IDENTITY_CHANGED,
    PF_SECURITY_UNAVAILABLE,
    PF_NOT_PRIVATE
} PFDirectoryResult;

typedef struct {
    ULONGLONG volume;
    BYTE file[16];
} PFDirectoryIdentity;

/* Private helper-owned context. Retain every ancestor handle until the
 * operation/session is finished. No handle or SID crosses into a renderer. */
typedef struct {
    HANDLE handles[PF_DIRECTORY_DEPTH];
    DWORD count;
} PFDirectory;

/* Internal SDK module, not an IPC/path endpoint. The later main-only pipe
 * dispatch owns closed root/recipe capabilities and the operation deadline. */
PFDirectoryResult pf_directory_open_root(const WCHAR *canonicalRoot,
    const PFDirectoryIdentity *expected, PFDirectory *directory);
/* Existing private root, read-only handles so concurrent server/client leases
 * can coexist. Same namespace/identity/ACL policy; no ACL repair or creation. */
PFDirectoryResult pf_directory_open_read_root(const WCHAR *canonicalRoot,
    const PFDirectoryIdentity *expected, PFDirectory *directory);
PFDirectoryResult pf_directory_inspect(const PFDirectory *directory,
    const PFDirectoryIdentity *expected, PFDirectoryIdentity *identity);
/* Only an absent leaf beneath a currently private opened parent can be
 * created. Existing paths are never opened/adopted or have ACLs rewritten.
 * Success appends a live child handle to the context. */
PFDirectoryResult pf_directory_create_child(PFDirectory *directory,
    const WCHAR *component, PFDirectoryIdentity *identity);
void pf_directory_close(PFDirectory *directory);
const char *pf_directory_reason(PFDirectoryResult result);

#endif
