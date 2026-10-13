// A fake Mac for the data-rights tests: a home with Plexiform's four roots,
// an AI tool's own folder, a repository and a folder outside everything.
// Nothing here touches the real home.
const fs = require('fs');
const os = require('os');
const path = require('path');

function put(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fakeMac() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'data-rights-')));
  const home = path.join(base, 'home');
  const support = path.join(home, 'Library', 'Application Support');
  const roots = {
    home,
    dataDir: path.join(home, '.claude-traffic-light'),
    userDataDir: path.join(support, 'Plexiform'),
    backupsDir: path.join(support, 'Plexiform Backups'),
    legacyDir: path.join(support, 'claude-buddy'),
  };
  for (const d of [roots.dataDir, roots.userDataDir]) fs.mkdirSync(d, { recursive: true });
  const outside = path.join(base, 'outside');
  put(path.join(outside, 'precious.txt'), 'outside the data folders');
  put(path.join(home, '.claude', 'history.jsonl'), '{"display":"ai tool history"}\n');
  put(path.join(home, 'code', 'repo', 'main.js'), 'console.log(1)');
  return { base, roots, outside, put, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

module.exports = { fakeMac, put };
