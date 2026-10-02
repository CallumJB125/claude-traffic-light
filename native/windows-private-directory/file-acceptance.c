/* Actual Windows SDK fixtures. No POSIX substitute or unavailable-fixture skip.
 * Compile this translation unit alone: it includes production directory.c
 * after two SDK-call interposers. Normal cases delegate to the real kernel;
 * fault cases are explicitly labelled and do not claim kernel failures. */
#define WIN32_LEAN_AND_MEAN
#include "file.h"
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <rpc.h>
#include <winioctl.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

static BOOL WINAPI fx_read(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
static NTSTATUS NTAPI fx_open(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
static BOOL WINAPI fx_info(HANDLE, FILE_INFO_BY_HANDLE_CLASS, LPVOID, DWORD);
static BOOL WINAPI fx_volume(HANDLE, LPWSTR, DWORD, LPDWORD, LPDWORD, LPDWORD, LPWSTR, DWORD);
static DWORD WINAPI fx_security(HANDLE, SE_OBJECT_TYPE, SECURITY_INFORMATION, PSID *, PSID *, PACL *, PACL *, PSECURITY_DESCRIPTOR *);
#define ReadFile fx_read
#define NtCreateFile fx_open
#define GetFileInformationByHandleEx fx_info
#define GetVolumeInformationByHandleW fx_volume
#define GetSecurityInfo fx_security
#include "directory.c"
#undef ReadFile
#undef NtCreateFile
#undef GetFileInformationByHandleEx
#undef GetVolumeInformationByHandleW
#undef GetSecurityInfo

typedef enum { FX_NONE, FX_SHARING, FX_PUBLIC_ACL, FX_PRIVATE_ACL, FX_PARENT_PUBLIC, FX_ATTRIBUTES, FX_REPLACE, FX_ZERO, FX_IO_ERROR, FX_NAMED_ERROR } FXMode;
static DWORD checks = 0, failures = 0, consumed = 0, requested = 0;
static DWORD readCalls = 0, mutationCalls = 0, fileOpens = 0;
/* Fixed metadata only: first failed SDK phase, API status and final native
 * open status. Never print paths, SID, descriptors, handles or private bytes. */
static DWORD failedPhase = 0, failedStatus = 0;
static NTSTATUS lastOpenStatus = 0;
static BOOL mutationOK = FALSE, writeExcluded = FALSE, renameExcluded = FALSE, growExcluded = FALSE;
static FXMode mode = FX_NONE;
static WCHAR activePath[PF_ROOT_LIMIT + 1], displacedPath[PF_ROOT_LIMIT + 1];
static WCHAR *sidText = NULL;
static BYTE pattern[PF_GRANT_BYTES + 1];

static BOOL check(BOOL passed, const char *name) {
    checks++;
    printf("%s %lu - %s\n", passed ? "ok" : "not ok", (unsigned long)checks, name);
    if (!passed) failures++;
    return passed;
}

static void api_failure(DWORD phase, DWORD status) {
    if (!failedPhase) { failedPhase = phase; failedStatus = status; }
}
static BOOL WINAPI fx_info(HANDLE handle, FILE_INFO_BY_HANDLE_CLASS kind, LPVOID output, DWORD size) {
    BOOL ok = GetFileInformationByHandleEx(handle, kind, output, size);
    if (!ok) api_failure(100 + (DWORD)kind, GetLastError());
    return ok;
}
static BOOL WINAPI fx_volume(HANDLE handle, LPWSTR volume, DWORD volumeSize, LPDWORD serial,
    LPDWORD component, LPDWORD flags, LPWSTR filesystem, DWORD filesystemSize) {
    BOOL ok = GetVolumeInformationByHandleW(handle, volume, volumeSize, serial, component, flags, filesystem, filesystemSize);
    if (!ok) api_failure(200, GetLastError());
    return ok;
}
static DWORD WINAPI fx_security(HANDLE handle, SE_OBJECT_TYPE type, SECURITY_INFORMATION info,
    PSID *owner, PSID *group, PACL *acl, PACL *sacl, PSECURITY_DESCRIPTOR *descriptor) {
    DWORD result = GetSecurityInfo(handle, type, info, owner, group, acl, sacl, descriptor);
    if (result != ERROR_SUCCESS) api_failure(300, result);
    return result;
}

static BOOL child_path(WCHAR *out, const WCHAR *root, const WCHAR *leaf) {
    return swprintf_s(out, PF_ROOT_LIMIT + 1, L"%s\\%s", root, leaf) > 0;
}

static WCHAR *process_sid(void) {
    HANDLE token = NULL;
    DWORD size = 0;
    TOKEN_USER *user = NULL;
    WCHAR *text = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    if (size && size <= 65536) {
        user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), 0, size);
        if (user && GetTokenInformation(token, TokenUser, user, size, &size)) ConvertSidToStringSidW(user->User.Sid, &text);
    }
    if (user) HeapFree(GetProcessHeap(), 0, user);
    CloseHandle(token);
    return text;
}

static BOOL private_sddl(WCHAR *out, size_t count, const WCHAR *extra, BOOL readOnly) {
    return swprintf_s(out, count, L"O:%sD:P(A;;%s;;;%s)(A;;FA;;;SY)(A;;FA;;;BA)%s",
        sidText, readOnly ? L"FR" : L"FA", sidText, extra ? extra : L"") > 0;
}

static BOOL make_root(const WCHAR *path) {
    WCHAR sddl[1024];
    PSECURITY_DESCRIPTOR security = NULL;
    SECURITY_ATTRIBUTES sa;
    BOOL ok;
    if (swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]),
        L"O:%sD:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", sidText, sidText) <= 0 ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    ZeroMemory(&sa, sizeof(sa)); sa.nLength = (DWORD)sizeof(sa); sa.lpSecurityDescriptor = security;
    ok = CreateDirectoryW(path, &sa);
    LocalFree(security);
    return ok;
}

static BOOL make_file(const WCHAR *path, const WCHAR *sddl, DWORD size) {
    WCHAR ownerOnly[512];
    PSECURITY_DESCRIPTOR security = NULL;
    SECURITY_ATTRIBUTES sa;
    HANDLE handle;
    DWORD written = 0;
    BOOL ok;
    if (size > sizeof(pattern)) return FALSE;
    ZeroMemory(&sa, sizeof(sa)); sa.nLength = (DWORD)sizeof(sa);
    /* TokenOwner may be an administrative group. Positive fixtures require
     * TokenUser ownership, independently of the actual inherited DACL. Set
     * only that owner at exclusive creation; never repair an existing file. */
    if (!sddl) {
        if (swprintf_s(ownerOnly, sizeof(ownerOnly) / sizeof(ownerOnly[0]), L"O:%s", sidText) <= 0) return FALSE;
        sddl = ownerOnly;
    }
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    sa.lpSecurityDescriptor = security;
    handle = CreateFileW(path, GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (security) LocalFree(security);
    if (handle == INVALID_HANDLE_VALUE) return FALSE;
    ok = WriteFile(handle, pattern, size, &written, NULL) && written == size;
    CloseHandle(handle);
    return ok;
}

static BOOL independently_user_owned_and_inherited(const WCHAR *path) {
    PSECURITY_DESCRIPTOR security = NULL; PSID owner = NULL, expected = NULL; PACL acl = NULL;
    BYTE system[SECURITY_MAX_SID_SIZE], administrators[SECURITY_MAX_SID_SIZE];
    DWORD i, size = SECURITY_MAX_SID_SIZE, principals = 0; BOOL ok = FALSE;
    if (!CreateWellKnownSid(WinLocalSystemSid, NULL, system, &size)) return FALSE;
    size = SECURITY_MAX_SID_SIZE;
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators, &size)) return FALSE;
    if (!ConvertStringSidToSidW(sidText, &expected) ||
        GetNamedSecurityInfoW((WCHAR *)path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &owner, NULL, &acl, NULL, &security) != ERROR_SUCCESS || !owner || !acl ||
        !IsValidSid(owner) || !IsValidAcl(acl) || !EqualSid(owner, expected) || acl->AceCount != 3) goto done;
    for (i = 0; i < acl->AceCount; i++) {
        ACE_HEADER *ace = NULL;
        if (!GetAce(acl, i, (LPVOID *)&ace) || !ace || ace->AceType != ACCESS_ALLOWED_ACE_TYPE ||
            !(ace->AceFlags & INHERITED_ACE) || (ace->AceFlags & INHERIT_ONLY_ACE) ||
            ace->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8) goto done;
        {
            ACCESS_ALLOWED_ACE *allow = (ACCESS_ALLOWED_ACE *)ace;
            PSID sid = &allow->SidStart;
            if (!IsValidSid(sid) || GetLengthSid(sid) > ace->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart) ||
                allow->Mask != FILE_ALL_ACCESS) goto done;
            if (EqualSid(sid, expected)) principals |= 1;
            else if (EqualSid(sid, system)) principals |= 2;
            else if (EqualSid(sid, administrators)) principals |= 4;
            else goto done;
        }
    }
    ok = principals == 7;
done:
    if (security) LocalFree(security); if (expected) LocalFree(expected); return ok;
}

static void default_owner_diagnostic(void) {
    HANDLE token = NULL; TOKEN_OWNER *owner = NULL; PSID user = NULL; DWORD size = 0;
    const char *status = "unavailable";
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) || !ConvertStringSidToSidW(sidText, &user)) goto done;
    GetTokenInformation(token, TokenOwner, NULL, 0, &size);
    if (!size || size > 65536) goto done;
    owner = (TOKEN_OWNER *)HeapAlloc(GetProcessHeap(), 0, size);
    if (owner && GetTokenInformation(token, TokenOwner, owner, size, &size) && IsValidSid(owner->Owner))
        status = EqualSid(owner->Owner, user) ? "current-user" : "different-principal";
done:
    printf("# fixture default-owner=%s\n", status);
    if (owner) HeapFree(GetProcessHeap(), 0, owner); if (user) LocalFree(user); if (token) CloseHandle(token);
}

static PSECURITY_DESCRIPTOR named_security(const WCHAR *path) {
    PSECURITY_DESCRIPTOR security = NULL;
    return GetNamedSecurityInfoW((WCHAR *)path, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        NULL, NULL, NULL, NULL, &security) == ERROR_SUCCESS ? security : NULL;
}

static BOOL exact_security(PSECURITY_DESCRIPTOR before, const WCHAR *path) {
    PSECURITY_DESCRIPTOR after = named_security(path);
    BOOL same = before && after && GetSecurityDescriptorLength(before) == GetSecurityDescriptorLength(after) &&
        memcmp(before, after, GetSecurityDescriptorLength(before)) == 0;
    if (after) LocalFree(after);
    return same;
}

static BOOL set_fixture_acl(const WCHAR *path, const WCHAR *sddl) {
    PSECURITY_DESCRIPTOR security = NULL;
    PACL acl = NULL;
    BOOL present = FALSE, defaulted = FALSE, ok = FALSE;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    if (GetSecurityDescriptorDacl(security, &present, &acl, &defaulted) && present && acl) {
        ok = SetNamedSecurityInfoW((WCHAR *)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            NULL, NULL, acl, NULL) == ERROR_SUCCESS;
    }
    LocalFree(security);
    return ok;
}

static BOOL change_acl(const WCHAR *path, const WCHAR *extra, BOOL readOnly) {
    WCHAR sddl[1024];
    return private_sddl(sddl, sizeof(sddl) / sizeof(sddl[0]), extra, readOnly) && set_fixture_acl(path, sddl);
}

static BOOL restore_owned_control(HANDLE control) {
    WCHAR sddl[1024]; PSECURITY_DESCRIPTOR security = NULL; PACL acl = NULL;
    BOOL present = FALSE, defaulted = FALSE, ok = FALSE;
    if (control == INVALID_HANDLE_VALUE || !private_sddl(sddl, sizeof(sddl) / sizeof(sddl[0]), L"", FALSE) ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    if (GetSecurityDescriptorDacl(security, &present, &acl, &defaulted) && present && acl) {
        ok = SetSecurityInfo(control, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            NULL, NULL, acl, NULL) == ERROR_SUCCESS;
    }
    LocalFree(security); return ok;
}

static PSECURITY_DESCRIPTOR handle_security(HANDLE handle) {
    PSECURITY_DESCRIPTOR security = NULL;
    return GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        NULL, NULL, NULL, NULL, &security) == ERROR_SUCCESS ? security : NULL;
}

/* Fresh synthetic fixtures only. Query bytes independently after the library
 * releases all file handles, never through pf_file_read's verdict. */
static BOOL exact_content(const WCHAR *path, DWORD size) {
    BYTE bytes[PF_GRANT_BYTES + 1], extra;
    DWORD got = 0, tail = 1;
    HANDLE handle = CreateFileW(path, FILE_READ_DATA | SYNCHRONIZE, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    BOOL ok;
    if (handle == INVALID_HANDLE_VALUE) return FALSE;
    if (size > sizeof(bytes)) { CloseHandle(handle); return FALSE; }
    ok = ReadFile(handle, bytes, size, &got, NULL) && got == size && memcmp(bytes, pattern, size) == 0 &&
        ReadFile(handle, &extra, 1, &tail, NULL) && tail == 0;
    CloseHandle(handle);
    SecureZeroMemory(bytes, sizeof(bytes));
    return ok;
}

/* Independent kernel fixture query, outside all SDK interposers. */
static BOOL fixture_identity(const WCHAR *path, PFDirectoryIdentity *identity, DWORD *links) {
    HANDLE file = CreateFileW(path, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    FILE_ID_INFO id = {0}; FILE_STANDARD_INFO standard = {0}; BOOL ok;
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    ok = GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
        GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) && !standard.Directory;
    if (ok) {
        identity->volume = id.VolumeSerialNumber;
        memcpy(identity->file, id.FileId.Identifier, sizeof(identity->file));
        *links = standard.NumberOfLinks;
    }
    CloseHandle(file);
    return ok;
}

static BOOL same_fixture_identity(const PFDirectoryIdentity *a, const PFDirectoryIdentity *b) {
    return a->volume == b->volume && memcmp(a->file, b->file, sizeof(a->file)) == 0;
}

static void reset_mode(FXMode next, const WCHAR *path, const WCHAR *displaced) {
    mode = next; consumed = requested = readCalls = mutationCalls = fileOpens = 0;
    failedPhase = failedStatus = 0; lastOpenStatus = 0;
    mutationOK = writeExcluded = renameExcluded = growExcluded = FALSE;
    activePath[0] = displacedPath[0] = 0;
    if (path) wcscpy_s(activePath, PF_ROOT_LIMIT + 1, path);
    if (displaced) wcscpy_s(displacedPath, PF_ROOT_LIMIT + 1, displaced);
}

static BOOL WINAPI fx_read(HANDLE handle, LPVOID buffer, DWORD count, LPDWORD actual, LPOVERLAPPED overlapped) {
    BOOL ok;
    readCalls++;
    requested += count;
    if (readCalls == 1 && mode == FX_SHARING) {
        HANDLE writer = CreateFileW(activePath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        writeExcluded = writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION;
        if (writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
        renameExcluded = !MoveFileW(activePath, displacedPath) && GetLastError() == ERROR_SHARING_VIOLATION;
        writer = CreateFileW(activePath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        growExcluded = writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION;
        if (writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
    }
    if (readCalls == 1 && (mode == FX_PUBLIC_ACL || mode == FX_PRIVATE_ACL || mode == FX_PARENT_PUBLIC)) {
        mutationCalls++;
        mutationOK = change_acl(activePath, mode == FX_PRIVATE_ACL ? L"" : L"(A;;FR;;;WD)", mode == FX_PRIVATE_ACL);
    }
    if (readCalls == 1 && mode == FX_ATTRIBUTES) {
        mutationCalls++;
        mutationOK = SetFileAttributesW(activePath, FILE_ATTRIBUTE_HIDDEN);
    }
    if (mode == FX_ZERO) { *actual = 0; return TRUE; }
    if (mode == FX_IO_ERROR) { *actual = 0; SetLastError(ERROR_READ_FAULT); return FALSE; }
    ok = ReadFile(handle, buffer, count, actual, overlapped);
    if (ok) consumed += *actual;
    return ok;
}

static NTSTATUS NTAPI fx_open(PHANDLE handle, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes, PIO_STATUS_BLOCK io,
    PLARGE_INTEGER size, ULONG fileAttributes, ULONG sharing, ULONG disposition, ULONG options, PVOID ea, ULONG eaLength) {
    NTSTATUS result;
    if (options & FILE_NON_DIRECTORY_FILE) fileOpens++;
    if (mode == FX_NAMED_ERROR && fileOpens == 3) { *handle = INVALID_HANDLE_VALUE; return (NTSTATUS)0xC0000034L; }
    if (mode == FX_REPLACE && (options & FILE_NON_DIRECTORY_FILE) && mutationCalls == 0) {
        mutationCalls++;
        mutationOK = MoveFileW(activePath, displacedPath) && make_file(activePath, NULL, 32);
    }
    result = NtCreateFile(handle, access, attributes, io, size, fileAttributes, sharing, disposition, options, ea, eaLength);
    lastOpenStatus = result;
    if (result < 0) api_failure(400, (DWORD)result);
    return result;
}

static BOOL zero_output(const BYTE *bytes, DWORD count) {
    DWORD i;
    for (i = 0; i < count; i++) if (bytes[i] != 0) return FALSE;
    return TRUE;
}

static PFFileResult read_case(const PFDirectory *directory, const WCHAR *component, PFFileRole role,
    const PFFileStamp *expected, BYTE *out, DWORD capacity, DWORD *length, PFFileStamp *stamp) {
    PFFileResult result;
    memset(out, 0xa5, capacity); *length = 999;
    memset(stamp, 0xa5, sizeof(*stamp));
    result = pf_file_read(directory, component, role, expected, out, capacity, length, stamp);
    printf("# reader role=%u result=%s phase=%lu status=%lu ntstatus=%08lx opens=%lu reads=%lu requested=%lu consumed=%lu length=%lu\n",
        (unsigned)role, pf_file_reason(result), (unsigned long)failedPhase, (unsigned long)failedStatus,
        (unsigned long)lastOpenStatus, (unsigned long)fileOpens, (unsigned long)readCalls,
        (unsigned long)requested, (unsigned long)consumed, (unsigned long)*length);
    return result;
}

static void refusal(const PFDirectory *directory, const WCHAR *component, PFFileRole role, PFFileResult wanted, const char *name) {
    BYTE out[PF_GRANT_BYTES];
    PFFileStamp stamp;
    DWORD length;
    DWORD capacity = role == PF_FILE_TASKS_TOKEN ? PF_TOKEN_BYTES : PF_GRANT_BYTES;
    PFFileResult result = read_case(directory, component, role, NULL, out, capacity, &length, &stamp);
    check(result == wanted && length == 0 && zero_output(out, capacity) && zero_output((BYTE *)&stamp, (DWORD)sizeof(stamp)), name);
    check(consumed == 0, "refusal before private bytes read");
}

static BOOL remove_file(const WCHAR *path) {
    /* Caller owns this fixed freshly created fixture path, including ACL tests. */
    if (!change_acl(path, L"", FALSE)) return FALSE;
    if (!SetFileAttributesW(path, FILE_ATTRIBUTE_NORMAL)) return FALSE;
    return DeleteFileW(path);
}

typedef struct {
    DWORD tag;
    WORD bytes, reserved, substituteOffset, substituteLength, printOffset, printLength;
    WCHAR names[PF_ROOT_LIMIT + 16];
} FXJunction;

static BOOL make_junction(const WCHAR *path, const WCHAR *target) {
    FXJunction reparse;
    WCHAR substitute[PF_ROOT_LIMIT + 8];
    size_t count;
    DWORD returned = 0;
    HANDLE handle;
    BOOL ok;
    if (!CreateDirectoryW(path, NULL) || swprintf_s(substitute, sizeof(substitute) / sizeof(substitute[0]), L"\\??\\%s", target) <= 0) return FALSE;
    count = wcslen(substitute);
    ZeroMemory(&reparse, sizeof(reparse));
    reparse.tag = IO_REPARSE_TAG_MOUNT_POINT;
    reparse.substituteLength = (WORD)(count * sizeof(WCHAR));
    reparse.printOffset = (WORD)((count + 1) * sizeof(WCHAR));
    memcpy(reparse.names, substitute, (count + 1) * sizeof(WCHAR));
    reparse.bytes = (WORD)(8 + (count + 2) * sizeof(WCHAR));
    handle = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return FALSE;
    ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &reparse, (DWORD)reparse.bytes + 8, NULL, 0, &returned, NULL);
    CloseHandle(handle);
    return ok;
}

int wmain(void) {
    WCHAR temp[PF_ROOT_LIMIT + 1], root[PF_ROOT_LIMIT + 1], path[PF_ROOT_LIMIT + 1], other[PF_ROOT_LIMIT + 1], sddl[1024];
    UUID uuid;
    RPC_WSTR uuidText = NULL;
    PFDirectory directory;
    PFFileStamp stamp, expected;
    BYTE output[PF_GRANT_BYTES];
    DWORD length = 0, i;
    PFFileResult result;
    PSECURITY_DESCRIPTOR before;
    BOOL rootCreated = FALSE, directoryOpened = FALSE;
    static const WCHAR *const badNames[] = { L"", L".", L"..", L"a/b", L"a\\b", L"file:stream", L"CON", L"LPT1.txt", L"tail.", L"tail ", L"?", L"\\\\.\\pipe\\x" };
    static const WCHAR *const extras[] = { L"(A;;FR;;;WD)", L"(A;;FR;;;BU)", L"(OA;;FR;00112233-4455-6677-8899-aabbccddeeff;;WD)" };
    printf("TAP version 13\n");
    for (i = 0; i < sizeof(pattern); i++) pattern[i] = (BYTE)(i % 251);
    sidText = process_sid();
    if (!check(sidText != NULL && GetTempPathW(PF_ROOT_LIMIT + 1, temp) > 0 && wcslen(temp) < PF_ROOT_LIMIT - 64 &&
        UuidCreate(&uuid) == RPC_S_OK && UuidToStringW(&uuid, &uuidText) == RPC_S_OK,
        "obtain real current account SID and fresh bounded temporary namespace")) goto done;
    default_owner_diagnostic();
    if (!check(swprintf_s(root, PF_ROOT_LIMIT + 1, L"%spf-private-file-%s", temp, uuidText) > 0 && make_root(root),
        "create fresh independently private NTFS fixture root")) goto done;
    rootCreated = TRUE;
    if (!check(pf_directory_open_root(root, NULL, &directory) == PF_OK, "retain real rooted NTFS parent handles")) goto done;
    directoryOpened = TRUE;
    if (!check(pf_directory_inspect(&directory, NULL, NULL) == PF_OK, "parent has real private owner and DACL")) goto done;

    /* Inclusive caps, empty EOF and inherited/private/read-only controls. */
    for (i = 0; i < 4; i++) {
        DWORD size = i == 0 ? 0 : i == 1 ? 32 : i == 2 ? PF_TOKEN_BYTES : PF_GRANT_BYTES;
        PFFileRole role = i == 2 ? PF_FILE_TASKS_TOKEN : PF_FILE_GRANT;
        DWORD capacity = role == PF_FILE_TASKS_TOKEN ? PF_TOKEN_BYTES : PF_GRANT_BYTES;
        check(child_path(path, root, L"positive") && make_file(path, NULL, size), "construct actual inherited private file");
        check(independently_user_owned_and_inherited(path), "independent native query verifies current user owner and three inherited grants");
        before = named_security(path);
        reset_mode(FX_NONE, NULL, NULL);
        result = read_case(&directory, L"positive", role, NULL, output, capacity, &length, &stamp);
        check(result == PF_FILE_OK && length == size && memcmp(output, pattern, size) == 0 && stamp.bytes == size,
            "empty, small or inclusive role-cap file reads exact private bytes");
        check(consumed == size && consumed <= capacity && requested <= capacity,
            "all chunk and EOF requests stay inside the fixed role cap");
        check(exact_security(before, path) && exact_content(path, size), "read preserves actual bytes and inherited descriptor");
        if (before) LocalFree(before);
        check(remove_file(path), "remove only owned positive fixture after handle release");
    }
    check(child_path(path, root, L"read-only") && make_file(path, NULL, 32) && SetFileAttributesW(path, FILE_ATTRIBUTE_READONLY) &&
        change_acl(path, L"", TRUE), "construct actual read-only private file");
    before = named_security(path);
    reset_mode(FX_NONE, NULL, NULL);
    result = read_case(&directory, L"read-only", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
    check(result == PF_FILE_OK && length == 32 && memcmp(output, pattern, 32) == 0, "fixed read rights accept private read-only file without full-control requirement");
    check(exact_security(before, path), "read-only descriptor stays byte-for-byte unchanged");
    if (before) LocalFree(before);
    check(remove_file(path), "restore and remove only the owned read-only fixture");

    for (i = 0; i < sizeof(extras) / sizeof(extras[0]); i++) {
        check(private_sddl(sddl, sizeof(sddl) / sizeof(sddl[0]), extras[i], FALSE) && child_path(path, root, L"unsafe") &&
            make_file(path, sddl, 32), "construct actual public, group or unsupported ACE fixture");
        before = named_security(path);
        reset_mode(FX_NONE, NULL, NULL);
        refusal(&directory, L"unsafe", PF_FILE_GRANT, PF_FILE_NOT_PRIVATE, "actual unsafe principal or ACE refuses before reading");
        check(exact_security(before, path) && exact_content(path, 32), "refused foreign grant preserves actual descriptor and bytes");
        if (before) LocalFree(before);
        check(remove_file(path), "remove only owned unsafe ACL fixture");
    }
    check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%sD:NO_ACCESS_CONTROL", sidText) > 0 &&
        child_path(path, root, L"null-acl") && make_file(path, sddl, 32), "construct actual null DACL file");
    before = named_security(path);
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"null-acl", PF_FILE_GRANT, PF_FILE_NOT_PRIVATE, "actual null DACL refuses");
    check(exact_security(before, path) && exact_content(path, 32), "null DACL refusal leaves descriptor and bytes untouched");
    if (before) LocalFree(before);
    check(remove_file(path), "remove only owned null-DACL fixture");

    check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:BAD:P(A;;FA;;;%s)(A;;FA;;;SY)(A;;FA;;;BA)", sidText) > 0 &&
        child_path(path, root, L"foreign-owner") && make_file(path, sddl, 32), "construct actual other-owner file; unavailable fixture fails");
    before = named_security(path);
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"foreign-owner", PF_FILE_GRANT, PF_FILE_NOT_PRIVATE, "actual foreign owner refuses before bytes");
    check(exact_security(before, path) && exact_content(path, 32), "foreign-owner descriptor and content are never adopted or repaired");
    if (before) LocalFree(before);
    check(remove_file(path), "remove only owned foreign-owner test file");

    {
        HANDLE control = INVALID_HANDLE_VALUE;
        PSECURITY_DESCRIPTOR after = NULL;
        check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]),
            L"O:%sD:P(D;;RC;;;OW)(A;;FA;;;%s)(A;;FA;;;SY)(A;;FA;;;BA)", sidText, sidText) > 0 &&
            child_path(path, root, L"denied-control") && make_file(path, NULL, 32), "create fresh file before owner-rights denial");
        control = CreateFileW(path, READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        check(control != INVALID_HANDLE_VALUE && set_fixture_acl(path, sddl), "retain independent control handle and install actual denial");
        before = handle_security(control);
        reset_mode(FX_NONE, NULL, NULL);
        refusal(&directory, L"denied-control", PF_FILE_GRANT, PF_FILE_OPEN_FAILED, "actual denied read-control refuses kernel open before bytes");
        after = handle_security(control);
        check(before && after && GetSecurityDescriptorLength(before) == GetSecurityDescriptorLength(after) &&
            memcmp(before, after, GetSecurityDescriptorLength(before)) == 0 && exact_content(path, 32),
            "denial preserves actual descriptor and content through independent pre-held control and data-only handles");
        if (before) LocalFree(before);
        if (after) LocalFree(after);
        /* Only the already-owned fresh fixture is restored, after every
         * unchanged-denial assertion. A named reopen now lacks READ_CONTROL. */
        check(restore_owned_control(control), "restore only owned denial fixture through its pre-held control handle");
        if (control != INVALID_HANDLE_VALUE) CloseHandle(control);
        check(remove_file(path), "remove only owned read-control-denied fixture");
    }

    /* Namespace construction needs its own lease interval: the retained
     * SDK parent intentionally excludes another write/delete parent opener. */
    {
        PFDirectoryIdentity originalRoot, first, second;
        DWORD firstLinks = 0, secondLinks = 0;
        if (!check(pf_directory_inspect(&directory, NULL, &originalRoot) == PF_OK,
            "capture exact root identity before hard-link construction")) goto done;
        pf_directory_close(&directory); directoryOpened = FALSE;
        check(child_path(path, root, L"linked") && child_path(other, root, L"second-name") && make_file(path, NULL, 32) &&
            CreateHardLinkW(other, path, NULL), "create real two-name NTFS file");
        check(fixture_identity(path, &first, &firstLinks) && fixture_identity(other, &second, &secondLinks) &&
            firstLinks == 2 && secondLinks == 2 && same_fixture_identity(&first, &second) &&
            exact_content(path, 32) && exact_content(other, 32),
            "independent kernel query verifies both hard-link names and exact bytes before SDK admission");
        if (!check(pf_directory_open_root(root, &originalRoot, &directory) == PF_OK,
            "reacquire exact same root identity after hard-link construction")) goto done;
        directoryOpened = TRUE;
    }
    before = named_security(path);
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"linked", PF_FILE_GRANT, PF_FILE_NOT_REGULAR, "actual hard-linked file refuses");
    check(exact_security(before, path) && exact_content(other, 32), "hard-link refusal preserves foreign namespace and bytes");
    if (before) LocalFree(before);
    check(DeleteFileW(other) && remove_file(path), "remove only both owned hard-link fixture names");

    for (i = 0; i < 2; i++) {
        PFFileRole role = i == 0 ? PF_FILE_GRANT : PF_FILE_TASKS_TOKEN;
        DWORD size = i == 0 ? PF_GRANT_BYTES + 1 : PF_TOKEN_BYTES + 1;
        check(child_path(path, root, L"oversize") && make_file(path, NULL, size), "construct actual cap-plus-one file");
        reset_mode(FX_NONE, NULL, NULL);
        refusal(&directory, L"oversize", role, PF_FILE_SIZE_LIMIT, "actual role-cap-plus-one refuses without any content read");
        check(exact_content(path, size) && remove_file(path), "oversize refusal retains actual file bytes before owned cleanup");
    }
    for (i = 0; i < sizeof(badNames) / sizeof(badNames[0]); i++) {
        reset_mode(FX_NONE, NULL, NULL);
        refusal(&directory, badNames[i], PF_FILE_GRANT, PF_FILE_BAD_COMPONENT, "traversal, ADS, device or ambiguous component refuses");
    }
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"missing", (PFFileRole)99, PF_FILE_BAD_ROLE, "unknown closed role refuses");
    refusal(&directory, L"missing", PF_FILE_GRANT, PF_FILE_OPEN_FAILED, "missing leaf is not created or adopted");

    check(child_path(path, root, L"directory") && CreateDirectoryW(path, NULL), "construct actual directory leaf");
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"directory", PF_FILE_GRANT, PF_FILE_OPEN_FAILED, "non-directory NT open refuses a directory leaf");
    check(RemoveDirectoryW(path), "remove only owned directory-leaf fixture");
    check(child_path(path, root, L"target") && child_path(other, root, L"symlink") && make_file(path, NULL, 32) &&
        CreateSymbolicLinkW(other, path, SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE), "construct actual file symlink; unavailable fixture fails");
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"symlink", PF_FILE_GRANT, PF_FILE_REPARSE, "opened actual symlink refuses without reading its target");
    check(exact_content(path, 32) && DeleteFileW(other) && remove_file(path), "refusal preserves target before own symlink cleanup");

    check(child_path(path, root, L"junction") && child_path(other, path, L"anything") && make_junction(path, root),
        "construct actual NTFS intermediate-junction fixture");
    {
        PFDirectory unsafeParent;
        PFDirectoryIdentity originalRoot;
        if (!check(pf_directory_inspect(&directory, NULL, &originalRoot) == PF_OK,
            "capture exact root identity before independent junction probe")) goto done;
        /* The original final root lease has FILE_ADD_SUBDIRECTORY with share
         * READ only. Release it so this distinct probe reaches the junction. */
        pf_directory_close(&directory); directoryOpened = FALSE;
        reset_mode(FX_NONE, NULL, NULL);
        check(pf_directory_open_root(other, NULL, &unsafeParent) == PF_REPARSE && consumed == 0 && fileOpens == 0,
            "intermediate junction refuses before any file lease or content read");
        pf_directory_close(&unsafeParent);
        if (!check(pf_directory_open_root(root, &originalRoot, &directory) == PF_OK,
            "reacquire exact same owned root identity after junction probe")) goto done;
        directoryOpened = TRUE;
    }
    check(RemoveDirectoryW(path), "remove only owned junction without following its target");

    check(child_path(path, root, L"shared") && child_path(other, root, L"must-not-move") && make_file(path, NULL, PF_GRANT_BYTES),
        "construct actual exact-cap sharing fixture");
    reset_mode(FX_SHARING, path, other);
    result = read_case(&directory, L"shared", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
    check(result == PF_FILE_OK && length == PF_GRANT_BYTES && consumed == PF_GRANT_BYTES && requested == PF_GRANT_BYTES,
        "exact-cap file succeeds with no extra byte requested or consumed");
    check(writeExcluded && growExcluded && renameExcluded, "actual held kernel lease excludes write, append-growth and same-name replacement");
    check(exact_content(path, PF_GRANT_BYTES) && remove_file(path), "sharing attempts preserve content and all reader handles close");

    check(child_path(path, root, L"replace") && child_path(other, root, L"old-identity") && make_file(path, NULL, 32),
        "construct actual expected-identity fixture");
    reset_mode(FX_NONE, NULL, NULL);
    check(read_case(&directory, L"replace", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &expected) == PF_FILE_OK,
        "capture actual previous file stamp");
    reset_mode(FX_NONE, NULL, NULL);
    memset(output, 0xa5, sizeof(output));
    check(pf_file_read(&directory, L"replace", PF_FILE_GRANT, &expected, output, 32, &length, &expected) == PF_FILE_OK &&
        length == 32 && memcmp(output, pattern, 32) == 0 && output[32] == 0xa5,
        "valid small output stays bounded and expected/observed stamp may alias");
    {
        PFDirectoryIdentity originalRoot, replacement, displaced;
        DWORD replacementLinks = 0, displacedLinks = 0;
        if (!check(pf_directory_inspect(&directory, NULL, &originalRoot) == PF_OK,
            "capture exact root identity before same-byte namespace replacement")) goto done;
        pf_directory_close(&directory); directoryOpened = FALSE;
        reset_mode(FX_NONE, NULL, NULL);
        mutationCalls++;
        mutationOK = MoveFileW(path, other) && make_file(path, NULL, 32);
        check(mutationOK && fixture_identity(path, &replacement, &replacementLinks) &&
            fixture_identity(other, &displaced, &displacedLinks) && replacementLinks == 1 && displacedLinks == 1 &&
            !same_fixture_identity(&replacement, &expected.identity) && same_fixture_identity(&displaced, &expected.identity) &&
            exact_content(path, 32) && exact_content(other, 32),
            "independent kernel query verifies actual replacement differs from retained old file identity");
        if (!check(pf_directory_open_root(root, &originalRoot, &directory) == PF_OK,
            "reacquire exact same root identity before old-stamp refusal")) goto done;
        directoryOpened = TRUE;
    }
    result = read_case(&directory, L"replace", PF_FILE_GRANT, &expected, output, (DWORD)sizeof(output), &length, &stamp);
    check(mutationOK && mutationCalls == 1 && result == PF_FILE_IDENTITY_CHANGED && consumed == 0 && length == 0 && zero_output(output, (DWORD)sizeof(output)),
        "late pre-open actual same-byte replacement refuses old expected identity before reads");
    check(exact_content(path, 32) && exact_content(other, 32), "both same-byte replacement and displaced file remain unchanged");
    check(remove_file(path) && remove_file(other), "remove only two owned expected-identity fixture files");

    check(child_path(path, root, L"grown") && make_file(path, NULL, 32), "construct real later-growth fixture");
    reset_mode(FX_NONE, NULL, NULL);
    check(read_case(&directory, L"grown", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &expected) == PF_FILE_OK,
        "capture real file before later append growth");
    {
        HANDLE writer = CreateFileW(path, FILE_APPEND_DATA, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        DWORD written = 0;
        BOOL appended = writer != INVALID_HANDLE_VALUE && WriteFile(writer, pattern + 32, 1, &written, NULL) && written == 1;
        if (writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
        check(appended, "grow actual file after the previous read lease ends");
    }
    reset_mode(FX_NONE, NULL, NULL);
    result = read_case(&directory, L"grown", PF_FILE_GRANT, &expected, output, (DWORD)sizeof(output), &length, &stamp);
    check(result == PF_FILE_IDENTITY_CHANGED && consumed == 0 && length == 0 && zero_output(output, (DWORD)sizeof(output)),
        "actual later growth refuses stale expected length before reading");
    check(exact_content(path, 33) && remove_file(path), "growth refusal retains independently measured content");

    for (i = 0; i < 2; i++) {
        check(child_path(path, root, L"late-acl") && make_file(path, NULL, 32), "construct actual late-ACL fixture");
        reset_mode(i == 0 ? FX_PUBLIC_ACL : FX_PRIVATE_ACL, path, NULL);
        result = read_case(&directory, L"late-acl", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
        check(mutationOK && mutationCalls == 1 && result != PF_FILE_OK && length == 0 && zero_output(output, (DWORD)sizeof(output)),
            "actual public or still-private ACL change during read clears all private output");
        check(exact_content(path, 32), "late ACL refusal preserves actual content");
        check(remove_file(path), "remove only owned late-ACL fixture after refusal");
    }

    check(child_path(path, root, L"late-attributes") && make_file(path, NULL, 32), "construct actual late basic-metadata fixture");
    before = named_security(path);
    reset_mode(FX_ATTRIBUTES, path, NULL);
    result = read_case(&directory, L"late-attributes", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
    check(mutationOK && mutationCalls == 1 && result == PF_FILE_IDENTITY_CHANGED && length == 0 && zero_output(output, (DWORD)sizeof(output)),
        "actual attribute change during read refuses the captured basic stamp and withholds output");
    check(exact_security(before, path) && exact_content(path, 32), "attribute-change refusal preserves independently measured security and bytes");
    if (before) LocalFree(before);
    check(remove_file(path), "remove only owned changed-attribute fixture");

    check(child_path(path, root, L"fault") && make_file(path, NULL, 32), "construct fresh real file for labelled SDK-call faults");
    for (i = 0; i < 3; i++) {
        reset_mode(i == 0 ? FX_ZERO : i == 1 ? FX_IO_ERROR : FX_NAMED_ERROR, NULL, NULL);
        result = read_case(&directory, L"fault", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
        check(result == (i == 2 ? PF_FILE_OPEN_FAILED : PF_FILE_IO_FAILED) && readCalls == (i == 2 ? 2u : 1u) &&
            consumed == (i == 2 ? 32u : 0u) && length == 0 && zero_output(output, (DWORD)sizeof(output)),
            "labelled injected zero-progress, I/O or final named-binding failure withholds all output");
    }
    reset_mode(FX_NONE, NULL, NULL);
    check(exact_content(path, 32) && remove_file(path), "injected-fault fixture content remains unchanged");

    check(child_path(path, root, L"capacity") && make_file(path, NULL, 32), "construct actual output-capacity fixture");
    reset_mode(FX_NONE, NULL, NULL);
    result = read_case(&directory, L"capacity", PF_FILE_GRANT, NULL, output, 31, &length, &stamp);
    check(result == PF_FILE_SIZE_LIMIT && consumed == 0 && length == 0 && zero_output(output, 31), "caller output capacity cannot authorize excess read");
    check(remove_file(path), "remove only owned capacity fixture");

    check(private_sddl(sddl, sizeof(sddl) / sizeof(sddl[0]), L"", FALSE) && child_path(path, root, L"parent-change") &&
        make_file(path, sddl, 32), "construct actual protected-leaf late parent-security fixture");
    reset_mode(FX_PARENT_PUBLIC, root, NULL);
    result = read_case(&directory, L"parent-change", PF_FILE_GRANT, NULL, output, (DWORD)sizeof(output), &length, &stamp);
    check(mutationOK && result == PF_FILE_PARENT_UNAVAILABLE && length == 0 && zero_output(output, (DWORD)sizeof(output)),
        "actual parent ACL becoming public during read withholds output");
    check(exact_content(path, 32) && change_acl(root, L"", FALSE), "parent refusal preserves content before own root ACL restoration");
    check(remove_file(path), "remove only owned parent-change fixture");

    pf_directory_close(&directory); directoryOpened = FALSE;
    reset_mode(FX_NONE, NULL, NULL);
    refusal(&directory, L"missing", PF_FILE_GRANT, PF_FILE_PARENT_UNAVAILABLE, "closed actual parent lease cannot admit a new read");

done:
    reset_mode(FX_NONE, NULL, NULL);
    if (directoryOpened) pf_directory_close(&directory);
    if (rootCreated) check(RemoveDirectoryW(root), "all owned fixture files and retained handles cleaned before root removal");
    if (uuidText) RpcStringFreeW(&uuidText);
    if (sidText) LocalFree(sidText);
    SecureZeroMemory(output, (DWORD)sizeof(output));
    printf("1..%lu\n", (unsigned long)checks);
    return failures ? 1 : 0;
}
