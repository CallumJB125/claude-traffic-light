'use strict';
// Read-only metadata for the single installer child in a disposable CI fixture.
// No command lines, window titles/text, buttons, handles, or unrelated paths.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { windowsPath } = require('./windows-install-diagnostics');
const MAX_OUTPUT = 32768, TIMEOUT_MS = 5000, MAX_PROCESSES = 64, MAX_WINDOWS = 64;
const QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rootPid = [long]$env:PLEXIFORM_OBSERVER_PID
$all = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, ExecutablePath FROM Win32_Process' | Select-Object -First 4097)
$truncated = $all.Count -gt 4096
$root = @($all | Where-Object { $_.ProcessId -eq $rootPid })
$selected = [System.Collections.Generic.List[object]]::new()
$owned = [System.Collections.Generic.HashSet[long]]::new()
if ($root.Count -eq 1) { $selected.Add($root[0]); [void]$owned.Add($rootPid) }
for ($depth = 0; $depth -lt 8; $depth++) {
  $added = 0
  foreach ($item in $all) {
    if (-not $owned.Contains([long]$item.ProcessId) -and $owned.Contains([long]$item.ParentProcessId)) {
      if ($selected.Count -ge 64) { $truncated = $true; break }
      $parent = @($selected | Where-Object { $_.ProcessId -eq $item.ParentProcessId })
      if ($parent.Count -eq 1 -and $item.CreationDate -ge $parent[0].CreationDate) { $selected.Add($item); [void]$owned.Add([long]$item.ProcessId); $added++ }
    }
  }
  if ($added -eq 0) { break }
}
if (@($all | Where-Object { -not $owned.Contains([long]$_.ProcessId) -and $owned.Contains([long]$_.ParentProcessId) }).Count -gt 0) { $truncated = $true }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PlexiformWindowMetadata {
  public delegate bool Visitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr window, StringBuilder value, int maximum);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$windows = [System.Collections.Generic.List[object]]::new()
$script:windowTruncated = $false
[void][PlexiformWindowMetadata]::EnumWindows({ param($window, $unused)
  [uint32]$owner = 0
  [void][PlexiformWindowMetadata]::GetWindowThreadProcessId($window, [ref]$owner)
  if ($owned.Contains([long]$owner)) {
    if ($windows.Count -ge 64) { $script:windowTruncated = $true; return $false }
    $class = [System.Text.StringBuilder]::new(129)
    [void][PlexiformWindowMetadata]::GetClassName($window, $class, 129)
    $name = $class.ToString()
    if ($name -notmatch '^(#32770|NSISDialog|NSISWindowClass|Chrome_WidgetWin_[0-9]{1,2})$') { $name = 'other' }
    $windows.Add([pscustomobject]@{ pid=[long]$owner; class=$name; visible=[PlexiformWindowMetadata]::IsWindowVisible($window) })
  }
  return $true
}, [IntPtr]::Zero)
$rows = @($selected | ForEach-Object { [pscustomobject]@{ pid=[long]$_.ProcessId; parentPid=[long]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o'); image=$_.ExecutablePath } })
[pscustomobject]@{ truncated=($truncated -or $script:windowTruncated); processes=$rows; windows=@($windows.ToArray()) } | ConvertTo-Json -Depth 4 -Compress
`;
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const pid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const imageIdentity = (image, canonicalize) => windowsPath(path.win32.join(canonicalize(path.win32.dirname(image)), path.win32.basename(image)));
function scope(payload, { pid: rootPid, started, exe }, canonicalize = fs.realpathSync.native, childReceipt) {
  if (!pid(rootPid) || !Number.isSafeInteger(started) || started <= 0) throw new Error('invalid owned process receipt');
  windowsPath(exe);
  if (!keys(payload, 'processes,truncated,windows') || typeof payload.truncated !== 'boolean' || !Array.isArray(payload.processes) || payload.processes.length > MAX_PROCESSES || !Array.isArray(payload.windows) || payload.windows.length > MAX_WINDOWS) throw new Error('invalid observation');
  const rows = new Map();
  for (const row of payload.processes) {
    if (!keys(row, 'created,image,parentPid,pid') || !pid(row.pid) || rows.has(row.pid) || !Number.isInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 0xffffffff || typeof row.created !== 'string' || row.created.length > 64 || !Number.isFinite(Date.parse(row.created))) throw new Error('invalid process metadata');
    windowsPath(row.image); rows.set(row.pid, row);
  }
  const root = rows.get(rootPid);
  if (!root) return { ok: false, reason: 'owned-process-unavailable', processes: [], windows: [], truncated: payload.truncated };
  const created = Date.parse(root.created);
  if (created < started - 1000 || created > started + 10000 || imageIdentity(root.image, canonicalize) !== imageIdentity(exe, canonicalize)) throw new Error('owned process identity changed');
  const owned = new Map([[rootPid, 0]]);
  for (let depth = 1; depth <= 8; depth++) for (const row of rows.values()) {
    const parent = rows.get(row.parentPid);
    if (!owned.has(row.pid) && owned.get(row.parentPid) === depth - 1 && Date.parse(row.created) >= Date.parse(parent.created)) owned.set(row.pid, depth);
  }
  if (owned.size !== rows.size) throw new Error('unbound process metadata');
  if (childReceipt) {
    if (!keys(childReceipt, 'exe,parentPid,pid,started') || !pid(childReceipt.pid) || !pid(childReceipt.parentPid) || !Number.isSafeInteger(childReceipt.started) || childReceipt.started <= 0) throw new Error('invalid owned child receipt');
    const child = rows.get(childReceipt.pid);
    if (!child || !owned.has(child.pid) || child.pid === rootPid || child.parentPid !== childReceipt.parentPid || Date.parse(child.created) < childReceipt.started - 1000 || Date.parse(child.created) > childReceipt.started + 1000 || imageIdentity(child.image, canonicalize) !== imageIdentity(childReceipt.exe, canonicalize)) throw new Error('owned child identity changed');
  }
  const processes = [...owned].map(([id, depth]) => {
    const row = rows.get(id), name = path.win32.basename(row.image).toLowerCase();
    const image = id === rootPid ? 'installer' : /^(?:old-uninstaller|uninstaller|uninstall plexiform|plexiform|cmd|powershell|conhost)\.exe$/.test(name) ? name : 'other-executable';
    return { pid: id, parentPid: row.parentPid, created: row.created, image, depth };
  });
  const windows = payload.windows.map(row => {
    if (!keys(row, 'class,pid,visible') || !owned.has(row.pid) || typeof row.visible !== 'boolean' || typeof row.class !== 'string' || !/^(?:#32770|NSISDialog|NSISWindowClass|Chrome_WidgetWin_\d{1,2}|other)$/.test(row.class)) throw new Error('unbound window metadata');
    return { pid: row.pid, class: row.class, visible: row.visible };
  });
  return { ok: !payload.truncated, processes, windows, truncated: payload.truncated };
}
function query(exe, args, options) {
  return new Promise((resolve, reject) => {
    let timer;
    execFile(exe, args, options, (error, stdout) => { clearTimeout(timer); error ? reject(error) : resolve(stdout); }); // privacy-flow: release-smoke
    timer = setTimeout(() => reject(new Error('observer deadline')), TIMEOUT_MS);
  });
}
async function collect(receipt, { env = process.env, platform = process.platform, run = query, canonicalize, childReceipt } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'Windows observer unavailable' };
  try {
    if (!pid(receipt?.pid) || !Number.isSafeInteger(receipt.started)) throw new Error('invalid receipt');
    windowsPath(receipt.exe);
    const roots = Object.keys(env).filter(key => key.toLowerCase() === 'systemroot');
    if (roots.length !== 1 || !/^[a-z]:\\windows$/.test(windowsPath(env[roots[0]]))) throw new Error('invalid Windows directory');
    if (childReceipt && (!keys(childReceipt, 'exe,parentPid,pid,started') || !pid(childReceipt.pid) || !pid(childReceipt.parentPid) || !Number.isSafeInteger(childReceipt.started) || childReceipt.started <= 0 || windowsPath(childReceipt.exe) !== windowsPath(path.win32.join(env[roots[0]], 'System32', 'cmd.exe')))) throw new Error('invalid owned child receipt');
    const exe = path.win32.join(env[roots[0]], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', QUERY], { env: { ...env, PLEXIFORM_OBSERVER_PID: String(receipt.pid) }, windowsHide: true, shell: false, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
    if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('observer output exceeded bound');
    return scope(JSON.parse(output.replace(/^\uFEFF/, '')), receipt, canonicalize, childReceipt);
  } catch { return { ok: false, reason: 'owned installer observation failed' }; }
}
module.exports = { collect, scope, TIMEOUT_MS, MAX_OUTPUT };
