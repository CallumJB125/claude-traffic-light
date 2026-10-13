// The connectors this hub offers. GitHub is always offered; the fake one only
// on dev hubs and in tests. The rest come from `config.connectors`
// (BOARD_CONNECTORS, unset: slack and sentry). Linear (./linear/) and Jira
// (./jira/) are built and tested but stay behind their go-live gate
// (docs/LINEAR-RUNBOOK.md, docs/JIRA-RUNBOOK.md): an operator who has checked
// a real delivery against verify() adds them (`BOARD_CONNECTORS=slack,sentry,linear`).
// `githubApp`: the hub's own GitHub App client (github/app.js), when the
// operator configured one; GitHub then also connects by installation.
import fake from './fake/index.js';
import github, { withApp } from './github/index.js';
import slack from './slack/index.js';
import sentry from './sentry/index.js';
import linear from './linear/index.js';
import jira from './jira/index.js';

export const OPTIONAL = Object.freeze({ slack, sentry, linear, jira });
export const DEFAULT_CONNECTORS = Object.freeze(['slack', 'sentry']);

export function connectorsFor(config, { githubApp = null } = {}) {
  const gh = githubApp ? withApp(githubApp) : github;
  const wanted = Array.isArray(config.connectors) ? config.connectors : DEFAULT_CONNECTORS;
  const extra = [...new Set(wanted)].filter((id) => OPTIONAL[id]).map((id) => OPTIONAL[id]);
  return [...(config.auth === 'dev' ? [fake, gh] : [gh]), ...extra];
}
