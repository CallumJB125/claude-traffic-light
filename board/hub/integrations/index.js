// The connectors this hub offers. Real ones (GitHub, Slack, Sentry, Linear,
// Jira) are added here as they land; the fake one only on dev hubs and in tests.
import fake from './fake/index.js';
import github from './github/index.js';

export function connectorsFor(config) {
  return config.auth === 'dev' ? [fake, github] : [github];
}
