'use strict';
// Metadata only, for the disposable hosted Windows lifecycle fixture.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_PROCESSES = 64, MAX_OUTPUT = 32768, TIMEOUT_MS = 5000;
const QUERY = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$items = @(Get-CimInstance Win32_Process -Filter "Name=\'Plexiform.exe\' OR Name=\'Uninstall Plexiform.exe\'" | Select-Object -First 65)',
  '$rows = @($items | Select-Object -First 64 | ForEach-Object { [pscustomobject]@{ pid=[long]$_.ProcessId; parentPid=[long]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString("o"); image=$_.ExecutablePath } })',
  '[pscustomobject]@{ truncated=($items.Count -gt 64); processes=$rows } | ConvertTo-Json -Depth 4 -Compress',
].join('; ');

function windowsPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n"]/.test(value)) throw new Error('invalid diagnostic path');
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) value = value.slice(4);
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\?]+\\[^\\]+\\)/.test(value)) throw new Error('invalid diagnostic path');
  return path.win32.normalize(value).replace(/\\$/, '').toLowerCase();
}

// Canonicalize each image's parent before the component check, including
// short/long directory aliases. Opening a running image for realpath can
// encounter its image-sharing lock. Unknown leaf names remain unresolved.
function scopeProcesses(payload, canonicalInstallDir, canonicalize = fs.realpathSync.native) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'processes,truncated' || typeof payload.truncated !== 'boolean' || !Array.isArray(payload.processes) || payload.processes.length > MAX_PROCESSES) throw new Error('invalid diagnostic inventory');
  const prefix = windowsPath(canonicalInstallDir) + '\\', images = [];
  let unresolved = 0;
  for (const row of payload.processes) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'created,image,parentPid,pid' || !Number.isInteger(row.pid) || row.pid <= 0 || row.pid > 0xffffffff || !Number.isInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 0xffffffff || typeof row.created !== 'string' || row.created.length > 64 || !Number.isFinite(Date.parse(row.created))) throw new Error('invalid diagnostic process');
    let image;
    try {
      windowsPath(row.image);
      const name = path.win32.basename(row.image);
      if (!/^(?:Plexiform|Uninstall Plexiform)\.exe$/i.test(name)) throw new Error('unknown diagnostic image');
      image = windowsPath(path.win32.join(canonicalize(path.win32.dirname(row.image)), name));
    }
    catch { unresolved++; continue; }
    if (image.startsWith(prefix)) images.push({ pid: row.pid, parentPid: row.parentPid, created: row.created, image: image.slice(prefix.length) });
  }
  return { ok: !payload.truncated && unresolved === 0, images, truncated: payload.truncated, unresolved };
}

function query(exe, args, options) {
  return new Promise((resolve, reject) => {
    // execFile requests termination at its timeout. The outer deadline also
    // refuses if that termination or its callback is delayed; it proves no
    // descendant/handle cleanup and never changes the fixture on failure.
    let timer;
    execFile(exe, args, options, (error, stdout) => { clearTimeout(timer); error ? reject(error) : resolve(stdout); }); // privacy-flow: release-smoke
    timer = setTimeout(() => reject(Object.assign(new Error('diagnostic deadline'), { code: 'EDEADLINE' })), TIMEOUT_MS);
  });
}

async function collect(installDir, { canonicalInstallDir, env, platform = process.platform, run = query, canonicalize } = {}) {
  if (platform !== 'win32') return { ok: false, error: 'Windows diagnostics unavailable' };
  try {
    const rootKeys = Object.keys(env ?? {}).filter(key => key.toLowerCase() === 'systemroot');
    if (rootKeys.length !== 1) throw new Error('ambiguous hosted Windows directory');
    const systemRoot = windowsPath(env[rootKeys[0]]);
    if (!/^[a-z]:\\windows$/.test(systemRoot)) throw new Error('unsupported hosted Windows directory');
    const exe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = await run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', QUERY], { env, windowsHide: true, shell: false, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT) return { ok: false, truncated: true, error: 'diagnostic output exceeded bound' };
    return scopeProcesses(JSON.parse(output.replace(/^\uFEFF/, '')), canonicalInstallDir, canonicalize);
  } catch (error) {
    // No command line, raw query output, stderr or unrelated image path leaks.
    return { ok: false, error: 'Windows process diagnostic failed', code: typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : null };
  }
}

module.exports = { collect, scopeProcesses, windowsPath, MAX_OUTPUT, TIMEOUT_MS };
