// Where hatched (and, later, installed) characters live on disk:
//   <data dir>/characters/<id>/character.json   the validated character
//   <data dir>/characters/<id>/hatch.json       how it was made (choices, time, source)
// Everything is validated on the way in and again on the way out, so a file
// someone dropped in the folder is held to the same rules as a fresh Hatch:
// it is parsed as JSON, never executed, and its art goes through the
// allowlist sanitiser. Ids are checked before they touch a path, symlinks are
// never followed, and sizes and counts are capped.
const fs = require('fs');
const path = require('path');
const { validateCharacter } = require('../characters/validate.js');

const ID = /^u-[a-z][a-z0-9-]{1,31}$/;
const LIMITS = { fileBytes: 256 * 1024, count: 60 };

function create({ dir, log = () => {} }) {
  const root = path.resolve(dir);
  const ensureRoot = () => { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); };
  const folder = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('not a character id');
    const p = path.join(root, id);
    if (path.dirname(p) !== root) throw new Error('not a character id');
    return p;
  };
  // a regular file, small enough to read: opened without following a symlink, then
  // checked on the descriptor itself, so nothing can be swapped in between
  const readSmall = (file) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > LIMITS.fileBytes) throw new Error('not a regular file of a sane size');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  };
  // O_EXCL: fails on an existing path or a planted symlink instead of writing through it
  const writeAtomic = (file, text) => {
    const tmp = `${file}.tmp-${process.pid}`;
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  };

  function list() {
    let names;
    try { names = fs.readdirSync(root); } catch { return []; }
    const out = [];
    for (const name of names.sort().slice(0, LIMITS.count * 4)) {
      if (out.length >= LIMITS.count) break;
      if (!ID.test(name)) continue;
      try {
        const dirStat = fs.lstatSync(path.join(root, name));
        if (!dirStat.isDirectory()) continue;
        const raw = JSON.parse(readSmall(path.join(root, name, 'character.json')));
        const v = validateCharacter(raw, { source: 'import' });
        if (!v.ok) { log(`characters: ${name} is invalid (${v.errors[0] && v.errors[0].message}); skipped`); continue; }
        if (v.character.id !== name) { log(`characters: ${name} holds a character with another id; skipped`); continue; }
        let meta = {};
        try { meta = JSON.parse(readSmall(path.join(root, name, 'hatch.json'))); } catch { /* optional */ }
        out.push({ character: v.character, meta: { source: typeof meta.source === 'string' ? meta.source.slice(0, 16) : 'unknown', createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : null, params: meta.params && typeof meta.params === 'object' ? meta.params : null } });
      } catch (e) { log(`characters: ${name} could not be read (${e.message}); skipped`); }
    }
    return out;
  }

  // a free id for a new character: u-otter, u-otter-2, …
  function freeId(base) {
    const slug = String(base || 'hatchling').toLowerCase().replace(/^u-/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 26) || 'hatchling';
    const b = /^[a-z]/.test(slug) ? slug : `h${slug}`;
    const taken = new Set(fs.existsSync(root) ? fs.readdirSync(root) : []);
    for (let n = 1; n < 1000; n += 1) {
      const id = `u-${n === 1 ? b : `${b}-${n}`}`.slice(0, 34);
      if (ID.test(id) && !taken.has(id)) return id;
    }
    throw new Error('too many characters with that name');
  }

  // def: any character-shaped object. It is validated here, and what is written is
  // the validator's output, not the input.
  function save(def, { source = 'hatch', params = null, overwrite = false } = {}) {
    ensureRoot();
    const v = validateCharacter(def, { source: 'import' });
    if (!v.ok) { const e = new Error(`character is not valid: ${v.errors[0].message}`); e.errors = v.errors; throw e; }
    const ch = v.character;
    const p = folder(ch.id);
    const exists = fs.existsSync(p);
    if (exists && !overwrite) throw new Error(`${ch.id} already exists`);
    if (!exists && list().length >= LIMITS.count) throw new Error(`at most ${LIMITS.count} characters`);
    const json = JSON.stringify(ch);
    if (Buffer.byteLength(json, 'utf8') > LIMITS.fileBytes) throw new Error('character is too large');
    if (exists && !fs.lstatSync(p).isDirectory()) throw new Error('not a character folder');
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(p, 'character.json'), json);
    writeAtomic(path.join(p, 'hatch.json'), JSON.stringify({ source: String(source).slice(0, 16), createdAt: Date.now(), params }));
    return ch;
  }

  function remove(id) {
    const p = folder(id);
    let st;
    try { st = fs.lstatSync(p); } catch { return false; }
    if (!st.isDirectory()) return false; // a symlink or a file: not ours to delete
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  }

  return { list, save, remove, freeId, ID, LIMITS, root };
}

module.exports = { create, ID, LIMITS };
