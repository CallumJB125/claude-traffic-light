// Tee console output to a small rotating file, extracted verbatim from main.js.
// Errors otherwise vanish: a packaged app has no visible terminal, so a crash
// left zero evidence. Capped so a busy session can't grow it unbounded.
const fs = require('fs');
const path = require('path');

function installFileLogging({ rootDir, isDevRun }) {
  if (isDevRun) return;
  const LOG_FILE = path.join(rootDir, 'app.log');
  const LOG_MAX_BYTES = 512 * 1024;
  try { fs.mkdirSync(rootDir, { recursive: true }); } catch { /* already there */ }
  for (const method of ['log', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      try {
        const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
        if (stat && stat.size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
        const line = `${new Date().toISOString()} [${method}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
        fs.appendFileSync(LOG_FILE, line);
      } catch { /* logging must never be why the app breaks */ }
    };
  }
}

module.exports = { installFileLogging };
