$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The Windows SDK helper must be built on Windows.' }
$pfRoot = Split-Path -Parent $PSScriptRoot
$pfVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $pfVsWhere -PathType Leaf)) { throw 'Existing Visual Studio discovery tool unavailable.' }
$pfVsRoots = @(& $pfVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($LASTEXITCODE -ne 0 -or $pfVsRoots.Count -ne 1) { throw 'One installed x64 MSVC toolchain is required.' }
$pfVsDev = Join-Path $pfVsRoots[0] 'Common7\Tools\VsDevCmd.bat'
if (!(Test-Path -LiteralPath $pfVsDev -PathType Leaf)) { throw 'MSVC environment unavailable.' }
Push-Location -LiteralPath $pfRoot
try {
    New-Item -ItemType Directory -Path native/bin,work/windows-private-build,work/windows-test-fixtures -Force | Out-Null
    $env:PF_DIRECTORY_VS_DEV = $pfVsDev
    @'
@echo off
call "%PF_DIRECTORY_VS_DEV%" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-build\ /Fe:native\bin\windows-private-directory.exe native\windows-private-directory\directory.c native\windows-private-directory\startup-helper.c /link advapi32.lib ntdll.lib
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-build\ /Fe:native\bin\windows-local-transport.exe native\windows-private-directory\local-transport.c /link advapi32.lib ntdll.lib bcrypt.lib
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo:work\windows-private-build\ /Fe:native\bin\windows-process-job.exe native\windows-process-job\job-helper.c /link advapi32.lib
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /std:c11 /TC /W4 /WX /DUNICODE /D_UNICODE /Fo:work\windows-private-build\ /Fe:work\windows-test-fixtures\cli-probe.exe native\windows-test-fixtures\cli-probe.c
exit /b %errorlevel%
'@ | Set-Content -LiteralPath work/windows-private-build/compile.cmd -Encoding ascii
    & .\work\windows-private-build\compile.cmd
    if ($LASTEXITCODE -ne 0) { throw 'Windows private-directory helper compilation failed.' }
} finally { Remove-Item Env:PF_DIRECTORY_VS_DEV; Pop-Location }
