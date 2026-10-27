'use strict';
// The session keeper's protocol, shared by Plexiform and Plexiform Terminal
// (plan-agent-terminal §R2.3, §R3.2, §R3.7, §R3.11, §R3.14). PR 0s publishes the
// constants and the v1.0 schema; the client itself arrives with the keeper (PR 0).
// Only main.js, src/tasks-terminal.js, src/tasks-service.js and src/focus/index.js
// may require this folder (test/surface-boundary.test.js).
const path = require('node:path');

const PROTOCOL = Object.freeze({ major: 1, minor: 0 });
// u32 length (big-endian) | u8 type | payload. Any other type closes the connection.
const FRAME = Object.freeze({ CONTROL: 1, DATA: 2 });
const LIMITS = Object.freeze({
  controlBytes: 64 * 1024, dataBytes: 64 * 1024, rowsPublishBytes: 256 * 1024,
  sessions: 64, controlConnections: 4, driverConnections: 4, pendingShow: 3, spawnsPerMinute: 10, sendQueueBytes: 8 * 1024 * 1024,
});
const ROLES = Object.freeze({ control: 'dev.plexiform.app', driver: 'dev.plexiform.terminal' });
const ERROR_CODES = Object.freeze(['UNKNOWN_OP', 'VALIDATION', 'NOT_FOUND', 'ROLE', 'SPAWN_REFUSED', 'LIMIT', 'INCOMPATIBLE', 'CLIENT_OUTDATED', 'TERMINAL_DIDNT_START']);
// Which role may send which op (§R3.2.1, which replaces §R2.3.3's control column).
const OPS = Object.freeze({
  hello: ['control', 'driver'], status: ['control', 'driver'], list: ['control', 'driver'], spawn: ['control', 'driver'], byTty: ['control', 'driver'],
  reveal: ['control'], 'rows.publish': ['control'],
  jump: ['driver'], attach: ['driver'], resize: ['driver'], detach: ['driver'], signal: ['driver'], shutdown: ['driver'], shown: ['driver'], handoff: ['driver'],
});
// Control may spawn only a take-over, in takeover-shape.json's shape; the driver never spawns one.
const SPAWN_KINDS = Object.freeze({ control: Object.freeze(['takeover']), driver: Object.freeze(['shell', 'claude', 'codex']) });
// The v1.0 control-message schema (draft 2020-12, the keyword set of board/tasks-api/validate.js).
const SCHEMA_PATH = path.join(__dirname, 'schema.json');

module.exports = { PROTOCOL, FRAME, LIMITS, ROLES, ERROR_CODES, OPS, SPAWN_KINDS, SCHEMA_PATH };
