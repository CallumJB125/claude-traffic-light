// The connectors this hub offers. Real ones (GitHub, Slack, Sentry, Linear,
// Jira) are added here as they land; the fake one only on dev hubs and in tests.
// Sentry (./sentry/index.js) is built but not listed: it joins this list only
// once a real Sentry delivery has been checked against its verify() (CONTRACT
// D42 addendum "the Sentry connector", go-live gate).
import fake from './fake/index.js';
import github from './github/index.js';

export function connectorsFor(config) {
  return config.auth === 'dev' ? [fake, github] : [github];
}
