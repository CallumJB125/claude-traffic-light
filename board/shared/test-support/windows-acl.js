// Synthetic test files only. The original descriptor is restored by the caller.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
export function widenFixtureAcl(file, access = 'Read') {
  if (!['Read', 'Write'].includes(access)) throw new Error('Unsupported fixture ACL access');
  if (process.platform !== 'win32') throw new Error('Windows fixture required');
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const options = { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16384, env: { ...process.env, PLEXIFORM_ACL_FIXTURE: file, PLEXIFORM_ACL_ACCESS: access } };
  const original = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$pfAcl = Get-Acl -LiteralPath $env:PLEXIFORM_ACL_FIXTURE
$pfOriginal = $pfAcl.Sddl
$pfEveryone = [System.Security.Principal.SecurityIdentifier]'S-1-1-0'
$pfRule = New-Object System.Security.AccessControl.FileSystemAccessRule($pfEveryone,$env:PLEXIFORM_ACL_ACCESS,'Allow')
$pfAcl.AddAccessRule($pfRule)
Set-Acl -LiteralPath $env:PLEXIFORM_ACL_FIXTURE -AclObject $pfAcl
[Console]::Out.Write($pfOriginal)
`], options).trim();
  if (!original) throw new Error('Missing original fixture ACL');
  return () => execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$pfAcl = Get-Acl -LiteralPath $env:PLEXIFORM_ACL_FIXTURE
$pfAcl.SetSecurityDescriptorSddlForm([Console]::In.ReadToEnd())
Set-Acl -LiteralPath $env:PLEXIFORM_ACL_FIXTURE -AclObject $pfAcl
`], { ...options, input: original });
}

// Always creates its own empty directory. Never repairs an existing user path.
export function privateFixtureDirectory(prefix) {
  const directory = fs.mkdtempSync(prefix);
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$pfDirectory = [Console]::In.ReadToEnd()
$pfMe = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$pfAcl = New-Object System.Security.AccessControl.DirectorySecurity
$pfAcl.SetOwner($pfMe); $pfAcl.SetAccessRuleProtection($true,$false)
foreach ($pfSid in @($pfMe, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $pfAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($pfSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $pfDirectory -AclObject $pfAcl
`], { input: directory, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true });
  }
  return fs.realpathSync(directory);
}
