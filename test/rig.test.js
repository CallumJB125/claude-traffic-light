const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Rules = require('../rules.js');

const ROOT = path.join(__dirname, '..');
const RIG_SRC = fs.readFileSync(path.join(ROOT, 'rig.js'), 'utf8');
const RIG_CSS = fs.readFileSync(path.join(ROOT, 'rig.css'), 'utf8');

// rig.js is a renderer <script>: it runs against a window, reads the bare
// timer/performance/Date globals, and draws garden crops with Math.random.
// Each mount gets its own window whose clock only moves when a test says so.
function mount() {
  const dom = new JSDOM('<!doctype html><div id="c"></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every: every ? Math.max(1, Number(ms) || 0) : 0 }); return id; };
  w.setTimeout = (fn, ms) => add(fn, ms, false);
  w.setInterval = (fn, ms) => add(fn, ms, true);
  w.clearTimeout = w.clearInterval = (id) => { timers.delete(id); };
  Object.defineProperty(w, 'performance', { value: { now: () => now }, configurable: true });
  const epoch = 1789040000000;
  w.Date.now = () => epoch + now;
  let rnd = 7;
  w.Math.random = () => { rnd = (rnd * 16807) % 2147483647; return (rnd - 1) / 2147483646; };
  w.eval(RIG_SRC);
  const rig = w.mountRig(w.document.getElementById('c'));
  const clock = {
    get now() { return now; },
    epoch,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
  return { w, rig, svg: rig.svg, clock, has: (c) => rig.svg.classList.contains(c) };
}

const classesWith = (svg, prefix) => [...svg.classList].filter((c) => c.startsWith(prefix));
const prop = (svg, name) => svg.style.getPropertyValue(name);
const onSlots = (svg) => [...svg.querySelectorAll('.lamp.on')].map((l) => l.dataset.slot).sort();

// ── Lamps and sign ────────────────────────────────────────────────────────
test('rig: a lit lamp turns on its own slot on every sign plus the single-lamp sign, in the slot colour', () => {
  const { svg, rig } = mount();
  rig.setLook({ lamp: 'amber' });
  assert.deepEqual(onSlots(svg), ['amber', 'amber', 'amber', 'any']);
  assert.equal(prop(svg, '--lamp-on'), '#f2a200');
  assert.equal(prop(svg, '--lamp-glow'), 'rgba(242, 162, 0, 0.85)');
});

test('rig: lamp off lights nothing and falls back to the off colour with no glow', () => {
  const { svg, rig } = mount();
  rig.setLook({ lamp: 'green' });
  rig.setLook({ lamp: 'off' });
  assert.deepEqual(onSlots(svg), []);
  assert.equal(prop(svg, '--lamp-on'), 'var(--lamp-off)');
  assert.equal(prop(svg, '--lamp-glow'), 'transparent');
});

test('rig: only a plain green lamp pulses; a rule colour or effect stops the pulse', () => {
  const { svg, rig } = mount();
  rig.setLook({ lamp: 'green' });
  assert.equal(svg.querySelectorAll('.lamp.pulse').length, 4);
  rig.setLook({ lamp: 'green', lampColor: '#123456' });
  assert.equal(svg.querySelectorAll('.lamp.pulse').length, 0);
  assert.equal(prop(svg, '--lamp-on'), '#123456');
  rig.setLook({ lamp: 'green', lampFx: 'strobe' });
  assert.equal(svg.querySelectorAll('.lamp.pulse').length, 0);
  assert.ok(svg.classList.contains('lampfx-strobe'));
});

test('rig: group lamp effects light every lamp even with no lamp state, and swap cleanly', () => {
  const { svg, rig } = mount();
  rig.setLook({ lamp: 'off', lampFx: 'chase' });
  assert.equal(svg.querySelectorAll('.lamp.on').length, svg.querySelectorAll('.lamp').length);
  rig.setLook({ lamp: 'off', lampFx: 'police' });
  assert.deepEqual(classesWith(svg, 'lampfx-'), ['lampfx-police']);
  rig.setLook({ lamp: 'off', lampFx: 'bogus' });
  assert.deepEqual(classesWith(svg, 'lampfx-'), []);
});

test('rig: exactly one sign class is set; an unknown sign falls back to h3', () => {
  const { svg, rig } = mount();
  rig.setLook({ sign: 'v3' });
  assert.deepEqual(classesWith(svg, 'sign-'), ['sign-v3']);
  rig.setLook({ sign: 'nope' });
  assert.deepEqual(classesWith(svg, 'sign-'), ['sign-h3']);
});

test('rig: lamp shape swaps every lamp symbol; an unknown shape is square', () => {
  const { svg, rig } = mount();
  rig.setLook({ lampShape: 'heart' });
  assert.ok([...svg.querySelectorAll('.lamp')].every((l) => l.getAttribute('href') === '#lamp-heart'));
  rig.setLook({ lampShape: 'triangle' });
  assert.ok([...svg.querySelectorAll('.lamp')].every((l) => l.getAttribute('href') === '#lamp-square'));
});

test('rig: sign fx is a single class and none clears it', () => {
  const { svg, rig } = mount();
  rig.setLook({ signFx: 'wobble' });
  rig.setLook({ signFx: 'neon' });
  assert.deepEqual(classesWith(svg, 'signfx-'), ['signfx-neon']);
  rig.setLook({ signFx: 'none' });
  assert.deepEqual(classesWith(svg, 'signfx-'), []);
});

test('rig: number mode shows the digit and hides the lamps; null leaves number mode', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ number: 0 });
  assert.equal(svg.querySelector('.sign-number').textContent, '0');
  assert.ok(has('number-mode'), 'zero is a number, not "no number"');
  rig.setLook({ number: null });
  assert.equal(svg.querySelector('.sign-number').textContent, '');
  assert.ok(!has('number-mode'));
});

// ── Pose, eyes, body, costume ─────────────────────────────────────────────
test('rig: exactly one pose class; switching replaces it and an unknown pose clears it', () => {
  const { svg, rig } = mount();
  rig.setLook({ pose: 'think' });
  assert.deepEqual(classesWith(svg, 'pose-'), ['pose-think']);
  rig.setLook({ pose: 'wave' });
  assert.deepEqual(classesWith(svg, 'pose-'), ['pose-wave']);
  rig.setLook({ pose: 'moonwalk' });
  assert.deepEqual(classesWith(svg, 'pose-'), []);
});

test('rig: re-sending the same pose does not restart its schedule (no stutter on every poll)', () => {
  const { rig, clock, has } = mount();
  rig.setLook({ pose: 'kickflip' });
  assert.ok(has('flip'), 'first flip plays at once');
  clock.advance(2000);
  assert.ok(!has('flip'));
  rig.setLook({ pose: 'kickflip', eyes: 'happy' });
  assert.ok(!has('flip'), 'a poll with the same pose must not flip again');
  clock.advance(28000);
  assert.ok(has('flip'), 'the 30 s schedule from the first flip still holds');
});

test('rig: leaving kickflip or line stops their timers', () => {
  const { rig, clock, has } = mount();
  rig.setLook({ pose: 'line' });
  assert.ok(has('rail'));
  rig.setLook({ pose: 'none' });
  assert.ok(!has('rail'));
  clock.advance(120000);
  assert.ok(!has('rail') && !has('flip'));
});

test('rig: eyes set one mood class or closed, and the eye colour channel', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ eyes: 'heart' });
  assert.deepEqual(classesWith(svg, 'eyes-'), ['eyes-heart']);
  rig.setLook({ eyes: 'closed' });
  assert.deepEqual(classesWith(svg, 'eyes-'), ['eyes-closed']);
  rig.setLook({ eyes: '#8b5cf6' });
  assert.deepEqual(classesWith(svg, 'eyes-'), []);
  assert.equal(prop(svg, '--eye-color'), '#8b5cf6');
  rig.setLook({ eyes: 'laser' });
  assert.equal(prop(svg, '--eye-color'), '#ff3b30');
  rig.setLook({});
  assert.equal(prop(svg, '--eye-color'), '#211f1c');
  assert.ok(!has('eyes-laser'));
});

test('rig: body, body colour, effect and pet are each a single validated class', () => {
  const { svg, rig } = mount();
  rig.setLook({ body: 'robot', bodyColor: '#00ff00', effect: 'rain', pet: 'duck' });
  assert.deepEqual(classesWith(svg, 'body-'), ['body-robot']);
  assert.equal(prop(svg, '--body-color'), '#00ff00');
  assert.deepEqual(classesWith(svg, 'effect-'), ['effect-rain']);
  assert.deepEqual(classesWith(svg, 'pet-'), ['pet-duck']);
  rig.setLook({ body: 'dragon', bodyColor: 'red', effect: 'lava', pet: 'rock' });
  assert.deepEqual(classesWith(svg, 'body-'), ['body-claude']);
  assert.equal(prop(svg, '--body-color'), '#da7756');
  assert.deepEqual(classesWith(svg, 'effect-'), ['effect-none']);
  assert.deepEqual(classesWith(svg, 'pet-'), ['pet-none']);
});

test('rig: beard length follows wait minutes, clamped to 0–30', () => {
  const { svg, rig } = mount();
  rig.setLook({ waitMinutes: 15 });
  assert.ok(Math.abs(Number(prop(svg, '--beard')) - 1.4) < 1e-9);
  rig.setLook({ waitMinutes: 999 });
  assert.equal(Number(prop(svg, '--beard')), 2.5);
  rig.setLook({ waitMinutes: -5 });
  assert.equal(Number(prop(svg, '--beard')), 0.3);
});

test('rig: costume is one class, independent of the pose', () => {
  const { svg, rig } = mount();
  rig.setLook({ costume: 'wizard', pose: 'think' });
  rig.setLook({ costume: 'crown', pose: 'think' });
  assert.deepEqual(classesWith(svg, 'costume-'), ['costume-crown']);
  rig.setLook({ costume: 'crown', pose: 'wave' });
  assert.deepEqual(classesWith(svg, 'costume-'), ['costume-crown']);
  rig.setLook({ costume: 'nope' });
  assert.deepEqual(classesWith(svg, 'costume-'), []);
});

test('rig: banner and bubble text are upper-cased and capped; tasks label only with created tasks', () => {
  const { svg, rig } = mount();
  rig.setLook({});
  assert.equal(svg.querySelector('.banner-text').textContent, 'INPUT NEEDED');
  assert.equal(svg.querySelector('.bubble-text').textContent, 'BRB');
  rig.setLook({ text: 'a very long banner text that overflows', tasks: { created: 4, done: 1 } });
  assert.equal(svg.querySelector('.banner-text').textContent, 'A VERY LONG BANNER TEXT ');
  assert.equal(svg.querySelector('.bubble-text').textContent, 'A VERY LONG ');
  assert.equal(svg.querySelector('.tasks-label').textContent, '1/4');
  rig.setLook({ tasks: { created: 0, done: 0 } });
  assert.equal(svg.querySelector('.tasks-label').textContent, '');
});

test('rig: facing left mirrors the gun aim, which is clamped to ±35°', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ aimAngle: 80 });
  assert.equal(prop(svg, '--aim'), '35deg');
  rig.setLook({ aimAngle: 20, facing: 'left' });
  assert.equal(prop(svg, '--aim'), '-20deg');
  assert.ok(has('face-left'));
  rig.setLook({ aimAngle: 'x' });
  assert.equal(prop(svg, '--aim'), '0deg');
});

// ── Cameos ────────────────────────────────────────────────────────────────
test('rig: a drawn cameo is a class; neo also hides the eyes, others do not', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ cameo: 'neo' });
  assert.deepEqual(classesWith(svg, 'cameo-'), ['cameo-neo', 'cameo-hides-eyes']);
  rig.setLook({ cameo: 'alfred' });
  assert.deepEqual(classesWith(svg, 'cameo-'), ['cameo-alfred']);
  assert.ok(!has('has-photo'));
});

test('rig: an unknown or malformed cameo id renders no cameo at all', () => {
  const { svg, rig } = mount();
  rig.setLook({ cameo: 'someone-removed' });
  assert.deepEqual(classesWith(svg, 'cameo-'), []);
  rig.setLook({ cameo: '../etc/passwd' });
  assert.deepEqual(classesWith(svg, 'cameo-'), []);
  assert.equal(rig.look.cameo, 'none');
});

const PHOTO = { id: 'me', rev: 1, src: 'data:image/png;base64,AAAA', eyes: { x: 0.5, y: 0.4 }, mouth: { x: 0.5, y: 0.75 } };

test('rig: a photo cameo on the look wears the photo and maps its eye/mouth/hat anchors into the head box', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ cameo: 'me', cameoPhoto: PHOTO });
  assert.ok(has('has-photo'));
  assert.equal(svg.querySelector('.cameo-photo-img').getAttribute('href'), PHOTO.src);
  assert.deepEqual(classesWith(svg, 'cameo-'), [], 'no drawn cameo under a photo');
  // Head box (17,30) size 30: eyes land at (32,42), mouth at (32,52.5), a
  // 10.5 gap → scale 10.5·0.95/15.5; the hat line is clamped to the box top.
  assert.equal(prop(svg, '--eye-dx'), '0.00px');
  assert.equal(prop(svg, '--eye-dy'), '-3.75px');
  assert.equal(prop(svg, '--eye-s'), '0.644');
  assert.equal(prop(svg, '--mouth-dy'), '2.50px');
  assert.equal(prop(svg, '--mouth-s'), '0.804');
  assert.equal(prop(svg, '--hat-dy'), '-8.00px');
  assert.equal(prop(svg, '--chin-dy'), '1.85px');
});

test('rig: photo anchors are clamped for a squashed face and default when missing', () => {
  const { svg, rig } = mount();
  rig.setLook({ cameo: 'me', cameoPhoto: { ...PHOTO, eyes: { x: 2, y: 0 }, mouth: { x: 0.5, y: 0 } } });
  assert.equal(prop(svg, '--eye-s'), '0.400', 'tiny eye-mouth gap floors the scale');
  assert.equal(prop(svg, '--eye-dx'), '15.00px', 'x clamped to the right edge of the box');
  rig.setLook({ cameo: 'me', cameoPhoto: { id: 'me', rev: 2, src: PHOTO.src } });
  assert.equal(prop(svg, '--eye-dy'), '-3.75px', 'no anchors → the default 0.4/0.75');
});

test('rig: a built-in id with a registered photo shows the photo instead of the drawing', () => {
  const { w, svg, rig, has } = mount();
  w.rigSetCameoPhotos([{ id: 'neo', rev: 3, src: 'data:image/png;base64,BBBB' }, { id: 'Bad Id', src: 'x' }]);
  rig.setLook({ cameo: 'neo' });
  assert.ok(has('has-photo'));
  assert.ok(!has('cameo-neo') && !has('cameo-hides-eyes'), 'the photo replaces the drawing and its eye-hiding');
  assert.equal(svg.querySelector('.cameo-photo-img').getAttribute('href'), 'data:image/png;base64,BBBB');
});

test('rig: switching off a photo cameo removes the photo; a new rev re-wears it', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ cameo: 'me', cameoPhoto: PHOTO });
  rig.setLook({ cameo: 'me', cameoPhoto: { ...PHOTO, rev: 2, eyes: { x: 0.25, y: 0.4 } } });
  assert.equal(prop(svg, '--eye-dx'), '-7.50px', 'a changed photo rev re-applies anchors');
  rig.setLook({ cameo: 'none' });
  assert.ok(!has('has-photo'));
  assert.equal(svg.querySelector('.cameo-photo-img').getAttribute('href'), null);
});

test('rig: a cameoPhoto for a different id is ignored', () => {
  const { rig, has } = mount();
  rig.setLook({ cameo: 'alfred', cameoPhoto: PHOTO });
  assert.ok(has('cameo-alfred') && !has('has-photo'));
});

// ── Minions ───────────────────────────────────────────────────────────────
const agents = (n, status = 'working', since = null) => Array.from({ length: n }, (_, i) => ({ name: `agent${i}`, status: Array.isArray(status) ? status[i % status.length] : status, since }));
const chips = (svg) => [...svg.querySelectorAll('.minions .minion')];
const more = (svg) => svg.querySelector('.minions .minion-more')?.textContent || null;
const fillOf = (chip) => chip.querySelector('.minion-in').firstElementChild.getAttribute('fill');

test('minions: one chip per agent with its name, status class and status colour', () => {
  const { svg, rig } = mount();
  rig.setLook({ minions: agents(3, ['working', 'waiting', 'done']) });
  const c = chips(svg);
  assert.deepEqual(c.map((x) => x.dataset.name), ['agent0', 'agent1', 'agent2']);
  assert.deepEqual(c.map((x) => x.getAttribute('class')), ['minion minion-working', 'minion minion-waiting', 'minion minion-done']);
  assert.deepEqual(c.map(fillOf), ['#2fae3e', '#f2a200', '#726c62']);
  assert.equal(more(svg), null);
});

test('minions: a custom colour only recolours working chips', () => {
  const { svg, rig } = mount();
  rig.setLook({ minions: agents(2, ['working', 'waiting']), agentsColor: '#123abc' });
  assert.deepEqual(chips(svg).map(fillOf), ['#123abc', '#f2a200']);
  rig.setLook({ minions: agents(2, ['working', 'waiting']), agentsColor: 'blue' });
  assert.deepEqual(chips(svg).map(fillOf), ['#2fae3e', '#f2a200'], 'an invalid colour is ignored');
});

for (const [size, max] of [['small', 7], ['normal', 5], ['large', 4], [undefined, 5], ['huge', 5]]) {
  test(`minions: chip size ${size} shows ${max} chips at most, the rest folded into +N`, () => {
    const { svg, rig } = mount();
    rig.setLook({ minions: agents(max), agentChipSize: size });
    assert.equal(chips(svg).length, max);
    assert.equal(more(svg), null);
    rig.setLook({ minions: agents(12), agentChipSize: size });
    assert.equal(chips(svg).length, max - 1);
    assert.equal(more(svg), `+${12 - (max - 1)}`);
  });
}

test('minions: every chip (and the +N) stays inside the 64×82 viewBox at every size', () => {
  for (const size of ['small', 'normal', 'large']) {
    const { svg, rig } = mount();
    rig.setLook({ minions: agents(20), agentChipSize: size });
    for (const c of chips(svg)) {
      const [, x, y, s] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(c.getAttribute('transform')).map(Number);
      assert.ok(x >= 0 && x + 6.9 * s <= 64, `${size}: chip x ${x} out of the view`);
      assert.ok(y >= 0 && y + 7.5 * s <= 82, `${size}: chip y ${y} out of the view`);
    }
    const plus = Number(svg.querySelector('.minion-more').getAttribute('x'));
    assert.ok(plus > 0 && plus < 64, `${size}: +N at ${plus}`);
  }
});

test('minions: the agent style picks the sprite; an unknown style is the robot', () => {
  const { svg, rig } = mount();
  const tags = () => [...chips(svg)[0].querySelector('.minion-in').children].map((e) => e.tagName).join(',');
  rig.setLook({ minions: agents(1), agents: 'dot' });
  assert.equal(tags(), 'circle');
  rig.setLook({ minions: agents(1), agents: 'duck' });
  assert.equal(tags(), 'ellipse,circle,path,circle');
  rig.setLook({ minions: agents(1), agents: 'kraken' });
  assert.equal(tags(), 'rect,rect,rect,rect,rect,rect');
});

test('minions: no agents clears the row and the roster', () => {
  const { svg, rig } = mount();
  rig.setLook({ minions: agents(3), showRoster: true });
  rig.setLook({ minions: [], showRoster: true });
  assert.equal(svg.querySelector('.minions').children.length, 0);
  assert.equal(svg.querySelector('.agents-label').children.length, 0);
});

test('minions: the roster lists at most five agents, upper-cased and cut to 11, then +N MORE', () => {
  const { svg, rig } = mount();
  rig.setLook({ minions: [{ name: 'oh-my-executor-long', status: 'working' }, ...agents(6)], showRoster: true });
  const names = [...svg.querySelectorAll('.agents-label .agent-line:not(.agent-time):not(.agent-more)')].map((t) => t.textContent);
  assert.deepEqual(names, ['OH-MY-EXECU', 'AGENT0', 'AGENT1', 'AGENT2', 'AGENT3']);
  assert.equal(svg.querySelector('.agents-label .agent-more').textContent, '+2 MORE');
  rig.setLook({ minions: agents(2), showRoster: false });
  assert.equal(svg.querySelector('.agents-label').children.length, 0, 'the roster only shows while hovering');
});

test('minions: an unchanged row is not redrawn; a status change is', () => {
  const { svg, rig } = mount();
  rig.setLook({ minions: agents(2) });
  const first = chips(svg)[0];
  rig.setLook({ minions: agents(2), pose: 'think' });
  assert.equal(chips(svg)[0], first, 'same agents → same nodes');
  rig.setLook({ minions: agents(2, ['working', 'waiting']) });
  assert.notEqual(chips(svg)[0], first);
  assert.equal(chips(svg)[1].dataset.status, 'waiting');
});

test('minions: elapsed time ticks by the second under a minute, then by the minute', () => {
  const { svg, rig, clock } = mount();
  const since = (agoMs) => new Date(clock.epoch + clock.now - agoMs).toISOString();
  rig.setLook({ minions: [{ name: 'a', status: 'working', since: since(30000) }] });
  const first = chips(svg)[0];
  assert.match(first.querySelector('title').textContent, /^a — working \(30s\)$/);
  const s0 = since(30000);
  clock.advance(400);
  rig.setLook({ minions: [{ name: 'a', status: 'working', since: s0 }] });
  assert.equal(chips(svg)[0], first, 'same second → no redraw');
  clock.advance(700);
  rig.setLook({ minions: [{ name: 'a', status: 'working', since: s0 }] });
  assert.notEqual(chips(svg)[0], first, 'next second → redraw');
  const s1 = since(5 * 60000);
  rig.setLook({ minions: [{ name: 'a', status: 'working', since: s1 }] });
  const m = chips(svg)[0];
  clock.advance(20000);
  rig.setLook({ minions: [{ name: 'a', status: 'working', since: s1 }] });
  assert.equal(chips(svg)[0], m, 'a 2 s poll within the same minute leaves the row alone');
});

test('minions: the app’s agentKinds filter decides which agents get chips', () => {
  const { svg, rig } = mount();
  const sessions = [{ cwd: '/p', agents: [
    { id: 's1', name: 'explore', kind: 'subagent', status: 'working' },
    { id: 't1', name: 'writer', kind: 'teammate', status: 'waiting' },
    { id: 't2', name: 'old', kind: 'teammate', status: 'done' },
    { id: 'r1', name: 'loop', kind: 'ralph', status: 'working' },
  ] }];
  rig.setLook({ minions: Rules.filterAgentKinds(Rules.liveAgents(sessions), { subagent: true, teammate: false, ralph: true }) });
  assert.deepEqual(chips(svg).map((c) => c.dataset.name), ['explore', 'loop']);
  rig.setLook({ minions: Rules.filterAgentKinds(Rules.liveAgents(sessions), { subagent: false }) });
  assert.deepEqual(chips(svg).map((c) => c.dataset.name), ['writer', 'loop'], 'a kind missing from the config counts as on; done agents never show');
});

// ── Click-through: what index.html's hit test relies on ──────────────────
test('hit test: the elements index.html probes for are there and clickable', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /el\.closest\('#gear, #help, #ask, \.minion'\)/, 'index.html hit test changed — update this test');
  assert.match(html, /el\.closest\('svg\.rig'\)/);
  assert.match(html, /closest\('\.pet'\)/);
  const { svg, rig } = mount();
  rig.setLook({ minions: agents(2), pet: 'duck' });
  assert.equal(svg.tagName.toLowerCase(), 'svg');
  assert.ok(svg.matches('svg.rig'), 'the hit test looks for svg.rig');
  const shape = chips(svg)[0].querySelector('.minion-in').firstElementChild;
  assert.equal(shape.closest('.minion'), chips(svg)[0], 'clicking any sprite part resolves to its chip');
  assert.equal(shape.closest('svg.rig'), svg);
  assert.match(chips(svg)[0].getAttribute('style'), /pointer-events:auto/, 'chips take clicks through a click-through window');
  const petPart = svg.querySelector('.pet-duck > *');
  assert.ok(petPart.closest('.pet'), 'pet parts resolve to .pet for pokePet');
  assert.ok(svg.querySelector('.claude-body rect').closest('svg.rig'), 'the body is hittable');
});

// ── One-shots: react, events, flash, burst, pet, confetti ─────────────────
test('react: a patch shows for its time then the look returns, keeping aim/facing changed meanwhile', () => {
  const { svg, rig, clock, has } = mount();
  rig.setLook({ pose: 'think', eyes: 'default' });
  rig.react({ eyes: 'heart', pose: 'wave' }, 1000);
  assert.ok(has('eyes-heart') && has('pose-wave'));
  rig.setLook({ ...rig.look, aimAngle: 10, facing: 'left' });
  clock.advance(1000);
  assert.ok(!has('eyes-heart'));
  assert.deepEqual(classesWith(svg, 'pose-'), ['pose-think']);
  assert.equal(rig.look.facing, 'left');
  assert.equal(prop(svg, '--aim'), '-10deg');
});

test('react: without a look yet it does nothing', () => {
  const { rig } = mount();
  rig.react({ eyes: 'heart' });
  assert.equal(rig.look, null);
});

test('playEvent: plays one known event at a time and clears it after its time', () => {
  const { svg, rig, clock, has } = mount();
  rig.playEvent('volcano');
  assert.deepEqual(classesWith(svg, 'event-'), []);
  rig.playEvent('ufo', 1000);
  clock.advance(500);
  rig.playEvent('meteor', 1000);
  assert.deepEqual(classesWith(svg, 'event-'), ['event-meteor']);
  clock.advance(999);
  assert.ok(has('event-meteor'), 'the earlier event’s timer must not clear the new one');
  clock.advance(1);
  assert.deepEqual(classesWith(svg, 'event-'), []);
});

test('flash, burst and pokePet are timed classes; pokePet needs a pet', () => {
  const { rig, clock, has } = mount();
  rig.flash(600); rig.burst(1200);
  assert.ok(has('sound-flash') && has('firing'));
  clock.advance(600);
  assert.ok(!has('sound-flash') && has('firing'));
  clock.advance(600);
  assert.ok(!has('firing'));
  assert.equal(rig.pokePet(), false, 'no look');
  rig.setLook({ pet: 'none' });
  assert.equal(rig.pokePet(), false);
  rig.setLook({ pet: 'frog' });
  assert.equal(rig.pokePet(), true);
  assert.ok(has('pet-react'));
  clock.advance(1500);
  assert.ok(!has('pet-react'));
});

test('celebrate bursts every confetti piece', () => {
  const { svg, rig } = mount();
  rig.celebrate();
  const pieces = [...svg.querySelectorAll('.confetti')];
  assert.equal(pieces.length, 6);
  assert.ok(pieces.every((p) => p.classList.contains('burst')));
});

// ── Garden ────────────────────────────────────────────────────────────────
// At 30x: fetch 4 s, plant 6 s, grow 4 s, a bite every 667 ms, rotate 20 s.
const phase = (svg) => classesWith(svg, 'phase-');
test('garden: turning it on widens the view and starts fetching pots', () => {
  const { svg, rig, has } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  assert.equal(svg.getAttribute('viewBox'), '-64 0 192 82');
  assert.ok(has('gardening'));
  assert.deepEqual(phase(svg), ['phase-fetch']);
  assert.ok(svg.querySelector('.garden .bed'));
  assert.equal(svg.querySelectorAll('.garden .pot').length, 0);
});

test('garden: every fetch trip leaves its pot before the next trip, even at preview speed', () => {
  const { svg, rig, clock, has } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  clock.advance(500);
  assert.ok(has('carrying'), 'second half of each trip carries a pot');
  // Five 800 ms trips; each drop is a 120 ms window the 250 ms tick can miss.
  for (let k = 1; k <= 4; k += 1) {
    clock.advance(800 * k + 500 - clock.now);
    assert.deepEqual(phase(svg), ['phase-fetch']);
    assert.ok(svg.querySelectorAll('.garden .pot').length >= k, `trip ${k} left no pot by ${clock.now} ms`);
  }
  clock.advance(4250 - clock.now);
  assert.equal(svg.querySelectorAll('.garden .pot').length, 5);
});

test('garden: plant fills, seeds and waters every pot, then grow matures crops', () => {
  const { svg, rig, clock } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  clock.advance(4000 + 3000);
  assert.deepEqual(phase(svg), ['phase-plant']);
  clock.advance(3100);
  assert.deepEqual(phase(svg), ['phase-grow']);
  const pots = [...svg.querySelectorAll('.garden .pot')];
  assert.equal(pots.length, 5);
  assert.ok(pots.every((p) => ['has-dirt', 'has-seed', 'watered'].every((c) => p.classList.contains(c))));
  assert.ok(pots.every((p) => p.querySelector('.sprout .crop')), 'every pot has a crop drawn');
  clock.advance(4000);
  assert.ok(pots.every((p) => p.classList.contains('mature') && p.style.getPropertyValue('--growth') === '1'));
});

test('garden: mature crops get eaten one bite at a time, then rotate and regrow', () => {
  const { svg, rig, clock } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  clock.advance(14000 + 2000);
  const eaten = svg.querySelectorAll('.garden .bite.eaten').length;
  assert.ok(eaten >= 1, 'something was eaten');
  clock.advance(20000);
  const pots = [...svg.querySelectorAll('.garden .pot')];
  assert.ok(pots.some((p) => !p.classList.contains('mature')), 'rotation pulls the crops');
  assert.equal(pots.length, 5, 'rotation keeps the pots');
});

test('garden: turning it off clears pots, classes and timers and restores the view', () => {
  const { svg, rig, clock, has } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  clock.advance(15000);
  rig.setLook({ effect: 'none' });
  assert.equal(svg.getAttribute('viewBox'), '0 0 64 82');
  assert.equal(svg.querySelector('.garden').children.length, 0);
  for (const c of ['gardening', 'phase-fetch', 'phase-plant', 'phase-grow', 'carrying', 'pouring', 'watering']) assert.ok(!has(c), c);
  clock.advance(60000);
  assert.equal(svg.querySelector('.garden').children.length, 0, 'no tick survives the stop');
  assert.ok(!has('eating'), 'a pending bite does not fire after the stop');
});

test('garden: re-sending the garden look does not restart it', () => {
  const { svg, rig, clock } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30 });
  clock.advance(4000);
  rig.setLook({ effect: 'garden', gardenSpeed: 30, pose: 'think' });
  assert.equal(svg.querySelectorAll('.garden .pot').length, 5);
  assert.deepEqual(phase(svg), ['phase-plant']);
});

// ── Reduced motion ────────────────────────────────────────────────────────
// Parsed from rig.css: every element any rule animates must be stopped by the
// prefers-reduced-motion block, and a finite animation with a fill must have
// its un-animated values equal to where it ends, so reduced motion lands on
// the end state.
function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const keyframes = {};
  let reduced = null;
  let i = 0;
  const block = (from) => { let d = 0; for (let j = from; j < src.length; j += 1) { if (src[j] === '{') d += 1; else if (src[j] === '}') { d -= 1; if (d === 0) return j; } } return src.length; };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    const close = block(open);
    const body = src.slice(open + 1, close);
    if (head.startsWith('@keyframes')) {
      const frames = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ at: m[1].trim(), decls: m[2] }));
      keyframes[head.split(/\s+/)[1]] = frames;
    } else if (head.startsWith('@media') && /prefers-reduced-motion/.test(head)) {
      reduced = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), decls: m[2] }));
    } else if (!head.startsWith('@')) {
      rules.push({ selectors: head.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean), decls: body });
    }
    i = close + 1;
  }
  return { rules, keyframes, reduced };
}
const decl = (decls, name) => { const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(decls); return m ? m[1].trim() : null; };

// The cigarette burning down over five minutes is a clock, not motion.
const SLOW_CLOCKS = ['.cig-paper', '.cig-tip'];
test('reduced motion: every animated element in the rig is stopped by the reduced-motion block', () => {
  const { rules, reduced } = parseCss(RIG_CSS);
  assert.ok(reduced, 'rig.css has a prefers-reduced-motion block');
  const stoppers = reduced.filter((r) => /animation\s*:\s*none/.test(r.decls)).flatMap((r) => r.selectors);
  // Build every element a rule can animate: the static rig, chips of each
  // status, and a garden grown to crops with its tools out.
  const { w, svg, rig, clock } = mount();
  rig.setLook({ effect: 'garden', gardenSpeed: 30, minions: agents(3, ['working', 'waiting', 'done']) });
  clock.advance(14500);
  const escaped = [];
  for (const r of rules) {
    const anim = decl(r.decls, 'animation') || decl(r.decls, 'animation-name');
    if (!anim || anim === 'none') continue;
    for (const sel of r.selectors) {
      // Turn on the state the selector needs on the rig itself (.rig.pose-x…).
      const lead = /^\.rig((?:\.[\w-]+)*)/.exec(sel);
      const state = lead ? (lead[1].match(/[\w-]+/g) || []) : [];
      const before = new Set(svg.classList);
      for (const c of state) svg.classList.add(c);
      // From the document: nwsapi drops matches whose first compound is the
      // scope element itself when asked through svg.querySelectorAll.
      const targets = sel === lead?.[0] ? [svg] : [...w.document.querySelectorAll(sel)];
      for (const el of targets) if (!SLOW_CLOCKS.some((s) => el.matches(s)) && !stoppers.some((s) => el.matches(s))) escaped.push(`${sel} → <${el.tagName} class="${el.getAttribute('class') || ''}">`);
      for (const c of state) if (!before.has(c)) svg.classList.remove(c);
    }
  }
  assert.deepEqual([...new Set(escaped)], [], 'these keep animating under prefers-reduced-motion');
});

test('reduced motion: a finite animation’s un-animated transform/opacity is its end frame', () => {
  const { rules, keyframes } = parseCss(RIG_CSS);
  const norm = (v) => v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s*!important/, '').replace(/scale\(([\d.]+), \1\)/g, 'scale($1)').trim();
  const checked = [];
  const wrong = [];
  for (const r of rules) {
    const anim = decl(r.decls, 'animation');
    if (!anim) continue;
    const first = anim.split(/,(?![^(]*\))/)[0].trim();
    if (/infinite/.test(first) || !/\b(both|forwards)\b/.test(first)) continue;
    const frames = keyframes[first.split(/\s+/)[0]];
    if (!frames) continue;
    for (const p of ['transform', 'opacity']) {
      const still = decl(r.decls, p);
      if (!still) continue;
      const last = [...frames].reverse().find((f) => /(^|,)\s*(100%|to)\s*(,|$)/.test(f.at) && decl(f.decls, p) != null);
      if (!last) continue;
      checked.push(`${r.selectors[0]} ${p}`);
      if (norm(decl(last.decls, p)) !== norm(still)) wrong.push(`${r.selectors[0]}: ${p} ${still} but ends at ${decl(last.decls, p)}`);
    }
  }
  assert.ok(checked.length >= 5, `expected to check the zyn/juice end states, checked ${checked.length}`);
  assert.deepEqual(wrong, []);
});
