'use strict';
// An explicit release decision. Key rotation must never change access policy.
// Disable for paid general availability only after billing and migration acceptance.
module.exports = Object.freeze({ BETA_ALL_FEATURES: true, PHONE_ORIGINS: Object.freeze({ 'https://app.plexiform.dev': 'https://plexiform-phone.pages.dev' }) });
