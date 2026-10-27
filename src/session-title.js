'use strict';
// The row title rules (plan-organised-views §2.3 item 7), shared by the row
// view model (session-row.js) and, from R2, the chat-first sidebar. A leaf:
// it requires nothing, so a sidebar that projects session-row has no cycle.
// overview-sidebar-rows.js imports these (R2a); session-row.test.js pins one copy.
const AI = Object.freeze({ claude: 'Claude', 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', copilot: 'Copilot', opencode: 'OpenCode' });
// Overview's placeholders when no project was reported: not a project name.
const NO_PROJECT = Object.freeze(new Set(['Other work', 'Project not reported', 'Local project', 'Unknown project']));
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
const pathy = (s) => /(^|\s)(~|\/|[A-Za-z]:\\)/.test(s) || s.includes('/Users/') || s.includes('\\');

module.exports = { AI, NO_PROJECT, text, pathy };
