'use strict';
// Cursor: project rules only (.cursor/rules/<name>.mdc). User rules live in
// Cursor's settings, not in files, so there is no per-user target. With
// `alwaysApply: false`, a description and no globs, Cursor's agent pulls the
// rule in when it is relevant ("Apply Intelligently"). Used only by the
// separate "Add to a project…" action, which is off by default.
// Docs: https://cursor.com/docs/context/rules
const { yamlString, body } = require('./common.js');

module.exports = {
  id: 'cursor-project',
  label: 'Cursor (project)',
  dir: '.cursor/rules',
  verified: true,
  render(agent) {
    return { ok: true, file: `${agent.slug}.mdc`, text: `---\ndescription: ${yamlString(agent.description)}\nalwaysApply: false\n---\n${body(agent)}` };
  },
};
