#define WIN32_LEAN_AND_MEAN
#include "directory.h"
#include <winternl.h>
#include <aclapi.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

/* These SDK/NT constants have fixed documented values. Some user-mode SDK
 * headers omit the names; no downloaded header or runtime fallback is used. */
#ifndef FILE_OPEN
#define FILE_OPEN 1
#endif
#ifndef FILE_CREATE
#define FILE_CREATE 2
#endif
#ifndef FILE_CREATED
#define FILE_CREATED 2
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x00000040
#endif

#define PF_DIR_READ (FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE)
#define PF_DIR_PARENT (PF_DIR_READ | FILE_ADD_SUBDIRECTORY)
#define PF_NAME_COLLISION ((NTSTATUS)0xC0000035L)

typedef struct {
    HANDLE processToken;
    HANDLE accessToken;
    TOKEN_USER *user;
    BYTE system[SECURITY_MAX_SID_SIZE];
    BYTE administrators[SECURITY_MAX_SID_SIZE];
} PFToken;

static HANDLE current_handle(const PFDirectory *directory) {
    if (!directory || directory->count == 0 || directory->count > PF_DIRECTORY_DEPTH) return INVALID_HANDLE_VALUE;
    return directory->handles[directory->count - 1];
}

static void token_close(PFToken *token) {
    if (token->accessToken) CloseHandle(token->accessToken);
    if (token->processToken) CloseHandle(token->processToken);
    if (token->user) HeapFree(GetProcessHeap(), 0, token->user);
    ZeroMemory(token, sizeof(*token));
}

static BOOL token_open(PFToken *token) {
    DWORD size = 0, sidSize = SECURITY_MAX_SID_SIZE;
    ZeroMemory(token, sizeof(*token));
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &token->processToken)) goto refused;
    if (GetTokenInformation(token->processToken, TokenUser, NULL, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size > 65536) goto refused;
    token->user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
    if (!token->user || !GetTokenInformation(token->processToken, TokenUser, token->user, size, &size) || !IsValidSid(token->user->User.Sid)) goto refused;
    if (!DuplicateToken(token->processToken, SecurityImpersonation, &token->accessToken)) goto refused;
    if (!CreateWellKnownSid(WinLocalSystemSid, NULL, token->system, &sidSize)) goto refused;
    sidSize = SECURITY_MAX_SID_SIZE;
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, token->administrators, &sidSize)) goto refused;
    return TRUE;
refused:
    token_close(token);
    return FALSE;
}

static BOOL allowed_sid(PSID sid, const PFToken *token) {
    return EqualSid(sid, token->user->User.Sid) || EqualSid(sid, (PSID)token->system) || EqualSid(sid, (PSID)token->administrators);
}

static PFDirectoryResult directory_details(HANDLE handle, PFDirectoryIdentity *identity) {
    FILE_ATTRIBUTE_TAG_INFO attributes;
    FILE_STANDARD_INFO standard;
    FILE_ID_INFO id;
    WCHAR filesystem[32];
    DWORD flags = 0;
    if (handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK) return PF_NOT_DIRECTORY;
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, (DWORD)sizeof(attributes)) ||
        !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, (DWORD)sizeof(standard))) return PF_OPEN_FAILED;
    if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || attributes.ReparseTag != 0) return PF_REPARSE;
    if (!standard.Directory || standard.NumberOfLinks != 1 || standard.DeletePending || (attributes.FileAttributes & FILE_ATTRIBUTE_DEVICE)) return PF_NOT_DIRECTORY;
    if (!GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, &flags, filesystem, (DWORD)(sizeof(filesystem) / sizeof(filesystem[0]))) ||
        wcscmp(filesystem, L"NTFS") != 0 || !(flags & FILE_PERSISTENT_ACLS)) return PF_UNSUPPORTED_VOLUME;
    if (!GetFileInformationByHandleEx(handle, FileIdInfo, &id, (DWORD)sizeof(id))) return PF_OPEN_FAILED;
    if (identity) { identity->volume = id.VolumeSerialNumber; memcpy(identity->file, id.FileId.Identifier, sizeof(identity->file)); }
    return PF_OK;
}

static BOOL same_identity(const PFDirectoryIdentity *a, const PFDirectoryIdentity *b) {
    return a->volume == b->volume && memcmp(a->file, b->file, sizeof(a->file)) == 0;
}

static BOOL valid_component(const WCHAR *name, size_t length) {
    size_t i, stem = length;
    WCHAR upper[PF_COMPONENT_LIMIT + 1];
    if (!name || length == 0 || length > PF_COMPONENT_LIMIT || name[length - 1] == L'.' || name[length - 1] == L' ') return FALSE;
    if ((length == 1 && name[0] == L'.') || (length == 2 && name[0] == L'.' && name[1] == L'.')) return FALSE;
    for (i = 0; i < length; i++) {
        WCHAR c = name[i];
        if (c < 32 || c == 127 || wcschr(L"\\/:*?\"<>|", c)) return FALSE;
        /* Reject unpaired surrogates before creating a Unicode name. */
        if (c >= 0xd800 && c <= 0xdbff) {
            if (i + 1 == length || name[i + 1] < 0xdc00 || name[i + 1] > 0xdfff) return FALSE;
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) return FALSE;
    }
    for (i = 0; i < length; i++) {
        upper[i] = name[i] >= L'a' && name[i] <= L'z' ? (WCHAR)(name[i] - L'a' + L'A') : name[i];
        if (name[i] == L'.' && stem == length) stem = i;
    }
    upper[length] = 0;
    if ((stem == 3 && (!wcsncmp(upper, L"CON", 3) || !wcsncmp(upper, L"PRN", 3) || !wcsncmp(upper, L"AUX", 3) || !wcsncmp(upper, L"NUL", 3))) ||
        (stem == 4 && (!wcsncmp(upper, L"COM", 3) || !wcsncmp(upper, L"LPT", 3)) &&
            ((upper[3] >= L'1' && upper[3] <= L'9') || upper[3] == 0x00b9 || upper[3] == 0x00b2 || upper[3] == 0x00b3))) return FALSE;
    return TRUE;
}

static PFDirectoryResult open_component(HANDLE parent, WCHAR *name, USHORT characters,
    ULONG disposition, ACCESS_MASK access, PSECURITY_DESCRIPTOR security, HANDLE *out) {
    UNICODE_STRING unicode;
    OBJECT_ATTRIBUTES attributes;
    IO_STATUS_BLOCK io;
    NTSTATUS status;
    ZeroMemory(&unicode, sizeof(unicode));
    unicode.Buffer = name;
    unicode.Length = (USHORT)(characters * sizeof(WCHAR));
    unicode.MaximumLength = unicode.Length;
    ZeroMemory(&attributes, sizeof(attributes));
    attributes.Length = (ULONG)sizeof(attributes);
    attributes.RootDirectory = parent;
    attributes.ObjectName = &unicode;
    attributes.Attributes = OBJ_CASE_INSENSITIVE;
    attributes.SecurityDescriptor = security;
    ZeroMemory(&io, sizeof(io));
    *out = INVALID_HANDLE_VALUE;
    status = NtCreateFile(out, access, &attributes, &io, NULL, FILE_ATTRIBUTE_DIRECTORY,
        FILE_SHARE_READ, disposition, FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, NULL, 0);
    if (status < 0) return status == PF_NAME_COLLISION ? PF_EXISTS : PF_OPEN_FAILED;
    if (disposition == FILE_CREATE && io.Information != FILE_CREATED) { CloseHandle(*out); *out = INVALID_HANDLE_VALUE; return PF_OPEN_FAILED; }
    return PF_OK;
}

void pf_directory_close(PFDirectory *directory) {
    if (!directory) return;
    while (directory->count && directory->count <= PF_DIRECTORY_DEPTH) CloseHandle(directory->handles[--directory->count]);
    ZeroMemory(directory, sizeof(*directory));
}

PFDirectoryResult pf_directory_open_root(const WCHAR *canonicalRoot, const PFDirectoryIdentity *expected, PFDirectory *directory) {
    WCHAR drive[] = L"C:\\", driveNamespace[] = L"\\\\?\\C:\\";
    size_t length, at;
    PFDirectoryResult result;
    PFDirectoryIdentity identity;
    HANDLE handle;
    if (!directory) return PF_UNSUPPORTED_ROOT;
    ZeroMemory(directory, sizeof(*directory));
    if (!canonicalRoot) return PF_UNSUPPORTED_ROOT;
    length = wcsnlen_s(canonicalRoot, PF_ROOT_LIMIT + 1);
    if (length < 4 || length > PF_ROOT_LIMIT || !((canonicalRoot[0] >= L'A' && canonicalRoot[0] <= L'Z') || (canonicalRoot[0] >= L'a' && canonicalRoot[0] <= L'z')) ||
        canonicalRoot[1] != L':' || canonicalRoot[2] != L'\\') return PF_UNSUPPORTED_ROOT;
    drive[0] = canonicalRoot[0]; driveNamespace[4] = canonicalRoot[0];
    if (GetDriveTypeW(drive) != DRIVE_FIXED) return PF_UNSUPPORTED_ROOT;
    handle = CreateFileW(driveNamespace, PF_DIR_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return PF_OPEN_FAILED;
    directory->handles[directory->count++] = handle;
    result = directory_details(handle, NULL);
    if (result != PF_OK) goto refused;
    for (at = 3; at < length;) {
        WCHAR component[PF_COMPONENT_LIMIT + 1];
        size_t end = at, count;
        while (end < length && canonicalRoot[end] != L'\\') end++;
        count = end - at;
        if (!valid_component(canonicalRoot + at, count) || directory->count == PF_DIRECTORY_DEPTH || end + 1 == length) { result = PF_BAD_COMPONENT; goto refused; }
        memcpy(component, canonicalRoot + at, count * sizeof(WCHAR)); component[count] = 0;
        result = open_component(current_handle(directory), component, (USHORT)count, FILE_OPEN,
            end == length ? PF_DIR_PARENT : PF_DIR_READ, NULL, &handle);
        if (result != PF_OK) goto refused;
        directory->handles[directory->count++] = handle;
        result = directory_details(handle, NULL);
        if (result != PF_OK) goto refused;
        at = end + 1;
    }
    result = directory_details(current_handle(directory), &identity);
    if (result == PF_OK && expected && !same_identity(expected, &identity)) result = PF_IDENTITY_CHANGED;
    if (result == PF_OK) return PF_OK;
refused:
    pf_directory_close(directory);
    return result;
}

PFDirectoryResult pf_directory_inspect(const PFDirectory *directory, const PFDirectoryIdentity *expected, PFDirectoryIdentity *identity) {
    PFDirectoryIdentity observed;
    PFDirectoryResult result = directory_details(current_handle(directory), &observed);
    PFToken token;
    PSECURITY_DESCRIPTOR security = NULL;
    PSID owner = NULL;
    PACL acl = NULL;
    DWORD i, granted = 0, privilegeSize;
    BOOL access = FALSE;
    GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
    union { PRIVILEGE_SET alignment; BYTE bytes[sizeof(PRIVILEGE_SET) + 16 * sizeof(LUID_AND_ATTRIBUTES)]; } privileges;
    if (result != PF_OK) return result;
    if (expected && !same_identity(expected, &observed)) return PF_IDENTITY_CHANGED;
    if (!token_open(&token)) return PF_SECURITY_UNAVAILABLE;
    result = PF_SECURITY_UNAVAILABLE;
    if (GetSecurityInfo(current_handle(directory), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &acl, NULL, &security) != ERROR_SUCCESS || !security || !IsValidSecurityDescriptor(security)) goto done;
    result = PF_NOT_PRIVATE;
    if (!owner || !IsValidSid(owner) || !EqualSid(owner, token.user->User.Sid) || !acl || !IsValidAcl(acl)) goto done;
    for (i = 0; i < acl->AceCount; i++) {
        ACE_HEADER *header = NULL;
        PSID sid;
        size_t offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
        if (!GetAce(acl, i, (LPVOID *)&header) || !header ||
            (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) ||
            header->AceSize < offset + 8) goto done;
        sid = (PSID)((BYTE *)header + offset);
        if (((SID *)sid)->SubAuthorityCount > SID_MAX_SUB_AUTHORITIES ||
            GetSidLengthRequired(((SID *)sid)->SubAuthorityCount) > header->AceSize - offset || !IsValidSid(sid)) goto done;
        /* Inherit-only foreign grants are refused too: the directory contains
         * private files, whose inherited access must stay in the same set. */
        if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && !allowed_sid(sid, &token)) goto done;
    }
    privilegeSize = (DWORD)sizeof(privileges);
    if (!AccessCheck(security, token.accessToken, FILE_ALL_ACCESS, &mapping, (PPRIVILEGE_SET)&privileges,
        &privilegeSize, &granted, &access) || !access || (granted & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) goto done;
    result = PF_OK;
    if (identity) *identity = observed;
done:
    if (security) LocalFree(security);
    token_close(&token);
    return result;
}

PFDirectoryResult pf_directory_create_child(PFDirectory *directory, const WCHAR *component, PFDirectoryIdentity *identity) {
    PFToken token;
    PFDirectoryResult result;
    SECURITY_DESCRIPTOR security;
    PACL acl = NULL;
    DWORD aclSize;
    size_t length;
    HANDLE child = INVALID_HANDLE_VALUE;
    if (!component) return PF_BAD_COMPONENT;
    length = wcsnlen_s(component, PF_COMPONENT_LIMIT + 1);
    if (!valid_component(component, length)) return PF_BAD_COMPONENT;
    if (!directory || directory->count == 0 || directory->count >= PF_DIRECTORY_DEPTH) return PF_OPEN_FAILED;
    result = pf_directory_inspect(directory, NULL, NULL);
    if (result != PF_OK) return result;
    if (!token_open(&token)) return PF_SECURITY_UNAVAILABLE;
    result = PF_SECURITY_UNAVAILABLE;
    aclSize = (DWORD)(sizeof(ACL) + 3 * offsetof(ACCESS_ALLOWED_ACE, SidStart)) +
        GetLengthSid(token.user->User.Sid) + GetLengthSid((PSID)token.system) + GetLengthSid((PSID)token.administrators);
    acl = (PACL)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, aclSize);
    if (!acl || !InitializeAcl(acl, aclSize, ACL_REVISION) ||
        !AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, FILE_ALL_ACCESS, token.user->User.Sid) ||
        !AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, FILE_ALL_ACCESS, token.system) ||
        !AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, FILE_ALL_ACCESS, token.administrators) ||
        !InitializeSecurityDescriptor(&security, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&security, token.user->User.Sid, FALSE) || !SetSecurityDescriptorDacl(&security, TRUE, acl, FALSE) ||
        !SetSecurityDescriptorControl(&security, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) goto done;
    result = open_component(current_handle(directory), (WCHAR *)component, (USHORT)length, FILE_CREATE, PF_DIR_PARENT, &security, &child);
    if (result != PF_OK) goto done;
    directory->handles[directory->count++] = child;
    result = pf_directory_inspect(directory, NULL, identity);
    /* Never delete, rename, or "repair" a newly observed namespace on an
     * uncertain result. The parent keeps the new handle for its receipt. */
done:
    if (acl) HeapFree(GetProcessHeap(), 0, acl);
    token_close(&token);
    return result;
}

const char *pf_directory_reason(PFDirectoryResult result) {
    static const char *const reasons[] = { "ok", "bad-component", "unsupported-root", "open-failed", "exists",
        "reparse", "not-directory", "unsupported-volume", "identity-changed", "security-unavailable", "not-private" };
    return (unsigned)result < sizeof(reasons) / sizeof(reasons[0]) ? reasons[result] : "unavailable";
}
