// Zero-leak corpus for the dotfile scrubber (src/borrow/scrub.js), written from
// src/borrow/README.md alone. Guarantees 1-4 and 6 are asserted here; 5 is the
// per-file mustKeep lists in test/fixtures/borrow/corpus/manifest.json.
//
// Every seeded secret is generated at run time from fragments (see
// fixtures/borrow/seedkit.js), so the repository never holds a string a secret
// scanner would flag. The seed is fixed so a run is reproducible; every
// assertion prints it. Try another with BORROW_CORPUS_SEED=<n>.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kit = require('./fixtures/borrow/seedkit.js');
const { SECRET_PATTERNS, findSecrets } = require('../board/shared/secret-patterns.mjs');

const CORPUS = path.join(__dirname, 'fixtures', 'borrow', 'corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
const SEED = kit.seedFrom(process.env.BORROW_CORPUS_SEED, 0xC0A5E);
const seedNote = `BORROW_CORPUS_SEED=${SEED}`;
const read = (file) => fs.readFileSync(path.join(CORPUS, 'files', file), 'utf8');

let scrubFile = null;
let loadError = null;
try {
  ({ scrubFile } = require(process.env.BORROW_SCRUB_MODULE || '../src/borrow/scrub.js'));
  if (typeof scrubFile !== 'function') loadError = 'src/borrow/scrub.js loaded but exports no scrubFile() function';
} catch (e) {
  loadError = e && e.code === 'MODULE_NOT_FOUND' && /scrub\.js/.test(String(e.message).split('\n')[0])
    ? 'src/borrow/scrub.js does not exist yet. These tests need the scrubber: scrubFile({path, content, format, machine}).'
    : `src/borrow/scrub.js failed to load: ${e && e.stack}`;
}

const OK_FILES = manifest.files.filter((f) => f.expected !== 'blocked');
const VARIANTS = {
  lf: (t) => t,
  crlf: (t) => t.replace(/\n/g, '\r\n'),
  bom: (t) => `﻿${t}`,
};
const variantsFor = (machine) => (machine === kit.MACHINES[0] ? ['lf', 'crlf', 'bom'] : ['lf', 'crlf']);

function fill(entry, machine) {
  const rng = kit.mulberry32(SEED ^ kit.hashSeed(`${entry.file}/${machine.label}`));
  const { text, secrets } = kit.fillSeeds(read(entry.file), rng, machine);
  return { text: entry.trimFinalNewline ? text.replace(/\n$/, '') : text, secrets };
}

// ── fixtures are sound (independent of the scrubber) ────────────────────────
test('manifest: every file exists, expected is ok|blocked, ok files list must-keep strings', () => {
  const seen = new Set();
  for (const f of manifest.files) {
    assert.ok(fs.existsSync(path.join(CORPUS, 'files', f.file)), `missing fixture ${f.file}`);
    assert.ok(!seen.has(f.file), `duplicate fixture ${f.file}`);
    seen.add(f.file);
    assert.match(f.path, /^~\//, `${f.file}: path must be a ~ path`);
    assert.ok(['ok', 'blocked', 'ok-or-blocked'].includes(f.expected), `${f.file}: bad expected`);
    if (f.expected !== 'blocked') assert.ok((f.mustKeep?.length ?? 0) > 0, `${f.file}: no mustKeep strings`);
  }
  assert.ok(manifest.files.length >= 25 && manifest.files.length <= 40, `${manifest.files.length} files`);
});

test('fixtures hold no literal machine value and no literal 30+ char token outside seed slots', () => {
  const offenders = [];
  for (const f of manifest.files) {
    const raw = read(f.file);
    const low = raw.toLowerCase();
    for (const v of ['tonde', '/users/', 'macbook', '10.0.4.12', '192.168.1.50', 'othercorp', 'acme.internal', 'ts.net']) if (low.includes(v)) offenders.push(`${f.file}: literal "${v}"`);
    if (!f.mustKeepMatching) for (const m of raw.replace(/@@[A-Za-z0-9:_]+@@/g, '').matchAll(/[A-Za-z0-9_-]{30,}/g)) if (/\d/.test(m[0])) offenders.push(`${f.file}: long run ${m[0].slice(0, 20)}...`);
  }
  assert.deepEqual(offenders, []);
});

test('corpus covers every kind in secret-patterns.mjs (and the pem variants) at least once', () => {
  const used = new Set();
  for (const f of manifest.files) for (const m of read(f.file).matchAll(/@@SEED:([a-z0-9_]+)@@/g)) used.add(m[1]);
  const missing = SECRET_PATTERNS.map((p) => p.kind).filter((k) => !used.has(k));
  assert.deepEqual(missing, [], `kinds with no seed slot: ${missing.join(', ')}`);
  for (const k of ['private_key_escaped', 'keyed_spaced']) assert.ok(used.has(k), `no ${k} slot`);
  for (const k of used) assert.ok(k in kit.GEN, `fixture uses unknown seed kind ${k}`);
});

test('corpus covers the hard contexts the brief lists', () => {
  const all = manifest.files.map((f) => read(f.file)).join('\n');
  const has = (name, re) => assert.match(all, re, `corpus lacks: ${name}`);
  has('export', /^export \w+=.*@@SEED/m);
  has('set -gx', /^set -gx \w+ .*@@SEED/m);
  has('setenv', /^setenv \w+ @@SEED/m);
  has('alias definition', /^alias [\w.-]+=.*@@SEED/m);
  has('curl Authorization header in a function', /^\s+curl .*Authorization: Bearer @@SEED/m);
  has('escaped quotes', /\\"Authorization: token @@SEED/);
  has('backtick quotes', /=`echo @@SEED/);
  has('single quotes', /='@@SEED/);
  has('backslash continuation onto the next line', /=\\\n\s+"?@@SEED/);
  has('unquoted yaml value with spaces', /^password: @@SEED:keyed_spaced@@$/m);
  has('yaml block scalar', /: [|>][-+]?\n(?:[ \t]+.*\n)*?[ \t]+.*@@SEED/);
  has('toml inline table', /= \{ .*@@SEED/);
  has('url userinfo', /:\/\/[^\s@]*:@@SEED:url_credentials@@@/);
  has('url query token', /\?token=@@SEED:url_query_secret@@/);
  has('json three levels deep', /"hooks": \[\s*\{\s*"type": "command",\s*"command": ".*@@SEED/);
  has('heredoc', /<<'EOF'\n@@SEED:private_key@@/);
  assert.ok(manifest.files.some((f) => f.trimFinalNewline && /@@SEED:[a-z_]+@@\n?$/.test(read(f.file))), 'no file ends on a secret with no trailing newline');
});

test('every generated kind is detected by the shared list, so a leak is the scrubber\'s fault not the generator\'s', () => {
  const rng = kit.mulberry32(SEED);
  const bad = [];
  for (const [kind, gen] of Object.entries(kit.GEN)) {
    for (let i = 0; i < 40; i++) {
      const s = gen(rng);
      const text = kind === 'private_key_escaped' ? s.value : (kit.CANON[kind] || ((v) => v))(s.value);
      const hits = findSecrets(text);
      const covered = s.rand.every((seg) => { const at = text.indexOf(seg); return hits.some((h) => h.index <= at && h.index + h.length >= at + seg.length); });
      if (!covered) { bad.push(kind); break; }
    }
  }
  assert.deepEqual(bad, [], `${bad.join(', ')} not covered; ${seedNote}`);
});

test('every mustKeep string is really in the filled fixture, for both machine profiles', () => {
  const missing = [];
  for (const m of kit.MACHINES) {
    for (const f of OK_FILES) {
      const { text } = fill(f, m);
      for (const s of f.mustKeep) if (!text.includes(s)) missing.push(`${f.file}: ${JSON.stringify(s)}`);
      for (const s of f.mustKeepMatching || []) if (![...text.matchAll(new RegExp(s, 'g'))].length) missing.push(`${f.file}: regex ${s} matches nothing`);
      for (const s of f.mustKeep) for (const v of kit.machineValues(m)) if (s.toLowerCase().includes(v.toLowerCase())) missing.push(`${f.file}: mustKeep ${JSON.stringify(s)} contains machine value ${v}`);
    }
  }
  assert.deepEqual(missing, [], seedNote);
});

if (loadError) {
  test('scrubber module is available', () => assert.fail(loadError));
} else {
  const allProblems = [];
  const COLS = ['file', 'variant', 'type', 'kind', 'line', 'detail', 'text'];

  test.after(() => {
    if (!allProblems.length) return;
    console.log(`\n=== BORROW CORPUS LEAK TABLE (BORROW_CORPUS_SEED=${SEED}) ===`);
    console.log(kit.renderTable(allProblems.slice(0, 200), COLS));
    if (allProblems.length > 200) console.log(`... and ${allProblems.length - 200} more`);
    const by = {};
    for (const p of allProblems) by[p.type] = (by[p.type] || 0) + 1;
    console.log(`totals by type: ${JSON.stringify(by)}\n`);
  });

  const fail = (title, problems) => {
    allProblems.push(...problems);
    assert.fail(`${title}\nBORROW_CORPUS_SEED=${SEED}\n${kit.renderTable(problems, COLS)}`);
  };

  const cloneMachine = (m) => ({ home: m.home, user: m.user, hostname: m.hostname, emails: [...m.emails], names: [...(m.names || [])] });

  function checkOne(entry, machine, variant) {
    const { text, secrets } = fill(entry, machine);
    const input = VARIANTS[variant](text);
    const probs = [];
    const add = (type, detail, extra = {}) => probs.push({ file: entry.file, variant, type, kind: '', line: '', detail, text: '', ...extra });
    const { res, threw } = kit.callScrub(scrubFile, { path: entry.path, content: input, machine: cloneMachine(machine) });
    if (threw) { add('THREW', threw); return probs; }

    if (!(entry.expected === 'ok-or-blocked' ? ['ok', 'blocked'] : [entry.expected]).includes(res.status)) add('STATUS', `expected ${entry.expected}, got ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
    for (const p of kit.findProblems({ out: kit.sideChannels(res), secrets, machine })) probs.push({ file: entry.file, variant, ...p, type: `${p.type}@reason/records` });

    if (res.status === 'blocked' || entry.expected === 'blocked') {
      if (typeof res.content === 'string') for (const p of kit.findProblems({ out: res.content, secrets, machine })) probs.push({ file: entry.file, variant, ...p, type: `${p.type}@blocked-content` });
      if (res.status === 'blocked' && typeof res.reason !== 'string') add('SHAPE', 'blocked result has no reason string');
      return probs;
    }
    if (res.status !== 'ok') { add('SHAPE', `status must be ok|blocked, got ${JSON.stringify(res.status)}`); return probs; }
    if (typeof res.content !== 'string') { add('SHAPE', 'ok result has no content string'); return probs; }
    const out = res.content;

    for (const p of kit.findProblems({ out, secrets, machine })) probs.push({ file: entry.file, variant, ...p });

    for (const s of entry.mustKeep) if (!out.includes(s)) add('KEPT-LOST', 'must-keep string missing from output', { text: s.length > 100 ? `${s.slice(0, 100)}...` : s });
    for (const re of entry.mustKeepMatching || []) {
      for (const m of new Set(text.match(new RegExp(re, 'g')) || [])) if (!out.includes(m)) add('KEPT-LOST', `must-keep match of /${re}/ missing`, { text: m });
    }

    if (!Array.isArray(res.redactions) || !Array.isArray(res.templates)) { add('SHAPE', 'redactions and templates must be arrays'); return probs; }
    if (secrets.length && !res.redactions.length) add('RECORDS', 'secrets were seeded but redactions is empty');
    if (kit.machineValues(machine).some((v) => text.toLowerCase().includes(v.toLowerCase())) && !res.templates.length && !res.redactions.length) add('RECORDS', 'machine values were present but neither templates nor redactions record anything');
    const lines = out.split(/\r?\n/);
    for (const [listName, list] of [['redactions', res.redactions], ['templates', res.templates]]) {
      for (const r of list) {
        if (!r || !Number.isInteger(r.line) || r.line < 1 || r.line > lines.length) { add('RECORDS', `${listName}: line ${r && r.line} is not a 1-based output line`); continue; }
        if (typeof r.placeholder !== 'string' || !r.placeholder) { add('RECORDS', `${listName}: line ${r.line} has no placeholder`); continue; }
        if (!lines[r.line - 1].includes(r.placeholder)) add('RECORDS', `${listName}: placeholder ${r.placeholder} is not on output line ${r.line}`, { line: r.line, text: lines[r.line - 1].slice(0, 100) });
      }
    }
    for (const r of res.redactions) if (typeof r.kind !== 'string' || !r.kind) { add('RECORDS', 'a redaction has no kind'); break; }
    return probs;
  }

  for (const machine of kit.MACHINES) {
    for (const entry of manifest.files) {
      test(`${entry.expected.padEnd(13)} ${entry.path}  [${entry.file}] ${machine.label}`, () => {
        const probs = variantsFor(machine).flatMap((v) => checkOne(entry, machine, v));
        if (probs.length) fail(`${entry.path} (${entry.file}, ${machine.label}): ${probs.length} problem(s)`, probs);
      });
    }
  }

  test('README placeholders: private IPs, other emails and internal hostnames do not survive in any ok file', () => {
    const probs = [];
    for (const machine of kit.MACHINES) {
      for (const entry of OK_FILES) {
        const { text, secrets } = fill(entry, machine);
        const { res } = kit.callScrub(scrubFile, { path: entry.path, content: text, machine: cloneMachine(machine) });
        if (!res || res.status !== 'ok' || typeof res.content !== 'string') continue;
        for (const p of kit.findProblems({ out: res.content, secrets: [], machine: { home: 'x', user: 'x', hostname: 'x', emails: [], names: [] }, secondary: true })) {
          if (p.type === 'TEMPLATED') probs.push({ file: entry.file, variant: machine.label, ...p });
        }
      }
    }
    if (probs.length) fail(`${probs.length} README-placeholder value(s) survived (not among the numbered guarantees)`, probs);
  });

  test('scrubbing is deterministic: the same input gives the same output', () => {
    for (const entry of OK_FILES.slice(0, 6)) {
      const { text } = fill(entry, kit.MACHINES[0]);
      const run = () => kit.callScrub(scrubFile, { path: entry.path, content: text, machine: cloneMachine(kit.MACHINES[0]) }).res;
      assert.deepEqual(run(), run(), entry.file);
    }
  });

  test('scrubFile does not mutate the machine object it is given', () => {
    const m = cloneMachine(kit.MACHINES[0]);
    const before = JSON.stringify(m);
    kit.callScrub(scrubFile, { path: '~/.zshrc', content: `export A=1 # ${m.user}\n`, machine: m });
    assert.equal(JSON.stringify(m), before);
  });

  // ── guarantee 3 ───────────────────────────────────────────────────────────
  for (const p of ['~/.env', '~/.netrc', '~/.ssh/id_ed25519', '~/.ssh/id_rsa', '~/.ssh/id_ecdsa', '~/.aws/credentials']) {
    test(`guarantee 3: ${p} is blocked whatever its content`, () => {
      for (const content of ['', 'export FOO=bar\n', '# just a comment\n']) {
        const { res, threw } = kit.callScrub(scrubFile, { path: p, content, machine: cloneMachine(kit.MACHINES[0]) });
        assert.ok(!threw, threw);
        assert.equal(res.status, 'blocked', `${p} with content ${JSON.stringify(content)} came back ${res.status}`);
        assert.equal(typeof res.reason, 'string');
        assert.ok(res.content === undefined || res.content === null || res.content === '' || !res.content.includes('FOO=bar'), 'blocked result must not carry the file text');
      }
    });
  }

  // ── guarantee 6 ───────────────────────────────────────────────────────────
  const PLACEHOLDERS = ['{{SECRET:github_token}}', '{{HOME}}', '{{USER}}', '{{HOSTNAME}}', '{{EMAIL}}', '{{EMAIL:2}}', '{{IP:1}}', '{{HOST:3}}'];
  for (const ph of PLACEHOLDERS) {
    test(`guarantee 6: a file already containing ${ph} is blocked`, () => {
      const shapes = [
        ['~/.zshrc', `export A=1\n# note ${ph}\nexport B=2\n`],
        ['~/.zshrc', `export A=1\r\nexport B="${ph}/bin"\r\n`],
        ['~/.zshrc', `export A=1\nexport B=2 ${ph}`],
        ['~/.claude/settings.json', `{ "a": "${ph}" }\n`],
        ['~/.config/app/config.toml', `key = "x ${ph}"\n`],
      ];
      for (const [p, content] of shapes) {
        const { res, threw } = kit.callScrub(scrubFile, { path: p, content, machine: cloneMachine(kit.MACHINES[0]) });
        assert.ok(!threw, threw);
        assert.equal(res.status, 'blocked', `${p} ${JSON.stringify(content)} came back ${res.status}`);
      }
    });
  }

  test('AMBIGUITY: template syntax that is not Buddy\'s placeholder syntax does not block a file', () => {
    const cases = [
      ['~/.config/mise/config.toml', 'PROJECT_ROOT = "{{ env.HOME }}/dev"\n', '{{ env.HOME }}/dev'],
      ['~/.config/lazygit/config.yml', 'command: echo {{.SelectedLocalBranch.Name}}\n', '{{.SelectedLocalBranch.Name}}'],
      ['~/.config/app/ci.yml', 'token: ${{ secrets.NPM_TOKEN }}\n', '${{ secrets.NPM_TOKEN }}'],
      ['~/.config/app/helm.yml', 'name: {{ .Release.Name }}-app\n', '{{ .Release.Name }}-app'],
    ];
    for (const [p, content, keep] of cases) {
      const { res, threw } = kit.callScrub(scrubFile, { path: p, content, machine: cloneMachine(kit.MACHINES[0]) });
      assert.ok(!threw, threw);
      assert.equal(res.status, 'ok', `${content.trim()} came back ${res.status} (${res.reason})`);
      assert.ok(res.content.includes(keep), `look-alike was altered: ${res.content}`);
    }
  });

  // ── what the output looks like ────────────────────────────────────────────
  test('placeholders: home, user, hostname and email get their own README placeholders', () => {
    const m = cloneMachine(kit.MACHINES[1]);
    const content = `cd ${m.home}/dev\nexport WHO=${m.user}\nexport BOX=${m.hostname}\nexport MAIL=${m.emails[0]}\n`;
    const { res } = kit.callScrub(scrubFile, { path: '~/.zshrc', content, machine: m });
    assert.equal(res.status, 'ok');
    const lines = res.content.split('\n');
    assert.equal(lines[0], 'cd {{HOME}}/dev');
    assert.equal(lines[1], 'export WHO={{USER}}');
    assert.equal(lines[2], 'export BOX={{HOSTNAME}}');
    assert.equal(lines[3], 'export MAIL={{EMAIL}}');
    assert.deepEqual(res.templates.map((t) => t.line).sort(), [1, 2, 3, 4]);
  });

  test('a secret is replaced by a {{SECRET:<name>}} placeholder and recorded on the right output line', () => {
    const s = kit.makeSecret('github_token', kit.mulberry32(SEED), kit.MACHINES[0]);
    const content = `export EDITOR=nvim\nexport GITHUB_TOKEN=${s.value}\nexport PAGER=less\n`;
    const { res } = kit.callScrub(scrubFile, { path: '~/.zshrc', content, machine: cloneMachine(kit.MACHINES[0]) });
    assert.equal(res.status, 'ok');
    assert.equal(kit.findProblems({ out: res.content, secrets: [s], machine: kit.MACHINES[0] }).length, 0);
    assert.match(res.content, /^export GITHUB_TOKEN=\S*\{\{SECRET:[^}]+\}\}/m);
    assert.equal(res.redactions.length, 1);
    assert.equal(res.redactions[0].line, 2);
    assert.ok(res.content.split('\n')[1].includes(res.redactions[0].placeholder));
    assert.ok(res.content.includes('export EDITOR=nvim\n') && res.content.includes('export PAGER=less\n'));
  });

  test('two secrets on one line are both removed and both recorded', () => {
    const rng = kit.mulberry32(SEED);
    const a = kit.makeSecret('github_token', rng, kit.MACHINES[0]);
    const b = kit.makeSecret('anthropic_key', rng, kit.MACHINES[0]);
    const content = `curl -H "X-A: ${a.value}" -H "X-B: ${b.value}" https://api.example.com\n`;
    const { res } = kit.callScrub(scrubFile, { path: '~/.zshrc', content, machine: cloneMachine(kit.MACHINES[0]) });
    assert.equal(res.status, 'ok');
    assert.deepEqual(kit.findProblems({ out: res.content, secrets: [a, b], machine: kit.MACHINES[0] }), []);
    assert.ok(res.content.includes('https://api.example.com'));
    assert.ok(res.redactions.length >= 2);
  });

  test('a file with nothing to scrub comes back ok and unchanged', () => {
    const content = read('tool-versions');
    const { res } = kit.callScrub(scrubFile, { path: '~/.tool-versions', content, machine: cloneMachine(kit.MACHINES[0]) });
    assert.equal(res.status, 'ok');
    assert.equal(res.content, content);
    assert.deepEqual(res.redactions, []);
    assert.deepEqual(res.templates, []);
  });

  test('a secret as the very last bytes of a file with no trailing newline is removed', () => {
    const rng = kit.mulberry32(SEED + 1);
    for (const kind of ['github_token', 'keyed', 'private_key', 'basic_auth']) {
      const s = kit.makeSecret(kind, rng, kit.MACHINES[0]);
      const tail = { github_token: `export GITHUB_TOKEN=${s.value}`, keyed: `export DB_PASSWORD=${s.value}`, private_key: `KEY="${s.value.replace(/\n/g, '\\n')}"`, basic_auth: `Authorization: Basic ${s.value}` }[kind];
      const content = `export A=1\n${tail}`;
      const { res } = kit.callScrub(scrubFile, { path: '~/.zshrc', content, machine: cloneMachine(kit.MACHINES[0]) });
      if (res.status === 'blocked') continue;
      assert.deepEqual(kit.findProblems({ out: res.content, secrets: [s], machine: kit.MACHINES[0] }), [], kind);
    }
  });
}
