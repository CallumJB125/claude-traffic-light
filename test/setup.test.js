const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Rules = require('../rules');
const Cameos = require('../cameos');
const Delegate = require('../hooks/delegate');
const S = require('../setup');

const BUILT = path.join(__dirname, '..', 'assets', 'cameos', 'built');
const photo = (id) => fs.readFileSync(path.join(BUILT, `${id}.png`));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));

// A user's cameo dir holding real 256×256 cut-outs (borrowed from the built-ins).
function cameoDir(faces) {
  const dir = tmp();
  for (const [id, from, name, addedAt] of faces) Cameos.importPhoto(dir, { id, png: photo(from), entry: { name, addedAt, shape: 'rounded', eyes: { x: 0.4, y: 0.35 } } });
  return dir;
}

function sampleConfig(over = {}) {
  const rules = Rules.defaultRules().map(Rules.normalizeRule);
  rules.find((r) => r.id === 'working').then.cameo = 'dad';
  rules.find((r) => r.id === 'done').then.clicks = { click: { type: 'shell', arg: 'open -a Slack' } };
  return {
    rules,
    rulesVersion: Rules.RULES_VERSION,
    presets: [{ id: 'p1', name: 'Mine', rules: rules.slice(0, 3) }],
    routerPolicy: 'frugal',
    routerProjects: { '/code/app': 'opus', '/code/site': 'haiku' },
    routerDelegation: Delegate.normalize({ ...Delegate.DEFAULTS, mode: 'deny', readLines: 500, allow: ['README.md'] }),
    showAgents: false,
    agentRoster: true,
    agentKinds: { subagent: true, teammate: false, ralph: true, ultrawork: false },
    agentChipSize: 'large',
    roam: false, // not part of a setup
    showWidget: true,
    ...over,
  };
}

const exportFrom = (config, dir) => S.exportSetup({ config, cameoIndex: Cameos.loadIndex(dir), readPng: (id) => fs.readFileSync(path.join(dir, `${id}.png`)), now: 0 });

// What main.js does with a plan: faces through cameos.js, config through saveConfig.
function apply(plan, state) {
  for (const id of plan.remove) Cameos.removePhoto(state.dir, id);
  for (const c of plan.add) assert.ok(!Cameos.importPhoto(state.dir, c).error);
  state.config = { ...state.config, ...plan.partial };
  return state;
}
const stateOf = (state) => ({ config: state.config, cameoIndex: Cameos.loadIndex(state.dir), readPng: (id) => fs.readFileSync(path.join(state.dir, `${id}.png`)) });
const imp = (bundle, state, mode) => apply(S.planImport(S.readSetup(JSON.stringify(bundle)), stateOf(state), mode), state);

test('export: a complete, versioned bundle of the setup keys and only the user\'s own faces', () => {
  const dir = cameoDir([['dad', 'neo', 'Dad', 5], ['neo', 'powell', 'My Neo', 6]]);
  const b = exportFrom(sampleConfig(), dir);
  assert.equal(b.kind, 'claude-buddy-setup');
  assert.equal(b.v, S.SETUP_VERSION);
  assert.equal(b.rulesVersion, Rules.RULES_VERSION);
  assert.equal(b.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(b.config).sort(), ['agentChipSize', 'agentKinds', 'agentRoster', 'presets', 'routerDelegation', 'routerPolicy', 'routerProjects', 'rules', 'showAgents']);
  assert.deepEqual(b.config.rules, sampleConfig().rules);
  assert.deepEqual(b.config.routerProjects, { '/code/app': 'opus', '/code/site': 'haiku' });
  assert.deepEqual(b.cameos.map((c) => c.id).sort(), ['dad', 'neo'], 'shipped built-ins are not exported, a user replacement is');
  const dad = b.cameos.find((c) => c.id === 'dad');
  assert.deepEqual(Buffer.from(dad.png, 'base64'), photo('neo'));
  assert.equal(dad.name, 'Dad');
  assert.equal(dad.shape, 'rounded');
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b, 'plain JSON');
});

test('round trip: export then replace-import into a fresh install reproduces the same state', () => {
  const src = cameoDir([['dad', 'neo', 'Dad', 5], ['mum', 'saylor', 'Mum', 7], ['powell', 'baker', 'Jay', 9]]);
  const first = exportFrom(sampleConfig(), src);
  const fresh = { dir: tmp(), config: { rules: Rules.defaultRules(), presets: [], routerDelegation: { ...Delegate.DEFAULTS } } };
  imp(first, fresh, 'replace');
  assert.deepEqual(exportFrom(fresh.config, fresh.dir), first);
  assert.deepEqual(Cameos.loadIndex(fresh.dir), Cameos.loadIndex(src));
  for (const id of ['dad', 'mum', 'powell']) assert.deepEqual(fs.readFileSync(path.join(fresh.dir, `${id}.png`)), fs.readFileSync(path.join(src, `${id}.png`)));
});

test('import never switches delegation on or off, but takes its tuning', () => {
  const b = exportFrom(sampleConfig({ routerDelegation: Delegate.normalize({ ...Delegate.DEFAULTS, enabled: true, mode: 'deny' }) }), tmp());
  const off = imp(b, { dir: tmp(), config: { routerDelegation: { ...Delegate.DEFAULTS } } }, 'replace');
  assert.deepEqual([off.config.routerDelegation.enabled, off.config.routerDelegation.mode], [false, 'deny']);
  const on = imp(exportFrom(sampleConfig(), tmp()), { dir: tmp(), config: { routerDelegation: { ...Delegate.DEFAULTS, enabled: true } } }, 'replace');
  assert.equal(on.config.routerDelegation.enabled, true);
});

test('import rejects what is not a setup', () => {
  const err = (t) => S.readSetup(t).error;
  assert.match(err('not json'), /not valid JSON/);
  assert.match(err('[1,2]'), /Not a Claude Buddy/);
  assert.match(err('{"hello":1}'), /Not a Claude Buddy/);
  assert.match(err(JSON.stringify({ kind: S.KIND, config: {} })), /no version/);
  assert.match(err(JSON.stringify({ kind: S.KIND, v: S.SETUP_VERSION + 1, config: {} })), /newer Claude Buddy/);
  assert.match(err(' '.repeat(S.MAX_BYTES + 1)), /over 32 MB/);
  assert.match(err(undefined), /Not a setup/);
});

test('import sanitises config: bad values dropped, unknown keys ignored, sizes capped, ids made unique', () => {
  const junkRules = [null, 'x', 5, { id: 'a', name: { evil: 1 }, when: { signal: ['working', 7, 'x'.repeat(99)], tool: 42 }, then: { lamp: 'purple', pose: 'thumbs' } }, { id: 'a', when: 'nope', then: [] }, { id: '../../etc', name: 'n' }];
  const p = S.readSetup(JSON.stringify({
    kind: S.KIND, v: 1, rulesVersion: Rules.RULES_VERSION, hacked: true,
    config: {
      rules: [...junkRules, ...Array.from({ length: S.MAX_RULES + 50 }, (_, i) => ({ id: `r${i}` }))],
      presets: [{ name: 'ok', rules: [{}] }, { name: '', rules: [] }, { name: 'no rules' }, null, { id: 'ok', name: 'x'.repeat(99), rules: [] }],
      routerPolicy: 'reckless',
      routerProjects: { '/a': 'opus', '/b': 'gpt-5', ['/'.repeat(2000)]: 'haiku' },
      routerDelegation: { enabled: true, readLines: -5, allow: ['ok', 7, 'y'.repeat(300)] },
      showAgents: 'yes',
      agentRoster: false,
      agentKinds: { subagent: false, bogus: true, ralph: 'no' },
      agentChipSize: 'huge',
      showWidget: false,
      menuBarMode: true,
    },
  }));
  assert.equal(p.config.rules.length, S.MAX_RULES - 3, 'capped before parsing; the three non-objects are dropped');
  const [a, a2, weird] = p.config.rules;
  assert.deepEqual(a.when.signal, ['working']);
  assert.equal(a.when.tool, null);
  assert.equal(a.name, 'Untitled rule');
  assert.equal(a.then.lamp, null);
  assert.equal(a.then.pose, 'thumbs');
  assert.notEqual(a2.id, 'a', 'a duplicate id is renamed');
  assert.match(weird.id, /^[\w-]+$/);
  assert.equal(new Set(p.config.rules.map((r) => r.id)).size, p.config.rules.length);
  assert.deepEqual(p.config.presets.map((x) => x.name), ['ok', 'x'.repeat(30)]);
  assert.notEqual(p.config.presets[0].id, p.config.presets[1].id);
  assert.equal(p.config.routerPolicy, undefined);
  assert.deepEqual(p.config.routerProjects, { '/a': 'opus' });
  assert.deepEqual(p.config.routerDelegation.allow, ['ok']);
  assert.equal(p.config.routerDelegation.readLines, Delegate.DEFAULTS.readLines);
  assert.equal(p.config.showAgents, undefined);
  assert.equal(p.config.agentRoster, false);
  assert.deepEqual(p.config.agentKinds, { subagent: false });
  assert.equal(p.config.agentChipSize, undefined);
  for (const k of ['showWidget', 'menuBarMode', 'hacked']) assert.ok(!(k in p.config), k);
});

test('import: a file whose rules all fail to parse leaves the user\'s rules alone', () => {
  const p = S.readSetup(JSON.stringify({ kind: S.KIND, v: 1, config: { rules: [null, 1, 'x'] } }));
  assert.ok(!('rules' in p.config));
  const state = { dir: tmp(), config: { rules: ['mine'] } };
  apply(S.planImport(p, stateOf(state), 'replace'), state);
  assert.deepEqual(state.config.rules, ['mine']);
});

test('import sanitises faces through cameos.js rules: ids, entries, PNG shape, size, count', () => {
  const good = photo('neo').toString('base64');
  const big = Buffer.from(photo('neo'));
  big.writeUInt32BE(512, 16);
  const p = S.readSetup(JSON.stringify({
    kind: S.KIND, v: 1, config: {},
    cameos: [
      { id: 'dad', name: 'Dad', eyes: { x: 5, y: 'q' }, shape: 'star', png: good, extra: 'ignored' },
      { id: 'dad', name: 'Twin', png: good },
      { id: 'Bad Id', png: good },
      { id: '../../x', png: good },
      { id: 'none', png: good },
      { id: 'text', png: Buffer.from('hello').toString('base64') },
      { id: 'huge', png: big.toString('base64') },
      { id: 'fat', png: 'A'.repeat(S.MAX_PNG_BYTES * 2) },
      { id: 'nopng' },
      'string',
    ],
  }));
  assert.deepEqual(p.cameos.map((c) => c.id), ['dad']);
  assert.equal(p.dropped, 9);
  assert.deepEqual(p.cameos[0].entry, { name: 'Dad', eyes: { x: 1, y: Cameos.DEFAULT_EYES.y }, mouth: Cameos.DEFAULT_MOUTH, shape: 'oval', addedAt: 0 });
  const many = S.readSetup(JSON.stringify({ kind: S.KIND, v: 1, cameos: Array.from({ length: S.MAX_CAMEOS + 3 }, (_, i) => ({ id: `f${i}`, png: good })) }));
  assert.equal(many.cameos.length, S.MAX_CAMEOS);
  assert.equal(many.dropped, 3);
  // and cameos.js refuses the same things if handed them directly
  assert.ok(Cameos.importPhoto(tmp(), { id: 'x', png: Buffer.from('nope'), entry: {} }).error);
  assert.ok(Cameos.importPhoto(tmp(), { id: 'none', png: photo('neo'), entry: {} }).error);
  assert.ok(Cameos.importPhoto(tmp(), { id: 'x', png: big, entry: {} }).error);
});

test('replace: the file\'s rules, presets, settings and faces become the user\'s', () => {
  const theirs = exportFrom(sampleConfig({ routerPolicy: 'quality' }), cameoDir([['mum', 'saylor', 'Mum', 1]]));
  const state = { dir: cameoDir([['dad', 'neo', 'Dad', 1], ['neo', 'powell', 'My Neo', 2]]), config: { rules: [{ id: 'mine' }], presets: [{ id: 'q', name: 'Q', rules: [] }], routerPolicy: 'frugal', roam: true } };
  const plan = S.planImport(S.readSetup(JSON.stringify(theirs)), stateOf(state), 'replace');
  assert.deepEqual(plan.remove.sort(), ['dad', 'neo']);
  apply(plan, state);
  assert.deepEqual(Object.keys(Cameos.loadIndex(state.dir)), ['mum']);
  assert.deepEqual(state.config.rules, theirs.config.rules);
  assert.deepEqual(state.config.presets, theirs.config.presets);
  assert.equal(state.config.routerPolicy, 'quality');
  assert.equal(state.config.roam, true, 'settings outside a setup are untouched');
});

test('replace with a file that carries no faces keeps the user\'s faces', () => {
  const state = { dir: cameoDir([['dad', 'neo', 'Dad', 1]]), config: {} };
  imp({ v: 1, app: 'claude-traffic-light', rules: Rules.defaultRules() }, state, 'replace');
  assert.deepEqual(Object.keys(Cameos.loadIndex(state.dir)), ['dad']);
});

test('merge: adds presets and faces, keeps rules and settings, renames clashes and repoints presets at them', () => {
  const mineRules = [Rules.normalizeRule({ id: 'mine', name: 'Mine' })];
  const shared = [Rules.normalizeRule({ id: 's', then: { lamp: 'green' } })];
  const state = {
    dir: cameoDir([['dad', 'neo', 'My dad', 1], ['same', 'baker', 'Same', 2], ['neo', 'powell', 'My Neo', 3]]),
    config: { rules: mineRules, routerPolicy: 'frugal', presets: [{ id: 'p1', name: 'Shared', rules: shared }, { id: 'p2', name: 'Clash', rules: shared }] },
  };
  const theirs = {
    kind: S.KIND, v: 1, rulesVersion: Rules.RULES_VERSION,
    config: {
      rules: Rules.defaultRules(), routerPolicy: 'quality',
      presets: [
        { id: 'p1', name: 'shared', rules: shared }, // same as mine: skipped
        { id: 'p2', name: 'Clash', rules: [{ id: 'c', then: { cameo: 'dad' } }] }, // same name, different rules
        { id: 'p3', name: 'New', rules: [{ id: 'n', then: { cameo: 'mum' } }] },
      ],
    },
    cameos: [
      { id: 'dad', name: 'Their dad', png: photo('saylor').toString('base64') },
      { id: 'same', name: 'Same', png: photo('baker').toString('base64') },
      { id: 'neo', name: 'Their Neo', png: photo('mcafee').toString('base64') },
      { id: 'mum', name: 'Mum', png: photo('spagni').toString('base64') },
    ],
  };
  const plan = S.planImport(S.readSetup(JSON.stringify(theirs)), stateOf(state), 'merge');
  assert.deepEqual(Object.keys(plan.partial), ['presets'], 'rules and settings are not touched');
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.add.map((c) => c.id), ['dad-2', 'mum'], 'an identical face and a built-in I replaced are skipped');
  apply(plan, state);
  assert.deepEqual(state.config.rules, mineRules);
  assert.equal(state.config.routerPolicy, 'frugal');
  const idx = Cameos.loadIndex(state.dir);
  assert.deepEqual(Object.keys(idx).sort(), ['dad', 'dad-2', 'mum', 'neo', 'same']);
  assert.equal(idx.dad.name, 'My dad');
  assert.equal(idx['dad-2'].name, 'Their dad');
  assert.equal(idx.neo.name, 'My Neo');
  const ps = state.config.presets;
  assert.deepEqual(ps.map((x) => x.name), ['Shared', 'Clash', 'Clash 2', 'New']);
  assert.equal(new Set(ps.map((x) => x.id)).size, 4);
  assert.equal(ps[2].rules[0].then.cameo, 'dad-2', 'their preset follows their renamed face');
  assert.equal(ps[3].rules[0].then.cameo, 'mum');
  // merging the same file again adds nothing new
  const again = S.planImport(S.readSetup(JSON.stringify(theirs)), stateOf(state), 'merge');
  assert.deepEqual(again.add, []);
  assert.deepEqual(again.partial.presets, ps);
});

test('migration: a rules-only export from before rulesVersion gets the rules added since', () => {
  const old = Rules.defaultRules().filter((r) => r.id !== 'offline' && r.id !== 'failed-turn');
  const p = S.readSetup(JSON.stringify({ v: 1, app: 'claude-traffic-light', rules: old }));
  assert.equal(p.v, 0);
  assert.equal(p.rulesVersion, 0);
  const ids = p.config.rules.map((r) => r.id);
  assert.ok(ids.includes('offline') && ids.includes('failed-turn'));
  assert.ok(ids.indexOf('failed-turn') < ids.indexOf('done'));
  assert.deepEqual(Object.keys(p.config), ['rules']);
  assert.equal(p.hasCameos, false);
  assert.equal(S.summarize(p).old, true);
});

test('migration: a setup at an older rulesVersion is upgraded; a deleted default stays deleted at the current one', () => {
  const rules = Rules.defaultRules().filter((r) => r.id !== 'failed-turn');
  const at1 = S.readSetup(JSON.stringify({ kind: S.KIND, v: 1, rulesVersion: 1, config: { rules } }));
  assert.ok(at1.config.rules.some((r) => r.id === 'failed-turn'));
  const now = S.readSetup(JSON.stringify({ kind: S.KIND, v: 1, rulesVersion: Rules.RULES_VERSION, config: { rules } }));
  assert.ok(!now.config.rules.some((r) => r.id === 'failed-turn'));
  assert.equal(S.summarize(now).old, false);
});

test('summarize: counts, settings, and every command the file\'s clicks would run', () => {
  const b = exportFrom(sampleConfig(), cameoDir([['dad', 'neo', 'Dad', 1]]));
  b.config.presets[0].rules[0].then.clicks = { double: { type: 'shortcut', arg: 'Focus' }, click: { type: 'shell', arg: 'open -a Slack' } };
  const s = S.summarize(S.readSetup(JSON.stringify(b)));
  assert.equal(s.rules, Rules.defaultRules().length);
  assert.equal(s.presets, 1);
  assert.equal(s.cameos, 1);
  assert.deepEqual(s.settings.sort(), ['agentChipSize', 'agentKinds', 'agentRoster', 'routerDelegation', 'routerPolicy', 'routerProjects', 'showAgents']);
  assert.deepEqual(s.commands.sort(), ['Focus', 'open -a Slack']);
  assert.equal(s.dropped, 0);
});
