'use strict';
// Vibe-coder friendliness: the persona fork, simple mode and the one colour key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/simple-mode.js');
const L = require('../src/colour-legend.js');
const T = require('../src/rule-templates.js');
const { SECTIONS, sectionsFor } = require('../buddy-window/pages');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('persona: "Just me" turns simple mode on, "Developer / team" off, anything else is refused', () => {
  assert.deepEqual(S.personaPatch('simple'), { persona: 'simple', simpleMode: true });
  assert.deepEqual(S.personaPatch('developer'), { persona: 'developer', simpleMode: false });
  for (const bad of [undefined, null, '', 'admin', 'Simple', {}, ['simple']]) assert.equal(S.personaPatch(bad), null);
  assert.equal(S.isSimple({ simpleMode: true }), true);
  assert.equal(S.isSimple({ simpleMode: 'yes' }), false);
  assert.equal(S.isSimple(null), false);
});

test('diagnose: names the reason a first session has not shown, with one fix', () => {
  const claude = (connected) => ({ id: 'claude', label: 'Claude Code', connected });
  const codex = (connected) => ({ id: 'codex', label: 'Codex', connected });
  assert.equal(S.diagnose({ rows: [claude(true)], session: { tool: 'claude' }, waitedMs: 1e6 }), null, 'a session means nothing is wrong');
  assert.equal(S.diagnose({ rows: [], waitedMs: 0 }).kind, 'no-claude');
  assert.equal(S.diagnose({ rows: [], waitedMs: 0 }).action.destination, 'aitools');
  assert.equal(S.diagnose({ rows: [claude(false), codex(false)] }).kind, 'not-connected');
  assert.equal(S.diagnose({ rows: [claude(false)] }).action.destination, 'back');
  const other = S.diagnose({ rows: [claude(false), codex(true)] });
  assert.equal(other.kind, 'other-tool');
  assert.match(other.body, /run the test prompt in Codex/);
  assert.equal(S.diagnose({ rows: [claude(true)], waitedMs: 5000 }), null, 'a connected Claude gets time to start first');
  const restart = S.diagnose({ rows: [claude(true)], waitedMs: 20000 });
  assert.equal(restart.kind, 'restart');
  assert.match(restart.body, /\/exit/);
  for (const d of [S.diagnose({ rows: [] }), other, restart]) assert.ok(!/hook|cwd|json|backup/i.test(`${d.title} ${d.body}`), `${d.kind} is plain words`);
  assert.ok(!/rm |sudo|curl|>/.test(S.TEST_PROMPT) && /Do not change any files/.test(S.TEST_PROMPT), 'the test prompt is harmless');
});

test('sidebar: simple mode keeps the account page but drops Team and Integrations; developer mode is unchanged', () => {
  const all = sectionsFor();
  assert.equal(S.sidebarSections(all, false), all);
  const simple = S.sidebarSections(all, true);
  const pages = simple.flatMap((s) => s.pages);
  assert.ok(!pages.includes('team') && !pages.includes('integrations'));
  assert.ok(pages.includes('account'));
  const account = simple.find((s) => s.id === 'team');
  assert.deepEqual([account.title, account.default], ['Account', 'account']);
  assert.equal(SECTIONS.find((s) => s.id === 'team').title, 'Team', 'the shared list is not mutated');
  assert.equal(simple.length, all.length);
});

test('colour key: one meaning per colour, stuck has its own glyph, and every place says the same', () => {
  const amber = L.LEGEND.filter((e) => e.colour === 'amber');
  assert.equal(new Set(L.LEGEND.map((e) => `${e.colour}${e.glyph}`)).size, L.LEGEND.length, 'no two entries look alike');
  assert.equal(L.byId('stuck').glyph, L.STUCK_GLYPH);
  assert.notEqual(L.byId('stuck').glyph, L.byId('your-turn').glyph);
  assert.equal(amber.length, 2);
  for (const c of ['green', 'red', 'off']) assert.equal(L.LEGEND.filter((e) => e.colour === c).length, 1, c);
  assert.equal(L.SENTENCE, 'Green = working · Amber = your turn · Amber ⌛ = gone quiet · Red = needs you now');
  assert.ok(read('onboarding.html').includes(`That's your widget. ${L.SENTENCE}.`));
  assert.ok(read('index.html').includes(`title="What does this mean? ${L.SENTENCE}"`), 'hovering the widget\'s ? shows the key');
  assert.ok(read('index.html').includes('id="stuck-mark"'));
  const help = read('help.html');
  for (const e of L.LEGEND) assert.ok(help.toLowerCase().includes(`${e.meaning.toLowerCase()}.`), `Help explains ${e.meaning}`);
  const tour = require('../src/first-run-tour.js').STEPS[0].body;
  assert.match(tour, /green working, amber your turn \(⌛ if it has gone quiet\), red needs you now/);
  assert.ok(!/red stuck|amber needs you|green = working, amber = needs you/i.test(`${read('onboarding.html')} ${tour} ${read('settings.html')}`), 'the old, clashing wording is gone');
  assert.deepEqual(L.menuItems().map((i) => i.enabled), L.LEGEND.map(() => false));
});

test('simple mode hides the developer knobs in Preferences and trims Home to the essentials', () => {
  const settings = read('settings.html');
  assert.match(settings, /body\.simple \.dev-only \{ display: none !important; \}/);
  const fieldOf = (id) => { const at = settings.indexOf(`id="${id}"`); assert.ok(at > 0, id); return settings.slice(settings.lastIndexOf('<div class="field', at), at); };
  for (const id of ['workingStaleMinutes', 'stuckMinutes', 'waitingStaleHours', 'showAgents', 'agentChipSize', 'spend-runaway-tokens', 'teamSessionSharing', 'agentMailInbox']) assert.ok(fieldOf(id).includes('dev-only'), `${id} hides in simple mode`);
  for (const id of ['simpleMode', 'sounds', 'spend-daily', 'spend-runaway-dollars']) assert.ok(!fieldOf(id).includes('dev-only'), `${id} stays visible`);
  const ids = [...read('home.html').matchAll(/<section id="([a-z]+)"/g)].map((m) => m[1]);
  const hidden = [...read('home.css').matchAll(/body\.simple #([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...ids.filter((id) => !S.HOME_ESSENTIALS.includes(id))].sort(), [...hidden].sort(), 'every non-essential Home section, and only those, hides');
  for (const id of S.HOME_ESSENTIALS) if (id !== 'banner') assert.ok(ids.includes(id), id);
});

test('Home tells the page whether simple mode is on', async () => {
  const handlers = {};
  let simple = false;
  require('../src/home-main.js').register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, allowed: () => true, state: () => ({ inputs: [], sessions: [] }), localSessions: (s) => s, tools: () => [], myDay: { snapshot: async () => null }, openPage() {}, openAiTools() {}, morning: () => null, simple: () => simple });
  assert.equal((await handlers['home:state']({})).simple, false);
  simple = true;
  assert.equal((await handlers['home:state']({})).simple, true);
});

test('wishes: the rule templates a simple-mode person sees, phrased as what they want', () => {
  const names = T.wishes().map((w) => w.name);
  assert.ok(names.includes('Ping my phone when Claude needs me'));
  assert.ok(names.includes('Chime when it’s done'));
  assert.equal(names[0], 'Chime when it’s done', 'the tour\'s last step points at the first wish');
  for (const w of T.wishes()) assert.ok(!/signal|cwd|glob|mcp__|regex/i.test(`${w.name} ${w.description}`), w.id);
  const lights = read('lights.html');
  assert.match(lights, /body\.simple:not\(\.customising\) #editor \{ display: none; \}/, 'the field editor sits behind Customise');
  assert.ok(lights.includes('id="customise-btn"'));
});
