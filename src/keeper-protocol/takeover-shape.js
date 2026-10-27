'use strict';
// The structural half of the keeper's take-over check (plan-agent-terminal
// §R3.2.2), read from the same takeover-shape.json the keeper's Swift table is
// generated from. Pure: realpath, ownership and placement need the real files
// and stay with the keeper (PR 0) and T3.
// checkTakeover(spawn, {dataDir}) → null when it fits, else {field} naming the
// part that doesn't (never its value).
const path = require('node:path');
const SHAPE = require('./takeover-shape.json');

const RE = Object.fromEntries(Object.entries(SHAPE.patterns).map(([k, v]) => [k, new RegExp(v)]));
const plain = (v) => typeof v === 'string' && !v.includes('\0');

function valueOk(kind, v, runDir) {
  if (!plain(v)) return false;
  if (kind === 'empty') return v === '';
  if (kind === 'absolute') return path.isAbsolute(v) && path.normalize(v) === v;
  if (kind === 'text') return Buffer.byteLength(v) <= SHAPE.env.maxValueBytes;
  if (kind.startsWith('runFile:')) return v === path.join(runDir, kind.slice(8));
  if (kind.startsWith('enum:')) return SHAPE.enums[kind.slice(5)].includes(v);
  return !!RE[kind] && RE[kind].test(v);
}

function argvMismatch(argv, runDir) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(plain)) return 'argv';
  if (!path.isAbsolute(argv[0])) return 'argv[0]';
  let i = 1;
  for (const step of SHAPE.claude.sequence) {
    const flags = Array.isArray(step.flag) ? step.flag : [step.flag];
    if (!flags.includes(argv[i])) { if (step.optional) continue; return step.flag.toString(); }
    i++;
    if (step.values) {
      let n = 0;
      while (i < argv.length && valueOk(step.values, argv[i], runDir)) { i++; n++; }
      if (n < step.min) return flags[0];
    } else if (step.value) {
      if (!valueOk(step.value, argv[i], runDir)) return flags[0];
      i++;
    }
  }
  return i === argv.length ? null : 'argv';
}

function envMismatch(env, runDir) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'env';
  for (const [name, v] of Object.entries(env)) {
    if (!SHAPE.env.allow.includes(name)) return 'env';
    if (!plain(v) || Buffer.byteLength(v) > SHAPE.env.maxValueBytes || !valueOk(SHAPE.env.values[name], v, runDir)) return `env.${name}`;
  }
  for (const name of SHAPE.claude.envRequired) if (!(name in env)) return `env.${name}`;
  return null;
}

function checkTakeover(spawn, { dataDir } = {}) {
  const field = (f) => ({ field: f });
  if (!spawn || typeof spawn !== 'object') return field('spawn');
  if (spawn.kind !== 'takeover') return field('kind');
  if (!spawn.origin || spawn.origin.by !== 'plexiform') return field('origin');
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return field('dataDir');
  const taskId = spawn.env?.BUDDY_TASK_ID;
  if (!RE.taskId.test(String(taskId)) || spawn.origin.taskId !== taskId) return field('env.BUDDY_TASK_ID');
  // The run dir is never sent: it is derived from the keeper's own data dir.
  const runDir = path.join(dataDir, 'run', taskId);
  if (typeof spawn.cwd !== 'string' || !plain(spawn.cwd) || !path.isAbsolute(spawn.cwd)) return field('cwd');
  const env = envMismatch(spawn.env, runDir);
  if (env) return field(env);
  const argv = argvMismatch(spawn.argv, runDir);
  return argv ? field(argv) : null;
}

module.exports = { checkTakeover, SHAPE };
