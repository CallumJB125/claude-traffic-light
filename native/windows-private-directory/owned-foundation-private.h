#ifndef PLEXIFORM_WINDOWS_OWNED_FOUNDATION_PRIVATE_H
#define PLEXIFORM_WINDOWS_OWNED_FOUNDATION_PRIVATE_H
#include "owned-foundation.h"
struct PFOAuthority {
    PFDirectory root;
    PFDirectoryIdentity identity;
    ULONGLONG cutoff;
    DWORD controls;
};
struct PFOControl {
    PFOAuthority *authority;
    HANDLE pipe, process, event;
    OVERLAPPED connect;
    WCHAR name[PFO_PIPE_NAME];
    DWORD pid, session;
    FILETIME creation;
    LUID logon;
    PSECURITY_DESCRIPTOR security;
    BOOL pending, connected, closing, refused;
};
#endif
