/* Real Windows acceptance fixture. It is intentionally not a POSIX test or
 * mock; compile/run only after ROOT's source gate on a disposable Windows VM. */
#define WIN32_LEAN_AND_MEAN
#include "directory.h"
#include <aclapi.h>
#include <sddl.h>
#include <rpc.h>
#include <winioctl.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

static DWORD failures = 0, checks = 0;

static BOOL check(BOOL passed, const char *name) {
    checks++;
    printf("%s %lu - %s\n", passed ? "ok" : "not ok", (unsigned long)checks, name);
    if (!passed) failures++;
    return passed;
}

static BOOL path_child(WCHAR *out, size_t count, const WCHAR *root, const WCHAR *leaf) {
    return swprintf_s(out, count, L"%s\\%s", root, leaf) > 0;
}

static WCHAR *current_sid_string(void) {
    HANDLE token = NULL;
    DWORD size = 0;
    TOKEN_USER *user = NULL;
    WCHAR *sid = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    if (size && size < 65536) {
        user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), 0, size);
        if (user && GetTokenInformation(token, TokenUser, user, size, &size)) ConvertSidToStringSidW(user->User.Sid, &sid);
    }
    if (user) HeapFree(GetProcessHeap(), 0, user);
    CloseHandle(token);
    return sid;
}

static BOOL fixture_create(const WCHAR *path, const WCHAR *sid, BOOL everyone, BOOL nullAcl, BOOL foreignOwner) {
    WCHAR sddl[1024];
    PSECURITY_DESCRIPTOR security = NULL;
    SECURITY_ATTRIBUTES attributes;
    BOOL created;
    const WCHAR *owner = foreignOwner ? L"BA" : sid;
    if ((nullAcl ? swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%sD:NO_ACCESS_CONTROL", owner) :
        swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%sD:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)%s",
        owner, sid, everyone ? L"(A;OICI;GR;;;WD)" : L"")) <= 0 ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    ZeroMemory(&attributes, sizeof(attributes));
    attributes.nLength = (DWORD)sizeof(attributes); attributes.lpSecurityDescriptor = security;
    created = CreateDirectoryW(path, &attributes);
    LocalFree(security);
    return created;
}

static BOOL fixture_sddl(const WCHAR *path, const WCHAR *sddl) {
    PSECURITY_DESCRIPTOR security = NULL;
    SECURITY_ATTRIBUTES attributes;
    BOOL created;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &security, NULL)) return FALSE;
    ZeroMemory(&attributes, sizeof(attributes));
    attributes.nLength = (DWORD)sizeof(attributes); attributes.lpSecurityDescriptor = security;
    created = CreateDirectoryW(path, &attributes);
    LocalFree(security);
    return created;
}

/* Independently read the OS security descriptor through a fresh named query.
 * The verdict functions are never used to manufacture expected ACLs. */
static PSECURITY_DESCRIPTOR descriptor(const WCHAR *path) {
    PSECURITY_DESCRIPTOR out = NULL;
    return GetNamedSecurityInfoW((WCHAR *)path, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, NULL, NULL, NULL, NULL, &out) == ERROR_SUCCESS ? out : NULL;
}

static BOOL identical_security(PSECURITY_DESCRIPTOR before, const WCHAR *path) {
    PSECURITY_DESCRIPTOR after = descriptor(path);
    BOOL same = before && after && GetSecurityDescriptorLength(before) == GetSecurityDescriptorLength(after) &&
        memcmp(before, after, GetSecurityDescriptorLength(before)) == 0;
    if (after) LocalFree(after);
    return same;
}

static BOOL independent_new_acl(const WCHAR *path, const WCHAR *sidText) {
    PSECURITY_DESCRIPTOR security = descriptor(path);
    PSID expected = NULL, owner = NULL;
    PACL acl = NULL;
    BOOL defaulted = FALSE, present = FALSE, ok = FALSE;
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision = 0, i;
    BYTE system[SECURITY_MAX_SID_SIZE], admins[SECURITY_MAX_SID_SIZE];
    DWORD systemSize = (DWORD)sizeof(system), adminSize = (DWORD)sizeof(admins);
    BOOL gotUser = FALSE, gotSystem = FALSE, gotAdmins = FALSE;
    if (!security || !ConvertStringSidToSidW(sidText, &expected) ||
        !GetSecurityDescriptorOwner(security, &owner, &defaulted) || !owner || !EqualSid(owner, expected) ||
        !GetSecurityDescriptorControl(security, &control, &revision) || !(control & SE_DACL_PROTECTED) ||
        !GetSecurityDescriptorDacl(security, &present, &acl, &defaulted) || !present || !acl || acl->AceCount != 3 ||
        !CreateWellKnownSid(WinLocalSystemSid, NULL, system, &systemSize) || !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admins, &adminSize)) goto done;
    for (i = 0; i < acl->AceCount; i++) {
        ACCESS_ALLOWED_ACE *ace = NULL;
        PSID granted;
        if (!GetAce(acl, i, (LPVOID *)&ace) || !ace || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
            ace->Mask != FILE_ALL_ACCESS || ace->Header.AceFlags != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) goto done;
        granted = (PSID)&ace->SidStart;
        if (EqualSid(granted, expected) && !gotUser) gotUser = TRUE;
        else if (EqualSid(granted, system) && !gotSystem) gotSystem = TRUE;
        else if (EqualSid(granted, admins) && !gotAdmins) gotAdmins = TRUE;
        else goto done;
    }
    ok = gotUser && gotSystem && gotAdmins;
done:
    if (expected) LocalFree(expected);
    if (security) LocalFree(security);
    return ok;
}

typedef struct {
    DWORD tag;
    WORD bytes;
    WORD reserved;
    WORD substituteOffset;
    WORD substituteLength;
    WORD printOffset;
    WORD printLength;
    WCHAR names[PF_ROOT_LIMIT + 16];
} FixtureMountPoint;

static BOOL fixture_junction(const WCHAR *link, const WCHAR *target) {
    FixtureMountPoint reparse;
    WCHAR substitute[PF_ROOT_LIMIT + 8];
    size_t length;
    DWORD returned = 0, bytes;
    HANDLE handle;
    BOOL ok;
    if (!CreateDirectoryW(link, NULL) || swprintf_s(substitute, sizeof(substitute) / sizeof(substitute[0]), L"\\??\\%s", target) <= 0) return FALSE;
    length = wcslen(substitute);
    ZeroMemory(&reparse, sizeof(reparse));
    reparse.tag = IO_REPARSE_TAG_MOUNT_POINT;
    reparse.substituteLength = (WORD)(length * sizeof(WCHAR));
    reparse.printOffset = (WORD)((length + 1) * sizeof(WCHAR));
    /* An empty print name is sufficient; the real substitute target is used. */
    memcpy(reparse.names, substitute, (length + 1) * sizeof(WCHAR));
    reparse.bytes = (WORD)(8 + (length + 2) * sizeof(WCHAR));
    bytes = (DWORD)reparse.bytes + 8;
    handle = CreateFileW(link, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return FALSE;
    ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &reparse, bytes, NULL, 0, &returned, NULL);
    CloseHandle(handle);
    return ok;
}

static void inspect_fixture(const WCHAR *root, const WCHAR *leaf, const WCHAR *sid, BOOL everyone, BOOL nullAcl, BOOL foreignOwner) {
    WCHAR path[PF_ROOT_LIMIT + 1];
    PFDirectory directory;
    PSECURITY_DESCRIPTOR before;
    PFDirectoryResult result;
    if (!check(path_child(path, sizeof(path) / sizeof(path[0]), root, leaf) && fixture_create(path, sid, everyone, nullAcl, foreignOwner), "construct actual ACL refusal fixture")) return;
    before = descriptor(path);
    result = pf_directory_open_root(path, NULL, &directory);
    if (check(result == PF_OK, "open actual existing fixture without ACL mutation")) {
        check(pf_directory_inspect(&directory, NULL, NULL) == PF_NOT_PRIVATE, "unsafe or foreign-owner DACL is refused");
        check(pf_directory_create_child(&directory, L"must-not-exist", NULL) == PF_NOT_PRIVATE, "unsafe parent cannot receive a new private child");
        pf_directory_close(&directory);
    }
    check(identical_security(before, path), "refused existing descriptor stays byte-for-byte unchanged");
    if (before) LocalFree(before);
    check(RemoveDirectoryW(path), "remove only own empty refusal fixture");
}

int wmain(void) {
    WCHAR temp[PF_ROOT_LIMIT + 1], root[PF_ROOT_LIMIT + 1], path[PF_ROOT_LIMIT + 1], renamed[PF_ROOT_LIMIT + 1], sddl[1024];
    WCHAR *sid = current_sid_string();
    UUID uuid;
    RPC_WSTR text = NULL;
    PFDirectory directory;
    PFDirectoryIdentity original;
    PSECURITY_DESCRIPTOR before;
    PFDirectoryResult result;
    DWORD tempLength, renameError;
    BOOL moved;
    HANDLE file;
    if (!check(sid != NULL, "capture actual current token SID")) return 1;
    tempLength = GetTempPathW((DWORD)(sizeof(temp) / sizeof(temp[0])), temp);
    if (!check(tempLength > 0 && tempLength < sizeof(temp) / sizeof(temp[0]) && UuidCreate(&uuid) == RPC_S_OK && UuidToStringW(&uuid, &text) == RPC_S_OK,
        "allocate fresh synthetic directory name")) { LocalFree(sid); return 1; }
    if (temp[tempLength - 1] == L'\\') temp[tempLength - 1] = 0;
    if (!check(swprintf_s(root, sizeof(root) / sizeof(root[0]), L"%s\\plexiform-dacl-%s", temp, (WCHAR *)text) > 0 && fixture_create(root, sid, FALSE, FALSE, FALSE), "create fresh protected test root")) goto finish;
    result = pf_directory_open_root(root, NULL, &directory);
    if (!check(result == PF_OK, "rooted native NTFS directory opens")) goto cleanup;
    ZeroMemory(&original, sizeof(original));
    before = descriptor(root);
    check(pf_directory_inspect(&directory, NULL, &original) == PF_OK, "actual private current-user root accepted");
    if (check(swprintf_s(renamed, sizeof(renamed) / sizeof(renamed[0]), L"%s-held-rename", root) > 0, "allocate unique own replacement name")) {
        moved = MoveFileW(root, renamed); renameError = GetLastError();
        check(!moved && (renameError == ERROR_SHARING_VIOLATION || renameError == ERROR_ACCESS_DENIED), "held ancestor handles block namespace replacement");
        if (moved) check(MoveFileW(renamed, root), "restore own root after unexpected move");
    }
    check(identical_security(before, root), "inspection does not change existing root DACL");
    if (before) LocalFree(before);
    check(pf_directory_create_child(&directory, L"new-private", NULL) == PF_OK, "exclusive absent child created through parent handle");
    check(path_child(path, sizeof(path) / sizeof(path[0]), root, L"new-private") && independent_new_acl(path, sid), "independent native query verifies exact new owner/protected three-principal DACL");
    pf_directory_close(&directory);
    if (pf_directory_open_root(root, NULL, &directory) == PF_OK) {
        before = descriptor(path);
        check(pf_directory_create_child(&directory, L"new-private", NULL) == PF_EXISTS, "existing name is never adopted or overwritten");
        pf_directory_close(&directory);
        check(identical_security(before, path), "exclusive-create collision preserves original ACL bytes");
        if (before) LocalFree(before);
    } else check(FALSE, "reopen root for collision fixture");
    check(RemoveDirectoryW(path), "remove only own new empty child fixture");

    path_child(path, sizeof(path) / sizeof(path[0]), root, L"inherited-private");
    check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%s", sid) > 0 && fixture_sddl(path, sddl), "create actual current-user inherited ACL fixture");
    before = descriptor(path);
    if (check(pf_directory_open_root(path, NULL, &directory) == PF_OK, "open inherited ACL fixture")) {
        check(pf_directory_inspect(&directory, NULL, NULL) == PF_OK, "secure current-user inherited ACL accepted");
        pf_directory_close(&directory);
    }
    check(identical_security(before, path), "inherited ACL remains byte-for-byte unchanged");
    if (before) LocalFree(before);
    check(RemoveDirectoryW(path), "remove own inherited fixture");

    inspect_fixture(root, L"everyone-read", sid, TRUE, FALSE, FALSE);
    inspect_fixture(root, L"null-dacl", sid, FALSE, TRUE, FALSE);
    inspect_fixture(root, L"other-owner", sid, FALSE, FALSE, TRUE);

    path_child(path, sizeof(path) / sizeof(path[0]), root, L"object-ace");
    if (check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%sD:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(OA;OICI;GR;00000000-0000-0000-0000-000000000001;;%s)", sid, sid, sid) > 0 &&
        fixture_sddl(path, sddl), "construct actual unsupported object ACE fixture")) {
        before = descriptor(path);
        if (check(pf_directory_open_root(path, NULL, &directory) == PF_OK, "open actual unsupported ACL fixture")) {
            check(pf_directory_inspect(&directory, NULL, NULL) == PF_NOT_PRIVATE, "unsupported object grant is refused");
            pf_directory_close(&directory);
        }
        check(identical_security(before, path), "unsupported ACL bytes unchanged");
        if (before) LocalFree(before);
        check(RemoveDirectoryW(path), "remove own unsupported ACL fixture");
    }
    path_child(path, sizeof(path) / sizeof(path[0]), root, L"unreadable-acl");
    if (check(swprintf_s(sddl, sizeof(sddl) / sizeof(sddl[0]), L"O:%sD:P(D;;RC;;;OW)(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", sid, sid) > 0 &&
        fixture_sddl(path, sddl), "construct actual owner-rights read-control denial")) {
        result = pf_directory_open_root(path, NULL, &directory);
        check(result != PF_OK, "unreadable existing security descriptor refuses before use");
        if (result == PF_OK) pf_directory_close(&directory);
        check(RemoveDirectoryW(path), "remove only own unreadable ACL fixture");
    }

    path_child(path, sizeof(path) / sizeof(path[0]), root, L"junction");
    if (check(fixture_junction(path, root), "construct actual directory junction")) {
        check(pf_directory_open_root(path, NULL, &directory) == PF_REPARSE, "opened final junction refuses before traversal");
        path_child(renamed, sizeof(renamed) / sizeof(renamed[0]), path, L"anything");
        result = pf_directory_open_root(renamed, NULL, &directory);
        check(result == PF_REPARSE, "intermediate junction refuses before following target");
        check(RemoveDirectoryW(path), "remove own junction link only");
    }
    path_child(path, sizeof(path) / sizeof(path[0]), root, L"regular-file");
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (check(file != INVALID_HANDLE_VALUE, "construct actual non-directory file")) {
        CloseHandle(file);
        check(pf_directory_open_root(path, NULL, &directory) != PF_OK, "regular file cannot become private directory");
        check(DeleteFileW(path), "remove own regular file fixture");
    }
    check(pf_directory_open_root(L"\\\\.\\pipe\\plexiform-no-connect", NULL, &directory) == PF_UNSUPPORTED_ROOT, "named-pipe/device root rejected without connection");
    if (check(pf_directory_open_root(root, NULL, &directory) == PF_OK, "open root for invalid component fixtures")) {
        const WCHAR *invalid[] = { L".", L"..", L"../foreign", L"a\\b", L"alternate:stream", L"trailing.", L"trailing ", L"NUL", L"com1.log" };
        size_t i;
        for (i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) check(pf_directory_create_child(&directory, invalid[i], NULL) == PF_BAD_COMPONENT, "invalid component never reaches creation");
        pf_directory_close(&directory);
    }
    /* Replacement after releasing the lease must still fail a captured file-ID
     * comparison. Keep the displaced original until verification/cleanup. */
    if (check(swprintf_s(renamed, sizeof(renamed) / sizeof(renamed[0]), L"%s-displaced", root) > 0 && MoveFileW(root, renamed), "move only own root after lease closes")) {
        if (check(fixture_create(root, sid, FALSE, FALSE, FALSE), "create own replacement with a different file identity")) {
            before = descriptor(root);
            check(pf_directory_open_root(root, &original, &directory) == PF_IDENTITY_CHANGED, "stale root identity refused before inspection/use");
            check(identical_security(before, root), "replacement ACL unchanged by identity refusal");
            if (before) LocalFree(before);
            check(RemoveDirectoryW(root), "remove own empty replacement");
        }
        check(MoveFileW(renamed, root), "restore only own displaced original fixture");
    }
cleanup:
    check(RemoveDirectoryW(root), "clean own empty fixture root");
finish:
    if (text) RpcStringFreeW(&text);
    LocalFree(sid);
    printf("1..%lu\n", (unsigned long)checks);
    printf("# native Windows DACL checks=%lu failures=%lu\n", (unsigned long)checks, (unsigned long)failures);
    return failures ? 1 : 0;
}
