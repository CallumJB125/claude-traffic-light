// "Just me, building an app" versus "Developer / team". The first choice turns
// on simple mode: the same app with the team, rule fields, helper chips,
// session timers and token knobs out of sight, and Home trimmed to what needs
// you. Developer mode is the app as it always was. Pure; loaded by pages with
// a <script> tag and by main and tests with require.
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformSimple = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PERSONAS = Object.freeze({
    simple: Object.freeze({ id: 'simple', title: 'Just me, building an app', body: 'I ask Claude to build things for me. Keep it simple.' }),
    developer: Object.freeze({ id: 'developer', title: 'Developer / team', body: 'I write code, use several AI tools or work with a team. Show me everything.' }),
  });
  // The config patch a persona choice saves; null for anything else.
  function personaPatch(id) {
    if (id === 'simple') return { persona: 'simple', simpleMode: true };
    if (id === 'developer') return { persona: 'developer', simpleMode: false };
    return null;
  }
  const isSimple = (config) => !!config && config.simpleMode === true;

  // Home sections a simple-mode person sees; everything else on Home is hidden.
  const HOME_ESSENTIALS = Object.freeze(['banner', 'alerts', 'needs', 'running', 'today']);

  // What setup asks the person to paste into Claude Code. Harmless: it only
  // asks a question, so it starts a session without touching their files.
  const TEST_PROMPT = 'Say hello and tell me one fun fact about traffic lights. Do not change any files.';

  // Why the first session has not shown up yet, in words a non-programmer can
  // act on. rows: the setup view's tool rows ({id, label, connected}); missing:
  // tools not installed; session: the first session seen (or null); waitedMs:
  // how long step 2 has been waiting.
  function diagnose({ rows = [], missing = [], session = null, waitedMs = 0 } = {}) {
    if (session) return null;
    const list = Array.isArray(rows) ? rows : [];
    const claude = list.find((r) => r && r.id === 'claude');
    const connected = list.filter((r) => r && r.connected);
    if (!list.length) {
      return { kind: 'no-claude', title: 'Claude Code isn’t on this Mac yet', body: 'Install Claude Code first, then come back to this step. Plexiform listens to it once it is installed.', action: { label: 'How to install', destination: 'aitools' } };
    }
    if (!connected.length) {
      return { kind: 'not-connected', title: 'Plexiform isn’t connected yet', body: 'Go back one step and press Connect, so Plexiform can hear when Claude is busy or waiting.', action: { label: 'Back to connect', destination: 'back' } };
    }
    if (!claude || !claude.connected) {
      const names = connected.map((r) => r.label);
      return { kind: 'other-tool', title: `You’re connected to ${names.join(' and ')}`, body: `Claude Code isn’t connected, so run the test prompt in ${names[0]} instead, or go back and connect Claude Code.`, action: { label: 'Back to connect', destination: 'back' } };
    }
    if (waitedMs < 20000) return null;
    return { kind: 'restart', title: 'Restart Claude Code', body: 'Claude Code only picks up the note-taker when it starts. If it was already open, type /exit, press Return, then type claude again and paste the prompt.', action: { label: 'Check the connection', destination: 'aitools:claude' } };
  }
  // The sidebar in simple mode: the Team section keeps only the account page
  // (sign-in and plan), under that name; the team and integrations pages go.
  const TEAM_PAGES = Object.freeze(['team', 'integrations']);
  function sidebarSections(sections, simple) {
    if (!simple || !Array.isArray(sections)) return sections;
    return sections.map((s) => {
      if (!s || s.id !== 'team') return s;
      const pages = s.pages.filter((p) => !TEAM_PAGES.includes(p));
      return pages.length ? { ...s, title: 'Account', icon: 'gear', default: pages[0], pages } : null;
    }).filter(Boolean);
  }
  return { PERSONAS, personaPatch, isSimple, HOME_ESSENTIALS, TEST_PROMPT, diagnose, TEAM_PAGES, sidebarSections };
});
