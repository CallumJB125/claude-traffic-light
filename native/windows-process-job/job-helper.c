// Process ownership, not a provider security sandbox. Private inherited stdio
// is the control channel. Provider bytes cannot impersonate helper receipts.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <string.h>

static HANDLE job, input, output, child_input, parent_process;
static BYTE installer_sid[SECURITY_MAX_SID_SIZE];
static int has_installer_sid;
static CRITICAL_SECTION output_lock;
static int read_exact(HANDLE h, void *p, DWORD n) {
    DWORD got; BYTE *b = (BYTE *)p;
    while (n) { if (!ReadFile(h, b, n, &got, NULL) || !got) return 0; b += got; n -= got; }
    return 1;
}
static int write_exact(HANDLE h, const void *p, DWORD n) {
    DWORD sent; const BYTE *b = (const BYTE *)p;
    while (n) { if (!WriteFile(h, b, n, &sent, NULL) || !sent) return 0; b += sent; n -= sent; }
    return 1;
}
static void frame(BYTE kind, const void *data, DWORD n) {
    BYTE head[5]; int ok;
    head[0] = kind; memcpy(head + 1, &n, 4);
    EnterCriticalSection(&output_lock);
    ok = write_exact(output, head, 5) && write_exact(output, data, n);
    LeaveCriticalSection(&output_lock);
    if (!ok) { if (job) TerminateJobObject(job, 1); ExitProcess(1); }
}
static int trusted_sid(PSID sid, PSID user) {
    return (has_installer_sid && EqualSid(sid, installer_sid)) || EqualSid(sid, user) || IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
}
// Hold the executable and every ancestor without delete sharing through launch.
// On files deny write sharing too. Reject reparse ancestry and untrusted writers.
static int trusted_executable(const WCHAR *name, HANDLE *held, DWORD *count) {
    WCHAR *p; HANDLE token; DWORD size = 0; TOKEN_USER *user; int ok = 0, is_file = 0; size_t length, stop = 3;
    *count = 0;
    { DWORD sid_size = sizeof(installer_sid), domain_size = 128; WCHAR domain[128]; SID_NAME_USE use;
      has_installer_sid = LookupAccountNameW(NULL, L"NT SERVICE\\TrustedInstaller", installer_sid, &sid_size, domain, &domain_size, &use); }
    if (!name || wcslen(name) < 4 || wcslen(name) > 32760 || name[1] != L':' || name[2] != L'\\' || wcschr(name, L'/') || wcschr(name + 2, L':') || wcsstr(name, L"\\..") || wcsstr(name, L"\\.\\")) return 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    user = (TOKEN_USER *)malloc(size);
    if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) { free(user); CloseHandle(token); return 0; }
    CloseHandle(token); p = _wcsdup(name);
    if (!p) { free(user); return 0; }
    length = wcslen(p);
    for (;;) {
        WCHAR saved = p[stop];
        HANDLE h; BY_HANDLE_FILE_INFORMATION info; PSECURITY_DESCRIPTOR sd = NULL; PACL acl = NULL; PSID owner = NULL; DWORD i, ace_count;
        if (*count >= 256) break;
        p[stop] = 0; is_file = stop == length;
        h = CreateFileW(p, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | (is_file ? 0 : FILE_SHARE_WRITE), NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
        p[stop] = saved;
        if (h == INVALID_HANDLE_VALUE) break;
        held[(*count)++] = h;
        if (!GetFileInformationByHandle(h, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == is_file)) break;
        if (GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &sd) != ERROR_SUCCESS) break;
        if (!owner || !acl || !trusted_sid(owner, user->User.Sid)) { LocalFree(sd); break; }
        ace_count = acl->AceCount;
        for (i = 0; i < ace_count; i++) {
            ACE_HEADER *ace; ACCESS_ALLOWED_ACE *allow; DWORD dangerous = DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL;
            if (!GetAce(acl, i, (void **)&ace)) break;
            if (ace->AceFlags & INHERIT_ONLY_ACE) continue;
            if (ace->AceType == ACCESS_DENIED_ACE_TYPE) continue;
            if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE) break;
            allow = (ACCESS_ALLOWED_ACE *)ace;
            dangerous |= is_file ? (FILE_WRITE_DATA | FILE_APPEND_DATA | GENERIC_WRITE) : FILE_DELETE_CHILD;
            if ((allow->Mask & dangerous) && !trusted_sid((PSID)&allow->SidStart, user->User.Sid)) break;
        }
        LocalFree(sd); if (i != ace_count) break;
        if (is_file) { ok = 1; break; }
        if (stop != 3) stop++;
        while (stop < length && p[stop] != L'\\') stop++;
    }
    free(p); free(user); return ok;
}
static DWORD WINAPI watch_parent(void *unused) {
    (void)unused; WaitForSingleObject(parent_process, INFINITE);
    TerminateJobObject(job, 1); ExitProcess(1); return 0;
}
static DWORD WINAPI control(void *unused) {
    BYTE head[5], *data; DWORD n; (void)unused;
    for (;;) {
        if (!read_exact(input, head, 5)) break;
        memcpy(&n, head + 1, 4); if (n > 1048576) break;
        if (head[0] == 4 && !n) { TerminateJobObject(job, 1); return 0; }
        if (head[0] == 3 && !n) { if (child_input) { CloseHandle(child_input); child_input = NULL; } continue; }
        if (head[0] != 2 || !child_input) break;
        data = (BYTE *)malloc(n ? n : 1); if (!data) break;
        if (!read_exact(input, data, n) || !write_exact(child_input, data, n)) { free(data); break; }
        free(data);
    }
    TerminateJobObject(job, 1); return 0;
}
typedef struct { HANDLE pipe; BYTE kind; } READER;
static DWORD WINAPI pump(void *arg) {
    READER *r = (READER *)arg; BYTE b[32768]; DWORD n;
    while (ReadFile(r->pipe, b, sizeof(b), &n, NULL) && n) frame(r->kind, b, n);
    CloseHandle(r->pipe); return 0;
}
static int identity(DWORD pid) {
    FILETIME created, ended, kernel, user; HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!p) return 1;
    if (!GetProcessTimes(p, &created, &ended, &kernel, &user)) { CloseHandle(p); return 1; }
    printf("win32:%08lx%08lx\n", created.dwHighDateTime, created.dwLowDateTime); CloseHandle(p); return 0;
}
int wmain(int argc, WCHAR **argv) {
    BYTE head[5], *payload, *cursor, receipt[12]; DWORD n, lengths[4], parent_pid, i, held_count = 0, code = 1; HANDLE held[256];
    WCHAR *fields[4]; HANDLE child_in_read, child_out_write, child_err_write, read_threads[2], thread;
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE }; STARTUPINFOEXW si; PROCESS_INFORMATION pi;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; SIZE_T attr_size = 0; HANDLE inherited[3]; FILETIME created, ended, kernel, user;
    READER readers[2]; ULONGLONG until; JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting; BYTE final[5];
    if (argc == 3 && wcscmp(argv[1], L"identity") == 0) {
        WCHAR *end; unsigned long pid = wcstoul(argv[2], &end, 10); return *end || pid <= 1 ? 1 : identity((DWORD)pid);
    }
    if (argc == 3 && wcscmp(argv[1], L"trusted") == 0) {
        int result = trusted_executable(argv[2], held, &held_count); while (held_count) CloseHandle(held[--held_count]); return result ? 0 : 1;
    }
    if (argc != 1) return 1;
    input = GetStdHandle(STD_INPUT_HANDLE); output = GetStdHandle(STD_OUTPUT_HANDLE); InitializeCriticalSection(&output_lock);
    if (!read_exact(input, head, 5) || head[0] != 1) return 1;
    memcpy(&n, head + 1, 4); if (n < 36 || n > 524288) return 1;
    payload = (BYTE *)malloc(n); if (!payload || !read_exact(input, payload, n)) return 1;
    memcpy(&parent_pid, payload, 4); memcpy(lengths, payload + 4, 16); cursor = payload + 20;
    for (i = 0; i < 4; i++) {
        DWORD offset = (DWORD)(cursor - payload), j;
        if (lengths[i] < (i == 3 ? 4u : 2u) || (lengths[i] & 1) || lengths[i] > n - offset || lengths[i] > (i == 3 ? 262144u : 65534u)) return 1;
        fields[i] = (WCHAR *)cursor;
        if (fields[i][lengths[i] / 2 - 1] != 0 || (i == 3 && fields[i][lengths[i] / 2 - 2] != 0)) return 1;
        if (i < 3) for (j = 0; j + 1 < lengths[i] / 2; j++) if (!fields[i][j]) return 1;
        cursor += lengths[i];
    }
    if (cursor != payload + n || parent_pid <= 1) return 1;
    parent_process = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
    if (!parent_process || WaitForSingleObject(parent_process, 0) != WAIT_TIMEOUT) return 1;
    if (!trusted_executable(fields[0], held, &held_count)) return 1;
    job = CreateJobObjectW(NULL, NULL); if (!job) return 1;
    ZeroMemory(&limits, sizeof(limits)); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 1;
    if (!CreatePipe(&child_in_read, &child_input, &sa, 0) || !CreatePipe(&readers[0].pipe, &child_out_write, &sa, 0) || !CreatePipe(&readers[1].pipe, &child_err_write, &sa, 0)) return 1;
    if (!SetHandleInformation(child_input, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(readers[0].pipe, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(readers[1].pipe, HANDLE_FLAG_INHERIT, 0)) return 1;
    ZeroMemory(&si, sizeof(si)); si.StartupInfo.cb = sizeof(si); si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = child_in_read; si.StartupInfo.hStdOutput = child_out_write; si.StartupInfo.hStdError = child_err_write;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size); si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attr_size);
    if (!si.lpAttributeList || !InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attr_size)) return 1;
    inherited[0] = child_in_read; inherited[1] = child_out_write; inherited[2] = child_err_write;
    if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) return 1;
    if (!CreateProcessW(fields[0], fields[2], NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, fields[3], fields[1], &si.StartupInfo, &pi)) return 1;
    if (!AssignProcessToJobObject(job, pi.hProcess) || !GetProcessTimes(pi.hProcess, &created, &ended, &kernel, &user)) { TerminateProcess(pi.hProcess, 1); return 1; }
    DeleteProcThreadAttributeList(si.lpAttributeList); free(si.lpAttributeList);
    CloseHandle(child_in_read); CloseHandle(child_out_write); CloseHandle(child_err_write);
    while (held_count) CloseHandle(held[--held_count]); free(payload);
    thread = CreateThread(NULL, 0, watch_parent, NULL, 0, NULL); if (!thread) return 1; CloseHandle(thread);
    if (ResumeThread(pi.hThread) == (DWORD)-1) return 1;
    CloseHandle(pi.hThread);
    memcpy(receipt, &pi.dwProcessId, 4); memcpy(receipt + 4, &created, 8); frame(129, receipt, 12);
    readers[0].kind = 130; readers[1].kind = 131;
    for (i = 0; i < 2; i++) { read_threads[i] = CreateThread(NULL, 0, pump, &readers[i], 0, NULL); if (!read_threads[i]) return 1; }
    thread = CreateThread(NULL, 0, control, NULL, 0, NULL); if (!thread) return 1; CloseHandle(thread);
    WaitForSingleObject(pi.hProcess, INFINITE); GetExitCodeProcess(pi.hProcess, &code);
    TerminateJobObject(job, code); // A completed turn must not leave background work.
    final[4] = 0; until = GetTickCount64() + 3000;
    do {
        if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL) && accounting.ActiveProcesses == 0) { final[4] = 1; break; }
        Sleep(10);
    } while (GetTickCount64() < until);
    if (WaitForMultipleObjects(2, read_threads, TRUE, 3000) != WAIT_OBJECT_0) return 1;
    memcpy(final, &code, 4); frame(132, final, 5);
    CloseHandle(pi.hProcess); CloseHandle(job); return 0;
}
