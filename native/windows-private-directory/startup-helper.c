/* One-shot main/runner startup boundary. Paths arrive only through the
 * private inherited stdin pipe, never a renderer endpoint or command line.
 * The parent enforces a five-second process deadline. This validates startup;
 * file operations and control transports must retain their own SDK leases. */
#include "directory.h"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

static PFDirectoryResult ensure_directory(WCHAR *path, PFDirectory *lease,
    PFDirectoryIdentity *identity) {
    WCHAR ancestor[PF_ROOT_LIMIT + 1], lookup[PF_ROOT_LIMIT + 5];
    size_t length = wcslen(path), split = length, at;
    DWORD attributes, error;
    PFDirectoryResult result;
    if (length < 4 || length > PF_ROOT_LIMIT || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) || path[1] != L':' || path[2] != L'\\') return PF_UNSUPPORTED_ROOT;
    memcpy(ancestor, path, (length + 1) * sizeof(WCHAR));
    /* Locate an existing ancestor only. A denied/unsupported namespace is
     * never treated as absent and existing ACLs are never repaired. */
    for (;;) {
        if (swprintf_s(lookup, sizeof(lookup) / sizeof(lookup[0]), L"\\\\?\\%s", ancestor) <= 0) return PF_UNSUPPORTED_ROOT;
        attributes = GetFileAttributesW(lookup);
        if (attributes != INVALID_FILE_ATTRIBUTES) break;
        error = GetLastError();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return PF_OPEN_FAILED;
        while (split > 3 && ancestor[split - 1] != L'\\') split--;
        if (split <= 3) return PF_UNSUPPORTED_ROOT;
        ancestor[--split] = L'\0';
    }
    result = pf_directory_open_read_root(ancestor, NULL, lease);
    if (result != PF_OK) return result;
    for (at = split; at < length;) {
        WCHAR component[PF_COMPONENT_LIMIT + 1];
        size_t end, count;
        if (path[at] != L'\\') return PF_BAD_COMPONENT;
        at++; end = at;
        while (end < length && path[end] != L'\\') end++;
        count = end - at;
        if (!count || count > PF_COMPONENT_LIMIT) return PF_BAD_COMPONENT;
        memcpy(component, path + at, count * sizeof(WCHAR)); component[count] = 0;
        result = pf_directory_create_child(lease, component, identity);
        if (result != PF_OK) return result;
        at = end;
    }
    return pf_directory_inspect(lease, NULL, identity);
}

int main(int argc, char **argv) {
    uint32_t bytes = 0;
    WCHAR path[PF_ROOT_LIMIT + 1];
    PFDirectory lease;
    PFDirectoryIdentity identity;
    PFDirectoryResult result = PF_UNSUPPORTED_ROOT;
    unsigned i;
    (void)argv;
    ZeroMemory(&lease, sizeof(lease)); ZeroMemory(&identity, sizeof(identity));
    ZeroMemory(path, sizeof(path));
    if (argc != 1 || _setmode(_fileno(stdin), _O_BINARY) == -1 ||
        fread(&bytes, sizeof(bytes), 1, stdin) != 1 || !bytes ||
        bytes > PF_ROOT_LIMIT * sizeof(WCHAR) || bytes % sizeof(WCHAR) ||
        fread(path, 1, bytes, stdin) != bytes || fgetc(stdin) != EOF ||
        wcslen(path) != bytes / sizeof(WCHAR)) goto done;
    result = ensure_directory(path, &lease, &identity);
done:
    if (result == PF_OK) {
        printf("{\"ok\":true,\"volume\":\"%016llx\",\"fileId\":\"", identity.volume);
        for (i = 0; i < sizeof(identity.file); i++) printf("%02x", identity.file[i]);
        printf("\"}\n");
    } else printf("{\"ok\":false,\"reason\":\"%s\"}\n", pf_directory_reason(result));
    pf_directory_close(&lease);
    SecureZeroMemory(path, sizeof(path));
    return result == PF_OK ? 0 : 1;
}
