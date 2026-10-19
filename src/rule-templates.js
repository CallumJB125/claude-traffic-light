// Starter rules for the Lights editor's "Start from a template" picker. Each
// is one ordinary rule (rules.js normalizes it unchanged), with a name and a
// one-line description. Applying one adds a fresh, unlocked copy with a new
// id; it never replaces a rule the user already has. Pure: no DOM, no I/O.
// Loaded by the Lights page with a <script> tag and by tests with require.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformRuleTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WORKING = ['prompt-submit', 'tool-use', 'tool-done', 'subagent-start', 'subagent-done'];
  // `wish: true` templates are phrased as things a person wants; simple mode
  // shows them as one-click buttons above the rule editor.
  const TEMPLATES = Object.freeze([
    {
      id: 'chime-done', wish: true, name: 'Chime when it\u2019s done',
      description: 'Plays the Glass sound each time Claude finishes and hands back to you.',
      rule: { name: 'Chime when done', when: { signal: ['stop'] }, then: { sound: 'Glass' } },
    },
    {
      id: 'ping-phone', wish: true, name: 'Ping my phone when Claude needs me',
      description: 'A question or permission request: a notification on your phone (and this Mac until a phone is paired).',
      rule: { name: 'Ping me when needed', when: { signal: ['permission-ask'] }, then: { notify: 'both' } },
    },
    {
      id: 'stuck', name: 'Tell me when a session is stuck',
      description: 'No progress from a working session for 15 minutes: dizzy eyes and a desktop notification.',
      rule: { name: 'Session looks stuck', when: { signal: WORKING, forMinutes: 15 }, then: { eyes: 'dizzy', pose: 'facepalm', notify: 'desktop' } },
    },
    {
      id: 'celebrate', wish: true, name: 'Celebrate when a task finishes',
      description: 'Confetti, a party pose and the Glass sound each time Claude finishes.',
      rule: { name: 'Celebrate finished tasks', when: { signal: ['stop'] }, then: { pose: 'party', screenFx: 'confetti', sound: 'Glass', celebrate: true } },
    },
    {
      id: 'ci-banner', name: 'Red banner when CI fails',
      description: 'A CI FAILED banner with red eyes, plus a desktop notification.',
      rule: { name: 'CI failed banner', when: { signal: ['ci-failed'] }, then: { pose: 'banner', text: 'CI FAILED', eyes: '#e2231a', notify: 'desktop' } },
    },
    {
      id: 'focus-quiet', name: 'Go quiet during focus hours',
      description: 'While your calendar or Focus says busy, Claude naps and this rule holds its pings.',
      rule: { name: 'Quiet while busy', when: { signal: ['busy'] }, then: { pose: 'sleep', eyes: 'sleepy', busyPing: 'never' } },
    },
    {
      id: 'waiting-5', name: 'Notify my phone when something waits on me over 5 minutes',
      description: 'A permission ask or a finished turn left for 5 minutes: a knock and a notification.',
      rule: { name: 'Waiting on me 5 minutes', when: { signal: ['permission-ask', 'idle-nudge', 'stop'], forMinutes: 5 }, then: { pose: 'knock', notify: 'both' } },
    },
    {
      id: 'ci-party', name: 'Party when CI passes',
      description: 'Green eyes and a party when CI goes green on your branch.',
      rule: { name: 'CI passed party', when: { signal: ['ci-passed', 'deploy-finished'] }, then: { pose: 'party', eyes: '#2fae3e', effect: 'fireworks' } },
    },
    {
      id: 'nap', wish: true, name: 'Dim when nothing is running',
      description: 'With no sessions open, Claude sleeps under the stars.',
      rule: { name: 'Nap when idle', when: { signal: ['idle'] }, then: { pose: 'sleep', eyes: 'sleepy', effect: 'stars' } },
    },
    {
      id: 'over-budget', name: 'Flag spending over budget',
      description: 'An OVER BUDGET banner with money eyes and a desktop notification.',
      rule: { name: 'Over budget flag', when: { signal: ['budget-exceeded', 'runaway'] }, then: { pose: 'banner', text: 'OVER BUDGET', eyes: 'money', notify: 'desktop' } },
    },
    {
      id: 'question-2', name: 'Nudge me when a question sits for 2 minutes',
      description: 'A permission ask unanswered for 2 minutes rings the Ping sound and notifies you.',
      rule: { name: 'Unanswered question', when: { signal: ['permission-ask'], forMinutes: 2 }, then: { pose: 'wave', sound: 'Ping', notify: 'desktop' } },
    },
  ]);

  function list() {
    return TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
  }
  const wishes = () => TEMPLATES.filter((t) => t.wish).map((t) => ({ id: t.id, name: t.name, description: t.description }));
  // A new rule from a template: a deep copy, enabled, unlocked, with the id
  // makeId() gives it. null for an unknown template.
  function instantiate(id, makeId) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return null;
    const rule = JSON.parse(JSON.stringify(t.rule));
    return { ...rule, id: makeId ? makeId() : `tpl-${t.id}-${Math.random().toString(36).slice(2, 8)}`, enabled: true, locked: false };
  }
  // Where a new rule goes: just under the locked rules, so its accents show
  // above the lamp owners (the same place "New rule" puts one).
  function insert(rules, rule) {
    const out = rules.slice();
    const at = out.findIndex((r) => !r.locked);
    out.splice(at < 0 ? out.length : at, 0, rule);
    return out;
  }
  return { TEMPLATES, list, wishes, instantiate, insert };
});
