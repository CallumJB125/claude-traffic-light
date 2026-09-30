// JSON-line logger to stderr: {t, level, msg, ...fields}. Never pass tokens,
// run tokens, device tokens or card bodies in fields at info (CONTRACT §14).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', sink = (line) => process.stderr.write(`${line}\n`), clock = () => Date.now() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const rec = { t: new Date(clock()).toISOString(), level: lvl, msg };
    for (const [k, v] of Object.entries(fields)) rec[k] = v instanceof Error ? { message: v.message, code: v.code } : v;
    sink(JSON.stringify(rec));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger = createLogger({ level: 'silent' });

// Logs get the message with URLs cut to origin + path and token-like runs removed.
export function redact(msg) {
  return String(msg ?? '').slice(0, 300)
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return '[url]'; } })
    .replace(/[A-Za-z0-9_\-.+/=]{24,}/g, '[redacted]');
}
