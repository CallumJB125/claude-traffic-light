'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Private = require('../board/shared/windows-private-directory.cjs');

// Disposable real filesystem fixtures. Native absence is a failure on Windows;
// host-independent protocol tests live in windows-private-directory-client.
test('Windows startup helper creates private descendants, binds identity and refuses broad ACLs/reparse ancestry', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-private-native-'));
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  function acl(operation, file) {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($request.operation -eq 'protect') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($me, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $request.path -AclObject $acl
} elseif ($request.operation -eq 'broaden') {
  $acl = Get-Acl -LiteralPath $request.path
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.SecurityIdentifier]'S-1-1-0', 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $request.path -AclObject $acl
} elseif ($request.operation -ne 'inspect') { throw 'Unknown fixture operation' }
$acl = Get-Acl -LiteralPath $request.path
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
@{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current = $me.Value; protected = $acl.AreAccessRulesProtected; grants = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress
`;
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify({ operation, path: file }), encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true, shell: false });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  try {
    acl('protect', root);
    const target = path.join(root, 'one', 'two');
    const first = Private.ensureDirectory(target);
    assert.deepEqual(Private.ensureDirectory(target), first, 'reopening the same directory preserves native identity');
    const security = acl('inspect', target);
    assert.equal(security.owner, security.current);
    assert.equal(security.protected, true);
    assert.ok(security.grants.length >= 1);
    assert.ok(security.grants.every(sid => [security.current, 'S-1-5-18', 'S-1-5-32-544'].includes(sid)));
    const longTarget = path.join(root, 'a'.repeat(110), 'b'.repeat(110), 'c'.repeat(80));
    assert.ok(longTarget.length > 260);
    assert.deepEqual(Private.ensureDirectory(longTarget), Private.ensureDirectory(longTarget), 'long paths reopen with the same identity');
    const other = path.join(root, 'other');
    assert.notDeepEqual(Private.ensureDirectory(other), first, 'different directories have different native identities');
    const link = path.join(root, 'junction');
    fs.symlinkSync(other, link, 'junction');
    assert.throws(() => Private.ensureDirectory(path.join(link, 'new-child')), /could not be verified/);
    assert.equal(fs.existsSync(path.join(other, 'new-child')), false);
    acl('broaden', target);
    assert.throws(() => Private.ensureDirectory(target), /could not be verified/);
    assert.ok(acl('inspect', target).grants.includes('S-1-1-0'), 'refusal does not silently repair existing ACLs');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
