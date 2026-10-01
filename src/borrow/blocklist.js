// Paths Borrow a setup never reads, never stats and never lists as
// "detected". The check is on the path string alone, before any fs call,
// so a blocked file's existence is never learned either.
//
// Paths are "~/…" (home-relative, forward slashes). The scanner resolves
// every link itself and checks each hop, so a path is checked as written and
// as it resolves.
//
// Names are compared case- and form-folded (NFKC, then upper → lower): APFS
// and NTFS open ~/.ſsh/config and ~/.SSH/config as ~/.ssh/config. A
// backslash is a separator on Windows and a name character elsewhere; a path
// is checked both ways, and blocked if either is.

// Directories never entered.
const DIRS = [
  '~/.ssh',                  // except ~/.ssh/config, offered only on explicit opt-in (see SSH_CONFIG)
  '~/.aws',
  '~/.gnupg',
  '~/.password-store',
  '~/.local/share/keyrings',
  '~/.local/share/password-store',
  '~/.config/op',            // 1Password CLI
  '~/.1password',
  '~/.kube',
  '~/.docker',
  '~/.azure',
  '~/.config/gcloud',
  '~/.terraform.d',
  '~/.vault-token',
  '~/.config/rclone',
  '~/.config/sops',
  '~/.local/share/fish/fish_history',
  '~/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Messages',
  '~/Library/Mail',
  '~/Library/Safari',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Firefox',
  '~/Library/Application Support/Arc',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/Vivaldi',
  '~/Library/Application Support/com.operasoftware.Opera',
  '~/Library/Application Support/1Password',
  '~/Library/Group Containers/2BUA8C4S2C.com.1password',
  '~/.mozilla',
  '~/.config/google-chrome',
  '~/.config/chromium',
  '~/.config/BraveSoftware',
  '~/AppData/Local/Google/Chrome',
  '~/AppData/Local/Microsoft/Edge',
  '~/AppData/Local/BraveSoftware',
  '~/AppData/Roaming/Mozilla',
  '~/AppData/Roaming/Microsoft/Credentials',
  '~/AppData/Local/Microsoft/Credentials',
  '~/AppData/Roaming/Microsoft/Protect',
  '~/AppData/Roaming/1Password',
  '~/AppData/Local/1Password',
  // Claude Code state that is private or holds transcripts and credentials.
  '~/.claude/projects',
  '~/.claude/todos',
  '~/.claude/shell-snapshots',
  '~/.claude/statsig',
  '~/.claude/ide',
  '~/.claude/session-env',
  '~/.claude/file-history',
  '~/.claude/plans',
  '~/.claude/history.jsonl',
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  '~/.codex/sessions',
  '~/.codex/history.jsonl',
  '~/.gemini/oauth_creds.json',
  '~/.claude-traffic-light/token',
  '~/.claude-traffic-light/sessions',
  '~/.claude-traffic-light/requests',
];

// File names blocked wherever they are.
const NAMES = [
  /^\.env(?:\..*)?$/i, /\.env$/i,                          // .env, .env.local, prod.env
  /^\.netrc$/i, /^_netrc$/i, /^\.pgpass$/i, /^\.my\.cnf$/i, /^\.git-credentials$/i,
  /^\.pypirc$/i, /^credentials(?:\.json|\.toml)?$/i,
  /^id_[a-z0-9]+(?:\.pub)?$/i, /^known_hosts(?:\.old)?$/i, /^authorized_keys$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|keychain(?:-db)?|gpg|pgp|asc|ovpn|mobileprovision|cer|crt|der|csr|age)$/i,
  /history$/i, /_history(?:\..*)?$/i, /^\.lesshst$/i, /^\.viminfo$/i, /\.shada$/i, /^\.node_repl_history$/i, /^\.python_history$/i,
  /^\.zsh_sessions$/i, /^\.bash_sessions$/i,
  /secret/i, /password/i, /token/i, /credential/i, /private[_-]?key/i, /\.vault/i,
  /^cookies(?:\.sqlite|\.binarycookies)?$/i, /^login data$/i, /^web data$/i,
  /\.sqlite3?$/i, /\.db$/i,
];

// Folders inside a scanned tree that are never walked (not secret, just noise or huge).
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'cache', 'Cache', 'logs', '.DS_Store', 'site-packages', 'undo', 'swap', 'backup', 'sessions', 'shada']);

// ~/.ssh/config is the one file inside a blocked folder that can be shared,
// and only when the person picks it explicitly (hostnames are templated).
const SSH_CONFIG = '~/.ssh/config';

// Case folding as a case-insensitive file system does it, erring wide.
const fold = (s) => s.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');

/** "~/a/b" with forward slashes, or null when the path is not inside home. */
function tildePath(abs, home, platform = process.platform) {
  const sep = (x) => (platform === 'win32' ? String(x).replace(/\\/g, '/') : String(x));
  const a = sep(abs);
  const h = sep(home).replace(/\/+$/, '');
  if (a === h) return '~';
  if (a.startsWith(`${h}/`)) return `~/${a.slice(h.length + 1)}`;
  if (a === '~' || a.startsWith('~/')) return a;
  return null;
}

// "~/a/../b" → "~/b"; null when ".." climbs out of the home folder.
function normalize(p, backslashIsSep = true) {
  const out = [];
  const s = String(p);
  for (const seg of (backslashIsSep ? s.replace(/\\/g, '/') : s).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length <= 1) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Why `p` ("~/…") may never be read, or null when it may.
 * opts.sshConfig: the person explicitly chose to share ~/.ssh/config.
 */
function blockedReason(p, { sshConfig = false } = {}) {
  if (typeof p !== 'string' || p.includes('\0')) return 'invalid path';
  const ways = p.includes('\\') ? [true, false] : [true];
  for (const backslashIsSep of ways) {
    const why = reasonFor(normalize(p, backslashIsSep), sshConfig);
    if (why) return why;
  }
  return null;
}

const FOLDED_DIRS = DIRS.map((d) => [d, fold(d)]);
const FOLDED_SSH_CONFIG = fold(SSH_CONFIG);

function reasonFor(n, sshConfig) {
  if (!n || (n !== '~' && !n.startsWith('~/'))) return 'outside the home folder';
  const f = fold(n);
  if (f === FOLDED_SSH_CONFIG) return sshConfig ? null : 'SSH config is shared only when you pick it';
  for (const [d, fd] of FOLDED_DIRS) {
    if (f === fd || f.startsWith(`${fd}/`)) return `never read: ${d}`;
  }
  const segs = f.split('/');
  const name = segs[segs.length - 1];
  for (const re of NAMES) if (re.test(name)) return 'never read: file name looks sensitive';
  return null;
}

module.exports = { blockedReason, tildePath, normalize, fold, SKIP_DIRS, SSH_CONFIG, DIRS };
