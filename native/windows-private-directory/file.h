#ifndef PLEXIFORM_WINDOWS_PRIVATE_FILE_H
#define PLEXIFORM_WINDOWS_PRIVATE_FILE_H

#include "directory.h"

#define PF_GRANT_BYTES 8192
#define PF_TOKEN_BYTES 256

typedef enum { PF_FILE_GRANT = 1, PF_FILE_TASKS_TOKEN = 2 } PFFileRole;

typedef enum {
    PF_FILE_OK = 0,
    PF_FILE_BAD_ARGUMENT,
    PF_FILE_BAD_COMPONENT,
    PF_FILE_BAD_ROLE,
    PF_FILE_PARENT_UNAVAILABLE,
    PF_FILE_OPEN_FAILED,
    PF_FILE_NOT_REGULAR,
    PF_FILE_REPARSE,
    PF_FILE_UNSUPPORTED_VOLUME,
    PF_FILE_SECURITY_UNAVAILABLE,
    PF_FILE_NOT_PRIVATE,
    PF_FILE_IDENTITY_CHANGED,
    PF_FILE_SIZE_LIMIT,
    PF_FILE_IO_FAILED
} PFFileResult;

typedef struct {
    PFDirectoryIdentity identity;
    ULONGLONG bytes;
    LONGLONG creationTime;
    LONGLONG lastWriteTime;
    LONGLONG changeTime;
    DWORD attributes;
} PFFileStamp;

/* Trusted native memory only; no renderer/path/IPC endpoint or assigned opcode.
 * Parent must be a live private directory lease. Component is one bounded
 * name, role chooses a fixed limit, and expected optionally binds a prior
 * capture. Output must address capacity writable bytes (1..role limit),
 * disjoint from component/length/stamp. Expected and observed may alias.
 * Success publishes bytes only after the opened and current named file agree
 * in identity, length, basic metadata and exact private security descriptor.
 * Refusal zeroes the bounded output, length and stamp. No partial read escapes.
 * File/ancestor handles retain a share lease through all checks and reads.
 * Synchronous kernel calls require a later external helper-process deadline;
 * this API cannot promise syscall cancellation or atomic ACL/content CAS. */
PFFileResult pf_file_read(const PFDirectory *parent, const WCHAR *component,
    PFFileRole role, const PFFileStamp *expected, BYTE *output, DWORD capacity,
    DWORD *length, PFFileStamp *observed);
const char *pf_file_reason(PFFileResult result);

#endif
