// PowerShell calls on Windows. Values (a folder name, a sound path, text to
// speak) reach the script through environment variables, never spliced into
// its text: PowerShell treats the curly quotes U+2018–U+201B as quote marks
// too, so escaping ' alone let a folder named x’;calc;’ run code.
const { execFile } = require('child_process');

const ENV_PREFIX = 'PLEXIFORM_PS_';

const BASE_ARGS = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'];

// $env:PLEXIFORM_PS_<i> for each value, in order. The names are the only thing
// the caller splices into its script.
const ref = (i) => `$env:${ENV_PREFIX}${i}`;

function envFor(values, base = process.env) {
  const env = { ...base };
  values.forEach((v, i) => { env[`${ENV_PREFIX}${i}`] = String(v ?? ''); });
  return env;
}

// script: (refs: string[]) → PowerShell source that reads each value as refs[i].
function command(script, values = []) {
  const text = typeof script === 'function' ? script(values.map((_, i) => ref(i))) : script;
  return { file: 'powershell', args: [...BASE_ARGS, text], env: envFor(values) };
}

function run(script, values, opts, cb) {
  const c = command(script, values);
  return execFile(c.file, c.args, { ...opts, env: { ...c.env, ...(opts && opts.env) }, windowsHide: true }, cb); // privacy-flow: windows-powershell
}

// The scripts the app runs. Each takes the $env: references for its values.
const SCRIPTS = {
  // Raise the first window whose title contains one of the values.
  appActivate: (refs) => `$w = New-Object -ComObject WScript.Shell; foreach ($t in @(${refs.join(',')})) { if ($w.AppActivate($t)) { Write-Output $t; exit } }; Write-Output NONE`,
  playSound: ([file]) => `(New-Object Media.SoundPlayer ${file}).PlaySync()`,
  speak: ([words]) => `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${words})`,
};

module.exports = { command, run, envFor, ENV_PREFIX, SCRIPTS };
