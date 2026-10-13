'use strict';

// The memory worker: owns the index database and every transcript read, so a
// slow disk, a huge transcript or a macOS privacy prompt can only delay
// search, never the app. Messages: {id, type, ...args} → {id, result | error}.

const { parentPort, workerData } = require('node:worker_threads');
const Indexer = require('./indexer.js');
const Search = require('./search.js');
const Transcripts = require('../handover-transcripts.js');
const SessionHandover = require('../session-handover.js');

let ix = null;
const index = () => ix || (ix = Indexer.openIndex(workerData.dir));

// The session's handover markdown: its own transcript's facts where
// src/handover-transcripts.js reads that tool, else the index's. No git facts:
// that would open the session's folder.
function handover({ tool, sid, home }) {
  const i = index();
  const s = Indexer.sessionRow(i, tool, sid);
  const a = Indexer.ADAPTERS.find((x) => x.id === tool);
  if (!s || !a) return null;
  let f = null;
  if ((tool === 'claude' || tool === 'codex') && s.source) f = Transcripts.factsFrom(s.source, { adapter: a.handover, sessionId: sid });
  if (!f) f = Indexer.factsOf(i, tool, sid, a.handover);
  return f ? SessionHandover.renderDoc(f, { repo: false }, { home }) : null;
}

const handlers = {
  index: (m) => Indexer.indexPass(index(), { home: m.home, rootDir: m.rootDir, days: m.days, experimental: m.experimental === true }),
  search: (m) => Search.query(index(), m.req, { days: m.days, home: m.home }),
  facets: (m) => Search.facets(index(), { days: m.days }),
  stats: () => Indexer.stats(index()),
  clear: () => { Indexer.wipe(index()); index().db.exec('VACUUM'); index().tighten(); return true; },
  handover,
};

// A long index pass yields between reads, so searches are answered while it runs.
parentPort.on('message', async (m) => {
  const fn = m && handlers[m.type];
  if (!fn) { parentPort.postMessage({ id: m && m.id, error: 'unknown request' }); return; }
  try { parentPort.postMessage({ id: m.id, result: await fn(m) }); } catch (e) { parentPort.postMessage({ id: m.id, error: String((e && e.message) || e).slice(0, 300) }); }
});
