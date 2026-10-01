// Linux: bring the session's terminal window forward. wmctrl -a raises the
// first window whose title contains the text (X11, and XWayland windows),
// so the folder name is tried first, then common terminal names. Without
// wmctrl, or on pure Wayland, nothing is raised and the caller falls back.
const TITLES = ['Terminal', 'Konsole', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Tilix', 'Terminator', 'xterm'];

// exec(file, args) → Promise<boolean> (exited 0). → { app, exact } | null
async function activate(folderHint, exec) {
  const tries = [folderHint, ...TITLES].filter(Boolean);
  for (const t of tries) {
    let ok = false;
    try { ok = await exec('wmctrl', ['-a', t]); } catch { return null; } // privacy-flow: terminal-jump
    if (ok) return { app: t, exact: t === folderHint };
  }
  return null;
}

module.exports = { activate, TITLES };
