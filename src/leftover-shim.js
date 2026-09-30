// The model router is gone, but switching it on used to add a PATH block to
// your shell rc and a `claude` shim under ~/.claude-traffic-light/bin. The
// shim starts claude unrouted once the router script is missing, so nothing
// breaks; this only notices the leftovers and hands you the exact command to
// remove them (including the buddy-reader / buddy-worker agents under
// ~/.claude/agents). It reads, it never edits an rc file.
const fs = require('fs');
const path = require('path');

const BEGIN = '# claude-buddy router >>>';
const END = '# claude-buddy router <<<';

function rcFiles({ home, env = {} }) {
  return [
    path.join(env.ZDOTDIR || home, '.zshrc'), path.join(home, '.zshrc'),
    path.join(home, '.bash_profile'), path.join(home, '.bashrc'),
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'config.fish'),
  ].filter((f, i, a) => a.indexOf(f) === i);
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sedRange = `/^${BEGIN}$/,/^${END}$/d`;

// → null, or { files, shim, command, note }.
function detect({ home, env = {}, root = path.join(home, '.claude-traffic-light'), platform = process.platform, readFile = (f) => fs.readFileSync(f, 'utf8'), exists = fs.existsSync }) {
  const files = rcFiles({ home, env }).filter((f) => {
    try { return readFile(f).split('\n').some((l) => l.trim() === BEGIN); } catch { return false; }
  });
  const shim = path.join(root, 'bin', 'claude');
  const shimThere = exists(shim);
  const agentFiles = ['buddy-reader.md', 'buddy-worker.md'].map((n) => path.join(home, '.claude', 'agents', n)).filter((f) => exists(f));
  if (!files.length && !shimThere && !agentFiles.length) return null;
  const sedInPlace = platform === 'darwin' ? "sed -i ''" : 'sed -i';
  const parts = files.map((f) => `${sedInPlace} ${shQuote(sedRange)} ${shQuote(f)}`);
  if (shimThere) parts.push(`rm -f ${shQuote(shim)}`);
  parts.push(...agentFiles.map((f) => `rm -f ${shQuote(f)}`));
  const where = files.map((f) => f.replace(home, '~')).join(', ');
  return {
    files,
    shim: shimThere ? shim : null,
    agentFiles,
    command: parts.join(' && '),
    note: files.length ? `An old router block is still in ${where} — Buddy won't edit it. To remove it, run:` : 'Old router leftovers are still on disk — Buddy won\'t delete them. To remove them, run:',
  };
}

module.exports = { BEGIN, END, rcFiles, detect };
