// The connectors this hub offers. Real ones (GitHub, Slack, Sentry, Linear,
// Jira) are added here as they land; the fake one only on dev hubs and in tests.
// Sentry (./sentry/index.js) is built but not listed: it joins this list only
// once a real Sentry delivery has been checked against its verify() (CONTRACT
// D42 addendum "the Sentry connector", go-live gate). Linear (./linear/) and
// Jira (./jira/) are built and not listed under the same gate
// (docs/LINEAR-RUNBOOK.md, docs/JIRA-RUNBOOK.md).
// `githubApp`: the hub's own GitHub App client (github/app.js), when the
// operator configured one; GitHub then also connects by installation.
import fake from './fake/index.js';
import github, { withApp } from './github/index.js';

export function connectorsFor(config, { githubApp = null } = {}) {
  const gh = githubApp ? withApp(githubApp) : github;
  return config.auth === 'dev' ? [fake, gh] : [gh];
}
