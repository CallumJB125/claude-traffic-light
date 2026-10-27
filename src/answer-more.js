'use strict';
// The extras a thread's hook-request card may send with an answer (redesign
// R4-2, plan-r4-2.md §8 S2): the same `answers`, `content` and `message` as
// the widget's answer-input, held to hooks/answer-file.js's own rules
// (cleanExtra), plus `anyway`, C-F's second click. Never `oneKey`: the thread
// has no Enter path.
const { cleanExtra } = require('../hooks/answer-file.js');

const KEYS = new Set(['answers', 'content', 'message', 'anyway']);
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function check(more) {
  if (!plain(more) || !Object.keys(more).every((k) => KEYS.has(k))) return false;
  if (Object.hasOwn(more, 'anyway') && more.anyway !== true) return false;
  const { answers, content, message } = more;
  return cleanExtra({ answers, content, message }) !== null;
}

module.exports = { check, KEYS };
