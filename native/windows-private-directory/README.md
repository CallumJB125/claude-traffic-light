# Windows private directory and fixed-role file SDK module

The original directory module has separately recorded actual Windows
acceptance (69 assertions). The new fixed-role file reader and its Windows
fixtures are source only, awaiting independent review and MSVC/Windows
acceptance. Neither API is packaged, signed, connected to a pipe, or enabled
in the runner or Setups store. Their current Windows privacy refusals remain
in place.

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
ownership takeover, ordinary path mkdir fallback, deletion, rename, file
publication or user-target writer exists in this module. An uncertain
post-create result retains the new handle for a caller-owned receipt; it never cleans up an
unexpected namespace automatically.

`file.h` adds an internal regular-file reader beneath an already private
`PFDirectory` lease. The only roles are a connector grant (8192 bytes) and a
Tasks token (256 bytes); no arbitrary ceiling or private-target adoption is
accepted. One strict component is opened by `NtCreateFile` with `FILE_OPEN`,
`FILE_NON_DIRECTORY_FILE`, `FILE_OPEN_REPARSE_POINT`, fixed data/attribute/
read-control/synchronize rights and `FILE_SHARE_READ` only. Before reading,
the opened disk/NTFS file must be a regular non-reparse, non-device file, have
one link and no pending deletion, fit both its role and output limits, and
match an optional captured volume/file/size/basic-change stamp. Its exact
owner/DACL policy is shared with directory inspection; the directory still
requires full effective control, while this reader requires only its fixed
read rights. Existing private inherited and read-only files remain unchanged.

The file stays open through fixed chunks, opened metadata/security comparisons,
reinspection of the private parent and fresh exact named-binding comparisons.
Private bytes stay in a bounded temporary buffer until all checks pass.
Refusal clears bounded caller output, length and stamp. An EOF probe is used
only below the role cap and consumes at most one byte inside that cap. At the
inclusive 8192/256-byte boundary, exact pre/post length checks and the retained
share lease replace that probe; no cap-plus-one read is requested. Last-access
time is excluded from the stamp because reading can change it; creation,
last-write, change time, attributes and exact security descriptor must agree.
No file creation, content write, ACL modification, rename or deletion occurs
in the reader. Root and role dispatch, secure file publication and token/grant
format validation are separate required application boundaries.

Restrictive sharing excludes new conflicting write, append and delete opens;
these comparisons are not atomic ACL/content CAS against a privileged or
current-user process, including an existing writable mapping. They cannot
prove the absence of a change restored between observations. Synchronous
filesystem calls also have no universal syscall deadline. Production requires
a separately gated helper process with a main-owned total deadline, termination,
reaping and stale-generation refusal before any file adapter is enabled.

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

`file-acceptance.c` adds actual private/inherited/read-only and inclusive-cap
files; Everyone/group/null/foreign-owner/unsupported-ACE/read-control denial;
symlink, intermediate junction, directory, hard-link, ADS/device/traversal
components; expected-identity replacement, growth, share exclusion, late
file/parent ACL and basic-attribute changes, capacity, closed parent leases
and handle cleanup. Security and content
preservation use independent kernel queries. It interposes two SDK calls in
its own translation unit to place actual filesystem/ACL mutations at defined
boundaries; normal calls still reach the real Windows kernel. Three separately
labelled injected zero-progress, read-error and final-name-open failures check
refusal/output handling. Those injected failures are not OS failure receipts.
It includes `directory.c` for that fixture only; the production translation
unit has no callback, test switch or special mutation path. The original
`directory.h` API and `acceptance.c` fixture remain byte-identical.

From the repository root in an existing x64 MSVC developer environment, after
the source gate (keep all build artifacts in ignored `work`):

```bat
mkdir work\windows-private-directory
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-directory\ /Fe:work\windows-private-directory\acceptance.exe native\windows-private-directory\directory.c native\windows-private-directory\acceptance.c /link advapi32.lib ntdll.lib rpcrt4.lib
work\windows-private-directory\acceptance.exe
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-directory\ /Fe:work\windows-private-directory\file-acceptance.exe native\windows-private-directory\file-acceptance.c /link advapi32.lib ntdll.lib rpcrt4.lib
work\windows-private-directory\file-acceptance.exe
```

The ROOT-owned Windows CI gate must bound execution externally, retain compile
and TAP output on failure, and require these actual native fixtures to pass.
No Darwin test run certifies this Windows reader. Subsequent main/pipe/package
wiring also needs missing-helper/deadline/provenance tests and real utilityProcess
runner start/stop, DPAPI enrollment restart and revoked-access removal before
Windows runner support is reported.

Primary SDK contracts: [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck),
[GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).
