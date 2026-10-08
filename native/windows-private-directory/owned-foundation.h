#ifndef PLEXIFORM_WINDOWS_OWNED_FOUNDATION_H
#define PLEXIFORM_WINDOWS_OWNED_FOUNDATION_H
#include "file.h"
/* Native trusted-caller boundary only. No renderer/provider constructor,
 * pathname, ACL/SID input, arbitrary name, command or replacement operation. */
typedef struct PFOAuthority PFOAuthority;
typedef struct PFOControl PFOControl;
typedef enum { PFO_OK=0, PFO_INVALID, PFO_UNAVAILABLE, PFO_EXISTS, PFO_IO,
    PFO_PENDING, PFO_PEER } PFOResult;
typedef enum { PFO_NONE=0, PFO_STAGED, PFO_PUBLISHED, PFO_UNCERTAIN } PFOEffect;
typedef struct { PFOResult result; PFOEffect effect; } PFOPublication;
#define PFO_PIPE_NAME 96u
/* Authority receives an already captured private SDK lease and identity;
 * its absolute GetTickCount64 cutoff cannot be renewed (maximum 5 seconds).
 * Native synchronous calls still need an externally supervised helper. */
PFOResult pfo_private_open(const PFDirectory *, const PFDirectoryIdentity *,
    ULONGLONG cutoff, PFOAuthority **);
PFOResult pfo_close(PFOAuthority *);
PFOPublication pfo_publish(PFOAuthority *, PFFileRole, const BYTE *, DWORD);
/* Expected process is a retained trusted native process handle, never a PID
 * supplied by a renderer. Polling and close are nonblocking; PENDING retains
 * every OVERLAPPED/event/pipe resource until completion is observed. A nonnull
 * constructor output is a cleanup obligation even when its result refuses
 * after native connection setup. No data protocol/handler or launcher is bound. */
PFOResult pfo_control_begin(PFOAuthority *, HANDLE expectedProcess, PFOControl **);
PFOResult pfo_control_name(PFOControl *, WCHAR *, DWORD capacity);
PFOResult pfo_control_poll(PFOControl *);
PFOResult pfo_control_close(PFOControl *);
#endif
