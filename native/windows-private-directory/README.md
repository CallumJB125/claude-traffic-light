# Windows private directory SDK module

This directory contains a source module and real Windows acceptance fixture,
awaiting independent source review and MSVC/Windows runtime acceptance. It is
not yet built, packaged, signed, connected to a pipe, or enabled in the runner
or Setups store. Their current Windows privacy refusals remain in place.

`directory.c` derives the current process token SID internally. Inspection
requires a local fixed NTFS volume, a real directory with no reparse point,
one link, no pending deletion, matching expected volume/file identity when
provided, owner equal to that SID, a nonnull readable DACL, only supported
allow/deny ACEs, and full effective current-user access. Every allow grant,
including inherit-only grants for contents, must name current user,
LOCAL_SYSTEM, or BUILTIN_ADMINISTRATORS. Existing secure inherited ACLs are
accepted unchanged. Unsupported object/conditional grants and public/other
principals fail closed.

The root is opened one component at a time through `NtCreateFile`
`RootDirectory` handles. Reparse points are opened for inspection and refused
before traversal. Every ancestor handle stays live in `PFDirectory` with
restrictive share access that excludes write/delete sharing. Closing a context
ends that lease; a later operation must compare the captured identity again.
An anchored lease prevents namespace substitution during the operation; it
does not make a lexical path immutable after handles close.

Exclusive child creation first verifies its opened parent is private. It uses
`FILE_CREATE`, supplies current-user owner and a protected three-principal
full-control inheritable DACL at creation, and verifies the opened result.
Existing names refuse rather than being adopted. No existing ACL setter,
ownership takeover, ordinary path mkdir fallback, deletion, rename, file read,
or user-target writer exists in this module. An uncertain post-create result
retains the new handle for a caller-owned receipt; it never cleans up an
unexpected namespace automatically.

The SDK API accepts pointers only from its trusted native caller. It is not a
renderer or external path endpoint. The shared helper's later main-only
dispatcher must capture a closed canonical app-data/userData root capability,
own its handles and root identity, and accept only a fixed recipe plus bounded
relative components. Reserve operation IDs `0x10` for
`inspectPrivateDirectory` and `0x11` for `createPrivateDirectory`; the Setups
reader/writer use different operation IDs and separate gates. The private
framed pipe must reject unknown fields, embedded NULs, oversize frames,
unknown roots/recipes, token or SID/ACL input, and expired sessions. No paths,
credentials, ACLs, flags or commands belong in helper argv/environment or
renderer responses. Root/recipe dispatch and a parent-owned process deadline
are prerequisites before enabling these operations. This first module does
not claim those transport prerequisites are implemented.

`acceptance.c` creates only fresh synthetic directories beneath the Windows
test account's temporary folder. It queries security independently with
`GetNamedSecurityInfoW` and tests exact new owner/DACL, unchanged secure and
inherited ACLs, Everyone read grant, null DACL, other owner, unsupported object
ACE, unreadable read-control denial, real junctions at final/intermediate
components, regular-file/device refusal, collision preservation, component
refusal, held-handle rename exclusion and stale identity after replacement.
An unavailable fixture fails the run; it is never skipped or replaced by
POSIX mode assertions. Own cleanup removes only these synthetic fixtures.

From the repository root in an existing x64 MSVC developer environment, after
the source gate (keep all build artifacts in ignored `work`):

```bat
mkdir work\windows-private-directory
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-directory\ /Fe:work\windows-private-directory\acceptance.exe native\windows-private-directory\directory.c native\windows-private-directory\acceptance.c /link advapi32.lib ntdll.lib rpcrt4.lib
work\windows-private-directory\acceptance.exe
```

The ROOT-owned Windows CI gate must bound execution externally, retain compile
and TAP output on failure, and require these actual native fixtures to pass.
No Darwin test run certifies this module. Subsequent main/pipe/package wiring
also needs missing-helper/deadline/provenance tests and real utilityProcess
runner start/stop, DPAPI enrollment restart and revoked-access removal before
Windows runner support is reported.

Primary SDK contracts: [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck),
[GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).
