/* Build-only fake CLI for detection contract tests. Never packaged. */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
int wmain(int argc, wchar_t **argv) {
    WCHAR executable[32768], config[32768]; FILE *file = NULL;
    char version[64]; int loginExit = 1, hang = 0; DWORD length;
    length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length >= 32768 || swprintf_s(config, 32768, L"%s.fixture", executable) <= 0) return 3;
    if (_wfopen_s(&file, config, L"r") || !file) return 3;
    if (fscanf_s(file, "%63s %d %d", version, (unsigned)sizeof(version), &loginExit, &hang) != 3) { fclose(file); return 3; }
    fclose(file);
    if (hang) Sleep(30000);
    if (argc == 2 && !wcscmp(argv[1], L"--version")) { printf("fixture %s\n", version); return 0; }
    if (argc == 3 && !wcscmp(argv[1], L"login") && !wcscmp(argv[2], L"status")) return loginExit;
    return 3;
}
