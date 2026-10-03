/* Protected local byte streams. Main/utility processes communicate with this
 * helper over inherited stdio. No TCP, JavaScript pipe listener or default
 * pipe DACL. The fixed protocol admits 32 connections and 64KiB data blocks;
 * each direction permits one unacknowledged block per connection. */
#include "owned-foundation.c"
#include <stdio.h>
#include <stdint.h>
#include <io.h>
#include <fcntl.h>

#define PT_CONNECTIONS 32
#define PT_BLOCK 65536
#define PT_READY 1
#define PT_OPEN 2
#define PT_DATA 3
#define PT_CLOSE 4
#define PT_WRITTEN 5
#define PT_READ 7
#define PT_END 8

typedef struct {
    HANDLE pipe, peer, reader, writer, writeEvent, readEvent;
    DWORD id, writeBytes;
    volatile LONG closing, writing, ending;
    BYTE output[PT_BLOCK];
} PTConnection;
static PTConnection connections[PT_CONNECTIONS];
static CRITICAL_SECTION outputLock, connectionsLock;
static HANDLE inputHandle, outputHandle;
static PFDirectory rootLease;
static PFDirectoryIdentity rootIdentity;
static WCHAR pipeName[128];
static BYTE selfHash[32];
static DWORD nextId = 1;
static BOOL serverMode;

static BOOL exact_read(HANDLE file, void *buffer, DWORD bytes) {
    DWORD at = 0, read = 0;
    while (at < bytes) {
        if (!ReadFile(file, (BYTE *)buffer + at, bytes - at, &read, NULL) || !read) return FALSE;
        at += read;
    }
    return TRUE;
}
static BOOL exact_write(HANDLE file, const void *buffer, DWORD bytes) {
    DWORD at = 0, written = 0;
    while (at < bytes) {
        if (!WriteFile(file, (const BYTE *)buffer + at, bytes - at, &written, NULL) || !written) return FALSE;
        at += written;
    }
    return TRUE;
}
static BOOL pipe_transfer(HANDLE pipe, void *buffer, DWORD bytes, DWORD *used, BOOL writing, volatile LONG *closing) {
    OVERLAPPED operation; BOOL ok;
    ZeroMemory(&operation, sizeof(operation));
    operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!operation.hEvent) return FALSE;
    ok = writing ? WriteFile(pipe, buffer, bytes, used, &operation) : ReadFile(pipe, buffer, bytes, used, &operation);
    if (!ok && GetLastError() == ERROR_IO_PENDING) {
        if (*closing) CancelIoEx(pipe, &operation);
        ok = GetOverlappedResult(pipe, &operation, used, TRUE);
        if (!ok && GetLastError() != ERROR_OPERATION_ABORTED && GetLastError() != ERROR_BROKEN_PIPE && GetLastError() != ERROR_PIPE_NOT_CONNECTED) ExitProcess(3);
    }
    CloseHandle(operation.hEvent); return ok;
}
static BOOL pipe_write(PTConnection *c, BYTE *buffer, DWORD bytes) {
    DWORD at = 0, used;
    while (at < bytes) {
        if (!pipe_transfer(c->pipe, buffer + at, bytes - at, &used, TRUE, &c->closing) || !used) return FALSE;
        at += used;
    }
    return TRUE;
}
static BOOL connect_listener(HANDLE pipe) {
    OVERLAPPED operation; DWORD used; BOOL ok;
    ZeroMemory(&operation, sizeof(operation)); operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!operation.hEvent) return FALSE;
    ok = ConnectNamedPipe(pipe, &operation);
    if (!ok) {
        DWORD error = GetLastError();
        if (error == ERROR_PIPE_CONNECTED) ok = TRUE;
        else if (error == ERROR_IO_PENDING) ok = GetOverlappedResult(pipe, &operation, &used, TRUE);
    }
    CloseHandle(operation.hEvent); return ok;
}
static void frame(BYTE type, DWORD id, const void *payload, DWORD bytes) {
    BYTE header[9]; BOOL ok;
    if (bytes > PT_BLOCK) ExitProcess(3);
    header[0] = type; memcpy(header + 1, &id, 4); memcpy(header + 5, &bytes, 4);
    EnterCriticalSection(&outputLock);
    ok = exact_write(outputHandle, header, sizeof(header)) && (!bytes || exact_write(outputHandle, payload, bytes));
    LeaveCriticalSection(&outputLock);
    if (!ok) ExitProcess(3);
}
static BOOL digest(const BYTE *bytes, DWORD length, BYTE out[32]) {
    BCRYPT_ALG_HANDLE algorithm = NULL; BOOL ok = FALSE;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) >= 0) {
        ok = BCryptHash(algorithm, NULL, 0, (PUCHAR)bytes, length, out, 32) >= 0;
        BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    return ok;
}
/* Identical bundled helper bytes are accepted across the installed/portable
 * cache copies. Pin the image file handle while hashing and reject reparse,
 * changed or oversized images. This check happens before reporting connect. */
static BOOL image_hash(const WCHAR *name, BYTE output[32]) {
    HANDLE file; WCHAR absolute[PF_ROOT_LIMIT + 5]; PFFileStamp before, after; BYTE *bytes = NULL; DWORD length = 0; BOOL ok = FALSE;
    if (!name || wcsnlen_s(name, PF_ROOT_LIMIT + 1) > PF_ROOT_LIMIT || name[1] != L':' || name[2] != L'\\' ||
        swprintf_s(absolute, sizeof(absolute) / sizeof(absolute[0]), L"\\\\?\\%s", name) <= 0) return FALSE;
    file = CreateFileW(absolute, FILE_READ_DATA | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    if (file_details(file, &before) != PF_FILE_OK || !before.bytes || before.bytes > 8 * 1024 * 1024) goto done;
    length = (DWORD)before.bytes; bytes = (BYTE *)malloc(length);
    if (!bytes || !exact_read(file, bytes, length) || file_details(file, &after) != PF_FILE_OK ||
        !same_identity(&before.identity, &after.identity) || before.bytes != after.bytes ||
        before.lastWriteTime != after.lastWriteTime || before.changeTime != after.changeTime) goto done;
    ok = digest(bytes, length, output);
done:
    free(bytes); CloseHandle(file); return ok;
}
static BOOL root_current(void) {
    return pf_directory_inspect(&rootLease, &rootIdentity, NULL) == PF_OK;
}
static BOOL peer_current(HANDLE process) {
    DWORD pid = 0, session = 0, ownSession = 0; FILETIME creation; LUID logon;
    return pfo_process(process, &pid, &creation, &session, &logon) &&
        ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) && session == ownSession;
}
static HANDLE verified_peer(HANDLE pipe, BOOL server) {
    DWORD pid = 0, confirmed = 0, length = PF_ROOT_LIMIT; HANDLE process = NULL;
    WCHAR image[PF_ROOT_LIMIT + 1]; BYTE hash[32]; PSECURITY_DESCRIPTOR security = NULL;
    BOOL ok = FALSE;
    if (!(server ? GetNamedPipeClientProcessId(pipe, &pid) : GetNamedPipeServerProcessId(pipe, &pid)) || !pid) goto done;
    process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process || !peer_current(process) || !QueryFullProcessImageNameW(process, 0, image, &length) ||
        !image_hash(image, hash) || memcmp(hash, selfHash, 32) ||
        inspect_private_security(pipe, FILE_ALL_ACCESS, &security) != PF_OK || !root_current() ||
        !(server ? GetNamedPipeClientProcessId(pipe, &confirmed) : GetNamedPipeServerProcessId(pipe, &confirmed)) ||
        pid != confirmed || !peer_current(process)) goto done;
    ok = TRUE;
done:
    if (security) LocalFree(security);
    if (!ok && process) { CloseHandle(process); process = NULL; }
    return process;
}
static HANDLE new_listener(BOOL first) {
    PFToken token; SECURITY_DESCRIPTOR sd; SECURITY_ATTRIBUTES sa; PACL acl = NULL;
    HANDLE pipe = INVALID_HANDLE_VALUE; PSECURITY_DESCRIPTOR checked = NULL;
    ZeroMemory(&token, sizeof(token)); ZeroMemory(&sa, sizeof(sa));
    if (!root_current() || !pfo_security(&token, &sd, &acl)) goto done;
    sa.nLength = sizeof(sa); sa.lpSecurityDescriptor = &sd;
    pipe = CreateNamedPipeW(pipeName, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PT_CONNECTIONS + 1, PT_BLOCK, PT_BLOCK, 0, &sa);
    if (pipe != INVALID_HANDLE_VALUE && (inspect_private_security(pipe, FILE_ALL_ACCESS, &checked) != PF_OK || !root_current())) {
        CloseHandle(pipe); pipe = INVALID_HANDLE_VALUE;
    }
done:
    if (checked) LocalFree(checked);
    if (acl) HeapFree(GetProcessHeap(), 0, acl);
    token_close(&token); return pipe;
}
static HANDLE connect_client(void) {
    ULONGLONG deadline = GetTickCount64() + 4000;
    for (;;) {
        HANDLE pipe = CreateFileW(pipeName, FILE_READ_DATA | FILE_WRITE_DATA | READ_CONTROL | SYNCHRONIZE, 0, NULL, OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
        ULONGLONG now;
        if (pipe != INVALID_HANDLE_VALUE) return pipe;
        if (GetLastError() != ERROR_PIPE_BUSY) return INVALID_HANDLE_VALUE;
        now = GetTickCount64();
        if (now >= deadline || !WaitNamedPipeW(pipeName, (DWORD)(deadline - now))) return INVALID_HANDLE_VALUE;
    }
}
static void close_connection(PTConnection *c) {
    if (InterlockedCompareExchange(&c->closing, 1, 0)) return;
    CancelIoEx(c->pipe, NULL);
    if (serverMode) DisconnectNamedPipe(c->pipe);
    SetEvent(c->writeEvent); SetEvent(c->readEvent);
    frame(PT_CLOSE, c->id, NULL, 0);
}
static DWORD WINAPI reader_thread(LPVOID context) {
    PTConnection *c = (PTConnection *)context; BYTE bytes[PT_BLOCK]; DWORD received;
    while (!c->closing) {
        if (!root_current() || !peer_current(c->peer) || !pipe_transfer(c->pipe, bytes, sizeof(bytes), &received, FALSE, &c->closing) || !received) break;
        if (c->closing || !root_current() || !peer_current(c->peer)) break;
        frame(PT_DATA, c->id, bytes, received);
        if (WaitForSingleObject(c->readEvent, INFINITE) != WAIT_OBJECT_0) break;
    }
    close_connection(c); return 0;
}
/* Only this isolated thread performs synchronous pipe flushing. Never cancel a
 * stream worker: it may be emitting a partial shared stdout frame. */
static DWORD WINAPI flush_thread(LPVOID context) {
    FlushFileBuffers((HANDLE)context); return 0;
}
static void flush_connection(PTConnection *c) {
    HANDLE thread = CreateThread(NULL, 0, flush_thread, c->pipe, 0, NULL);
    DWORD waited;
    if (!thread) return;
    for (;;) {
        waited = WaitForSingleObject(thread, 50);
        if (waited == WAIT_OBJECT_0) break;
        if (waited != WAIT_TIMEOUT) ExitProcess(3);
        if (c->closing) CancelSynchronousIo(thread);
    }
    CloseHandle(thread);
}
static DWORD WINAPI writer_thread(LPVOID context) {
    PTConnection *c = (PTConnection *)context;
    while (!c->closing) {
        if (WaitForSingleObject(c->writeEvent, INFINITE) != WAIT_OBJECT_0 || c->closing) break;
        if (c->ending) { flush_connection(c); break; }
        if (!root_current() || !peer_current(c->peer) || !pipe_write(c, c->output, c->writeBytes)) break;
        InterlockedExchange(&c->writing, 0); frame(PT_WRITTEN, c->id, NULL, 0);
    }
    close_connection(c); return 0;
}
/* Caller holds connectionsLock. Reap every finished slot before allocating a
 * listener so closed pipe handles cannot consume the OS instance limit. */
static PTConnection *available_connection(void) {
    DWORD i; PTConnection *c = NULL;
    for (i = 0; i < PT_CONNECTIONS; i++) {
        PTConnection *slot = &connections[i];
        if (slot->id && slot->closing && slot->reader && slot->writer &&
            WaitForSingleObject(slot->reader, 0) == WAIT_OBJECT_0 && WaitForSingleObject(slot->writer, 0) == WAIT_OBJECT_0) {
            CloseHandle(slot->reader); CloseHandle(slot->writer); CloseHandle(slot->writeEvent); CloseHandle(slot->readEvent);
            CloseHandle(slot->pipe); CloseHandle(slot->peer); ZeroMemory(slot, sizeof(*slot));
        }
        if (!slot->id && !c) c = slot;
    }
    return c;
}
static PTConnection *add_connection(HANDLE pipe, HANDLE peer) {
    PTConnection *c;
    EnterCriticalSection(&connectionsLock);
    c = available_connection();
    if (c) {
        if (!nextId) ExitProcess(3);
        c->id = nextId++; c->pipe = pipe; c->peer = peer;
        c->writeEvent = CreateEventW(NULL, FALSE, FALSE, NULL); c->readEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
        if (!c->writeEvent || !c->readEvent) ExitProcess(3);
        c->reader = CreateThread(NULL, 0, reader_thread, c, CREATE_SUSPENDED, NULL);
        c->writer = CreateThread(NULL, 0, writer_thread, c, CREATE_SUSPENDED, NULL);
        if (!c->reader || !c->writer) ExitProcess(3);
        frame(PT_OPEN, c->id, NULL, 0);
        ResumeThread(c->reader); ResumeThread(c->writer);
    }
    LeaveCriticalSection(&connectionsLock); return c;
}
static DWORD WINAPI accept_thread(LPVOID context) {
    HANDLE listener = (HANDLE)context;
    for (;;) {
        HANDLE peer, next; BOOL capacity;
        if (!connect_listener(listener)) ExitProcess(3);
        peer = verified_peer(listener, TRUE);
        if (!peer) { DisconnectNamedPipe(listener); continue; }
        EnterCriticalSection(&connectionsLock);
        capacity = available_connection() != NULL;
        LeaveCriticalSection(&connectionsLock);
        /* At capacity, disconnect and reuse the existing listener. Opening a
         * 34th instance would exceed the 32 peers + 1 listener OS limit. */
        if (!capacity) { CloseHandle(peer); DisconnectNamedPipe(listener); continue; }
        /* Keep the next instance open before handing this one to workers.
         * There is never a moment with no owned pipe instance in the namespace. */
        next = new_listener(FALSE);
        if (next == INVALID_HANDLE_VALUE) ExitProcess(3);
        if (!add_connection(listener, peer)) { DisconnectNamedPipe(listener); CloseHandle(listener); CloseHandle(peer); }
        listener = next;
    }
}
static BOOL endpoint(WCHAR *socketPath) {
    WCHAR *slash = wcsrchr(socketPath, L'\\'); BYTE bytes[sizeof(PFDirectoryIdentity) + 32], hash[32];
    DWORD i, role = 0; size_t prefix; static const WCHAR hex[] = L"0123456789abcdef";
    if (!slash) return FALSE;
    if (!wcscmp(slash + 1, L"tasks.sock")) role = 1;
    else if (!wcscmp(slash + 1, L"runner.sock")) role = 2;
    else if (!wcscmp(slash + 1, L"ipc.sock")) role = 3;
    if (!role) return FALSE;
    *slash = 0;
    if (pf_directory_open_read_root(socketPath, NULL, &rootLease) != PF_OK ||
        pf_directory_inspect(&rootLease, NULL, &rootIdentity) != PF_OK) return FALSE;
    ZeroMemory(bytes, sizeof(bytes)); memcpy(bytes, &rootIdentity.volume, 8); memcpy(bytes + 8, rootIdentity.file, 16); memcpy(bytes + 24, &role, 4);
    if (!digest(bytes, sizeof(bytes), hash)) return FALSE;
    wcscpy_s(pipeName, sizeof(pipeName) / sizeof(pipeName[0]), L"\\\\.\\pipe\\Plexiform-local-v1-");
    prefix = wcslen(pipeName);
    for (i = 0; i < 32; i++) { size_t at = prefix + 2 * i; pipeName[at] = hex[hash[i] >> 4]; pipeName[at + 1] = hex[hash[i] & 15]; }
    pipeName[prefix + 64] = 0; return TRUE;
}
static int token_operation(BOOL create) {
    BYTE bytes[PF_TOKEN_BYTES], random[32]; DWORD length = 0, at = 4, i; PFFileStamp stamp; PFFileResult result;
    PFOAuthority *authority = NULL; PFOPublication publication;
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    result = pf_file_read(&rootLease, L"tasks.token", PF_FILE_TASKS_TOKEN, NULL, bytes, sizeof(bytes), &length, &stamp);
    if (result != PF_FILE_OK && create) {
        if (result != PF_FILE_OPEN_FAILED || BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return 2;
        memcpy(bytes, "btk_", 4);
        for (i = 0; i < 32; i += 3) {
            DWORD value = ((DWORD)random[i]) << 16;
            if (i + 1 < 32) value |= ((DWORD)random[i + 1]) << 8;
            if (i + 2 < 32) value |= random[i + 2];
            bytes[at++] = (BYTE)alphabet[(value >> 18) & 63]; bytes[at++] = (BYTE)alphabet[(value >> 12) & 63];
            if (i + 1 < 32) bytes[at++] = (BYTE)alphabet[(value >> 6) & 63];
            if (i + 2 < 32) bytes[at++] = (BYTE)alphabet[value & 63];
        }
        bytes[at++] = '\n'; length = at;
        if (pfo_private_open(&rootLease, &rootIdentity, GetTickCount64() + 4000, &authority) != PFO_OK) return 2;
        publication = pfo_publish(authority, PF_FILE_TASKS_TOKEN, bytes, length); pfo_close(authority);
        if (publication.result != PFO_OK || publication.effect != PFO_PUBLISHED) return 2;
    } else if (result != PF_FILE_OK) return 2;
    if (length != 48 || memcmp(bytes, "btk_", 4) || bytes[47] != '\n') return 2;
    for (i = 4; i < 47; i++) if (!bytes[i] || !strchr(alphabet, bytes[i])) return 2;
    if (!exact_write(outputHandle, bytes, length)) return 3;
    SecureZeroMemory(bytes, sizeof(bytes)); SecureZeroMemory(random, sizeof(random)); return 0;
}
int main(int argc, char **argv) {
    BYTE mode, header[9], payload[PT_BLOCK]; DWORD bytes = 0, id, i; WCHAR socketPath[PF_ROOT_LIMIT + 1], image[PF_ROOT_LIMIT + 1];
    HANDLE listener, peer; (void)argv;
    if (argc != 1) return 2;
    InitializeCriticalSection(&outputLock); InitializeCriticalSection(&connectionsLock);
    inputHandle = GetStdHandle(STD_INPUT_HANDLE); outputHandle = GetStdHandle(STD_OUTPUT_HANDLE);
    if (GetFileType(inputHandle) != FILE_TYPE_PIPE || GetFileType(outputHandle) != FILE_TYPE_PIPE ||
        !exact_read(inputHandle, &mode, 1) || !exact_read(inputHandle, &bytes, 4) || !bytes || bytes > PF_ROOT_LIMIT * 2 || bytes % 2) return 2;
    ZeroMemory(socketPath, sizeof(socketPath));
    if (!exact_read(inputHandle, socketPath, bytes) || wcslen(socketPath) != bytes / 2 || !endpoint(socketPath)) return 2;
    if (mode == 'T' || mode == 'R') return token_operation(mode == 'T');
    if (mode != 'S' && mode != 'C') return 2;
    ZeroMemory(image, sizeof(image));
    bytes = GetModuleFileNameW(NULL, image, PF_ROOT_LIMIT);
    if (!bytes || bytes >= PF_ROOT_LIMIT || !image_hash(image, selfHash)) return 2;
    serverMode = mode == 'S';
    if (serverMode) {
        listener = new_listener(TRUE); if (listener == INVALID_HANDLE_VALUE) return 2;
        frame(PT_READY, 0, NULL, 0);
        if (!CreateThread(NULL, 0, accept_thread, listener, 0, NULL)) return 3;
    } else {
        listener = connect_client();
        if (listener == INVALID_HANDLE_VALUE) return 2;
        peer = verified_peer(listener, FALSE);
        if (!peer || !add_connection(listener, peer)) return 2;
    }
    while (exact_read(inputHandle, header, sizeof(header))) {
        PTConnection *c = NULL; memcpy(&id, header + 1, 4); memcpy(&bytes, header + 5, 4);
        if (bytes > PT_BLOCK || (header[0] != PT_DATA && bytes) ||
            (header[0] != PT_DATA && header[0] != PT_CLOSE && header[0] != PT_READ && header[0] != PT_END) ||
            (bytes && !exact_read(inputHandle, payload, bytes))) return 2;
        EnterCriticalSection(&connectionsLock);
        for (i = 0; i < PT_CONNECTIONS; i++) if (connections[i].id == id && !connections[i].closing) { c = &connections[i]; break; }
        if (c) {
            if (header[0] == PT_CLOSE) close_connection(c);
            else if (header[0] == PT_READ) SetEvent(c->readEvent);
            else if (header[0] == PT_END) { InterlockedExchange(&c->ending, 1); SetEvent(c->writeEvent); }
            else if (!bytes || InterlockedCompareExchange(&c->writing, 1, 0)) { LeaveCriticalSection(&connectionsLock); return 2; }
            else { memcpy(c->output, payload, bytes); c->writeBytes = bytes; SetEvent(c->writeEvent); }
        }
        LeaveCriticalSection(&connectionsLock);
    }
    /* Parent pipe EOF is the lifetime boundary. OS process exit cancels all
     * worker syscalls and closes every pipe, lease and peer process handle. */
    ExitProcess(0); return 0;
}
