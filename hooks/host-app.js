// Host-app names from a bundle id or an executable path, shared by the hook
// (hooks/set-status.js) and its tests. No requires: the hook loads it on every event.
const BUNDLE_APPS = {
  'com.mitchellh.ghostty': 'Ghostty',
  // Ghostty Dock is a separate app built on Ghostty: its sessions must not be
  // recorded as stock Ghostty, or a click would script the wrong app.
  'consulting.cloudscale.ghosttydock': 'Ghostty Dock',
  'com.googlecode.iterm2': 'iTerm2',
  'com.apple.terminal': 'Terminal',
  'dev.warp.warp': 'Warp',
  'dev.warp.warp-stable': 'Warp',
  'com.microsoft.vscode': 'Visual Studio Code',
  'com.microsoft.vscodeinsiders': 'Visual Studio Code - Insiders',
  'com.visualstudio.code.oss': 'Code - OSS',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf',
  'net.kovidgoyal.kitty': 'kitty',
  'com.github.wez.wezterm': 'WezTerm',
  'org.alacritty': 'Alacritty',
  'co.zeit.hyper': 'Hyper',
  'com.jetbrains.intellij': 'IntelliJ IDEA',
};
// Process (executable) names as they appear in `ps -o comm=`, lowercased.
const PROCESS_APPS = {
  ghostty: 'Ghostty',
  iterm2: 'iTerm2',
  iterm: 'iTerm2',
  terminal: 'Terminal',
  warp: 'Warp',
  stable: 'Warp',
  code: 'Visual Studio Code',
  'code helper': 'Visual Studio Code',
  electron: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  kitty: 'kitty',
  'kitty-wrapper': 'kitty',
  'wezterm-gui': 'WezTerm',
  wezterm: 'WezTerm',
  alacritty: 'Alacritty',
  hyper: 'Hyper',
};

// One `ps -o comm=` path. `/Applications/Ghostty.app/Contents/MacOS/ghostty` →
// both "Ghostty" (the bundle) and "ghostty" (the binary) are worth testing. The
// bundle wins: Ghostty Dock's binary is also called `ghostty`.
function appOfExe(exe) {
  const bundle = /\/([^/]+)\.app\//.exec(exe);
  if (bundle && Object.values(BUNDLE_APPS).includes(bundle[1])) return bundle[1];
  const base = (exe.split('/').pop() || '').toLowerCase();
  if (PROCESS_APPS[base]) return PROCESS_APPS[base];
  if (bundle) {
    const hit = Object.values(BUNDLE_APPS).find((n) => n.toLowerCase() === bundle[1].toLowerCase());
    if (hit) return hit;
  }
  return null;
}

module.exports = { BUNDLE_APPS, PROCESS_APPS, appOfExe };
