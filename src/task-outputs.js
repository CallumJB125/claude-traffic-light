// Saved output cards are a view of the existing versioned checkpoint, not a
// second store or executable generated content. Main retains all authority.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaskOutputs = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const authors = { human: 'You', agent: 'Task agent', remote: 'Team participant', supervisor: 'Plexiform' };
  const sources = { continuous: 'Current checkpoint', checkpoint_complete: 'Completion checkpoint', checkpoint_incomplete: 'Checkpoint before interruption', takeover: 'Takeover checkpoint', frozen: 'Handover checkpoint', participant: 'Saved checkpoint' };
  function fromTask(task) {
    const p = task?.checkpoint;
    if (!p || !Number.isSafeInteger(p.version) || p.version < 1) return null;
    const artifacts = (Array.isArray(p.artifacts) ? p.artifacts : []).slice(0, 32).flatMap(a => {
      if (a?.kind === 'path' && typeof a.path === 'string') return [{ kind: 'File', text: text(a.path, 1024), href: null }];
      if (a?.kind === 'commit' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.sha)) return [{ kind: 'Commit', text: a.sha, href: null }];
      if (a?.kind === 'pr' && typeof a.url === 'string') {
        const permitted = a.url === task.pr?.url && /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\/pull\/[1-9][0-9]*$/.test(a.url);
        return [{ kind: 'Pull request', text: text(a.url, 1024), href: permitted ? a.url : null }];
      }
      return [];
    });
    return { taskId: task.id, version: p.version, at: Number.isSafeInteger(p.at) && p.at > 0 ? p.at : null,
      text: text(p.progress, 4000), author: authors[p.author?.kind] || 'Recorded participant', source: sources[p.provenance] || 'Saved checkpoint', artifacts };
  }
  function cardsSource(task) {
    const p = task?.checkpoint;
    if (!p || !Number.isSafeInteger(p.version) || p.version < 1) return null;
    const s = p.resultCardsSource || p;
    return { version: s.version, at: Number.isSafeInteger(s.at) && s.at > 0 ? s.at : null, author: authors[s.author?.kind] || 'Recorded participant' };
  }
  return { fromTask, cardsSource };
}));
