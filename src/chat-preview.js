'use strict';
// The chat-first preview gate (plan-redesign §R3.8). Before R6a no new UI is
// reachable in a packaged build: the redesign's documents are behind this
// dev-only switch, honoured only in a dev run of an unpackaged app, the same
// rule as the other dev env vars (main.js CLAUDE_TRAFFIC_LIGHT_WORK_SCOPE_MOCK).
// Main reads it once; renderers never read the environment.

const ENV = 'CLAUDE_TRAFFIC_LIGHT_CHAT_PREVIEW';

function chatPreviewOn({ isDevRun, isPackaged, env } = {}) {
  return isDevRun === true && isPackaged === false && !!env && env[ENV] === '1';
}

module.exports = { ENV, chatPreviewOn };
