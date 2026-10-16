import { h } from './h.js';
import { reportedSessionContext } from './local-session-context.js';
import { isObservedWork } from '../../shared/capture-lane.js';
import { agoText } from './render-capture.js';

const preview = (value, limit = 800) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
};
const link = (tab, label) => h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'tab', 'data-tab': tab }, label);
const section = (title, ...children) => h('section', { class: 'dsec', 'aria-label': title }, h('h3', { class: 'dsec-title' }, title), ...children);

// A read-only landing view. The existing panels own drafts, permissions and
// delivery; a saved checkpoint or session report is never an acknowledgement.
export function taskWorkspacePanel(detail, model, hasPendingRequests = false) {
  const d = detail.data, card = d.card, observed = isObservedWork(card);
  const report = reportedSessionContext(detail), saved = detail.packet?.data;
  const latest = [...(d.feed ?? [])].reverse().find(e => ['progress', 'status', 'message'].includes(e.kind) && preview(e.text));
  const request = report?.goal || saved?.brief || d.body;
  const requestSource = report?.goal ? 'Reported session goal' : saved?.brief ? 'Saved task brief' : 'Task description';
  const progress = report?.summary || latest?.text;
  const offline = model.conn?.status !== 'open';
  const desktop = typeof globalThis.plexiformDesktop?.openSession === 'function';
  return h('div', { class: 'task-workspace' },
    offline ? h('p', { class: 'muted', role: 'status' }, 'Board connection unavailable. Showing the last received task information; refresh when connected.') : null,
    detail.error ? h('p', { class: 'form-error', role: 'alert' }, `Task refresh failed: ${detail.error}`) : null,
    section('Current request',
      h('p', { class: 'prose' }, preview(request) || 'No request recorded. Add a brief in Task context so a teammate can pick this up.'),
      request ? h('p', { class: 'muted small' }, requestSource) : null),
    section('Latest reported progress',
      h('p', { class: 'prose' }, preview(progress) || 'No progress update recorded yet.'),
      progress ? h('p', { class: 'muted small' }, report?.summary ? 'From the session report shown above.' : `Board activity · ${agoText(latest.at_age_ms)}`) : null,
      link('activity', 'Read activity')),
    hasPendingRequests ? null : section('Pending requests', h('p', { class: 'muted' }, 'No pending requests recorded.')),
    section('Shared context',
      card.archived ? h('p', { class: 'muted' }, 'Restore this task to access shared context.')
        : detail.packetError ? h('div', null, h('p', { class: 'form-error', role: 'alert' }, `Task context unavailable: ${detail.packetError}`),
          h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'communication-reload' }, 'Retry task context'))
          : !detail.packetLoaded ? h('p', { class: 'muted', role: 'status' }, 'Loading shared context…')
            : saved ? h('div', null,
              h('p', { class: 'muted small' }, `Saved version ${detail.packet.version}${detail.packet.author?.name ? ` · ${detail.packet.author.name}` : ''}`),
              h('dl', { class: 'details' },
                h('dt', null, 'Checkpoint'), h('dd', { class: 'prose' }, preview(saved.progress) || 'No checkpoint saved.'),
                h('dt', null, 'Decisions'), h('dd', null, saved.decisions?.length
                  ? h('ul', { class: 'md-list' }, saved.decisions.slice(0, 3).map((decision, i) => h('li', { key: i }, preview(decision, 300))))
                  : 'No decisions saved.'),
                h('dt', null, 'Next action'), h('dd', { class: 'prose' }, preview(saved.nextAction, 400) || 'No next action saved.')),
              saved.decisions?.length > 3 ? h('p', { class: 'muted small' }, `${saved.decisions.length - 3} more decisions in Task context.`) : null)
              : h('p', { class: 'muted' }, 'No shared context saved. Keep a brief, decisions and next action here for the next person.'),
      detail.packetDraft ? h('p', { class: 'muted small' }, 'You have an unsaved task context draft. Open Task context to continue editing.') : null,
      link('packet', 'Open task context')),
    section('Continue this task',
      observed ? h('p', { class: 'muted small' }, desktop
        ? 'Open the exact session to check its available controls. Task messages go to managed board runs.'
        : 'Open this session in your AI tool to continue it. Task messages go to managed board runs.')
        : h('p', { class: 'muted small' }, 'Messages shows available recipients and delivery status. Coordination shows declared work and overlaps.'),
      h('div', { class: 'drawer-actions' },
        observed && desktop ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'open-session', 'data-card': detail.cardId }, 'Open session controls') : null,
        link('messages', 'Messages'), link('ownership', 'Coordination'), link('handover', 'Handover')),
      detail.messageDraft ? h('p', { class: 'muted small' }, 'You have an unsent message draft in Messages.') : null));
}
