// UpdaterState → what every update surface shows (the About & Updates page,
// the tray, the widget row), so the wording is the same everywhere. Pure: no
// Electron, no DOM. Plain script for the renderers (window.UpdateView) and
// CommonJS for Node, like brand.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../brand.js'));
  else root.UpdateView = factory(root.Brand);
})(typeof self !== 'undefined' ? self : this, function (Brand) {
  const DEFAULT_NAME = Brand && Brand.name;

  // "1.2.0-beta.4" → comparable parts; a release sorts after its betas.
  function cmpVersion(a, b) {
    const parse = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.?(\d+))?/.exec(String(v || ''));
      return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
    };
    const x = parse(a), y = parse(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  function lastChecked(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!iso || !Number.isFinite(t)) return 'Not checked yet';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'Last checked just now';
    const unit = (n, w) => `Last checked ${n} ${w}${n === 1 ? '' : 's'} ago`;
    if (s < 3600) return unit(Math.round(s / 60), 'minute');
    if (s < 86400) return unit(Math.round(s / 3600), 'hour');
    return unit(Math.round(s / 86400), 'day');
  }

  // Release notes come from a feed: they are data, never markup. Every tag is
  // dropped, links and images lose their target, and what is left is plain
  // text with at most bullets and bold, returned as blocks the page builds with
  // createElement/textContent.
  //   [{ type: 'p' | 'ul', items: [[{ text, bold }]] }]
  const MAX_NOTES_CHARS = 4000;
  const MAX_NOTES_LINES = 60;
  function inline(line) {
    const out = [];
    let bold = false;
    for (const part of line.split(/(\*\*|__)/)) {
      if (part === '**' || part === '__') { bold = !bold; continue; }
      if (part) out.push({ text: part, bold });
    }
    return out;
  }
  function sanitizeNotes(input) {
    let s = String(input ?? '').slice(0, MAX_NOTES_CHARS * 2);
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/?[a-zA-Z!][^>\n]*>/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .slice(0, MAX_NOTES_CHARS);
    const blocks = [];
    for (const raw of s.split(/\r?\n/).slice(0, MAX_NOTES_LINES)) {
      const line = raw.trim();
      if (!line) { continue; }
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      if (bullet) {
        const last = blocks[blocks.length - 1];
        const item = inline(bullet[1]);
        if (last && last.type === 'ul') last.items.push(item); else blocks.push({ type: 'ul', items: [item] });
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      blocks.push({ type: 'p', items: [heading ? [{ text: heading[1].replace(/\*\*|__/g, ''), bold: true }] : inline(line)] });
    }
    return blocks;
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function longDate(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : null;
  }

  const ERRORS = {
    offline: { text: () => "Can't reach the update server. Check your internet connection.", tone: 'error', retry: true },
    signature: { text: () => "The update didn't pass its security check, so it wasn't installed.", tone: 'error', retry: true },
    verify: { text: () => "The update didn't pass its security check, so it wasn't installed.", tone: 'error', retry: true },
    // The service refuses any older version that is not a signed rollback naming
    // this one; which wording is true depends on whether this is a beta.
    downgrade: { text: (n, s) => (/-beta/.test(s && s.currentVersion) ? "You're on a newer beta than the stable release — you'll get the next stable when it ships." : 'The update server offered an older version than yours, so it was ignored.'), tone: 'info', retry: false },
    translocated: { text: (n) => `Move ${n} to Applications, then open it again.`, tone: 'error', retry: false },
    'not-writable': { text: (n) => `${n} can't replace itself in this folder. Move it to Applications or check permissions.`, tone: 'error', retry: false },
    'disk-full': { text: () => 'Not enough disk space to download the update.', tone: 'error', retry: true },
    server: { text: () => 'The update server had a problem. Try again in a moment.', tone: 'error', retry: true, showDetail: true },
    unknown: { text: () => 'Something went wrong while updating.', tone: 'error', retry: true, showDetail: true },
    'install-stalled': { text: (n) => `The update didn't finish installing. Try again, or restart ${n}.`, tone: 'error', retry: true },
    // the service's detail names the date it last had a confirmed answer; lastCheckedAt is the fallback
    expired: { text: (n, s) => { const m = /since (\d{4}-\d{2}-\d{2})/.exec((s && s.error && s.error.detail) || ''); const d = longDate(m ? m[1] : s && s.lastCheckedAt); return d ? `Couldn't confirm ${n} is up to date since ${d}.` : `Couldn't confirm ${n} is up to date.`; }, tone: 'error', retry: false },
  };

  // Button id → the updater command it runs (names match the preload).
  const COMMANDS = {
    check: { name: 'check' },
    download: { name: 'download' },
    'install-now': { name: 'install', arg: { when: 'now' } },
    'install-idle': { name: 'install', arg: { when: 'idle' } },
    'install-force': { name: 'install', arg: { when: 'now', force: true } },
    revert: { name: 'revert' },
  };

  const btn = (id, label, extra = {}) => ({ id, label, primary: false, disabled: false, ...extra });

  function isRollback(s) {
    return !!s.available && cmpVersion(s.available.version, s.currentVersion) < 0;
  }

  function installLabels(s) {
    const back = isRollback(s);
    const later = "when you're not working with Claude";
    if (s.installKind === 'swap') return { now: back ? 'Quit and go back' : 'Quit and update', idle: `${back ? 'Go back' : 'Update'} ${later}`, anyway: back ? 'Go back anyway' : 'Update anyway', armed: `Will ${back ? 'go back' : 'quit and update'} ${later}.` };
    if (s.installKind === 'deb-manual') return { now: 'Open in Software Installer', idle: null, anyway: null, armed: null };
    return { now: back ? 'Restart to go back' : 'Restart now', idle: `Restart ${later}`, anyway: back ? 'Go back anyway' : 'Restart anyway', armed: `Will restart ${later}.` };
  }

  /**
   * The About & Updates page. `state` null means there is no updater in this build.
   */
  function view(state, { name = DEFAULT_NAME, now = Date.now(), armed = false, deferred = false } = {}) {
    if (!state) {
      return { present: false, name, headline: 'Update status unavailable', message: { tone: 'error', text: "Couldn't read the update status. Restart " + name + ' and try again.' }, buttons: [], channels: [], progress: null, notes: null, size: null, revert: null, restartConfirm: null, autoDownload: false, currentLine: name, lastChecked: null };
    }
    const s = state;
    const v = s.available && s.available.version;
    const lab = installLabels(s);
    const out = {
      present: true,
      name,
      status: s.status,
      currentLine: `${name} ${s.currentVersion}`,
      channel: s.channel,
      channels: [{ id: 'stable', label: 'Stable', on: s.channel === 'stable' }, { id: 'beta', label: 'Beta', on: s.channel === 'beta' }],
      betaConfirm: { text: 'Beta versions may be less stable. Switch to Beta?', confirmLabel: 'Switch to Beta', cancelLabel: 'Stay on Stable' },
      lastChecked: lastChecked(s.lastCheckedAt, now),
      autoDownload: !!s.autoDownload,
      headline: '',
      message: null,
      progress: null,
      notes: null,
      size: null,
      buttons: [],
      revert: s.canRevert && s.previousVersion ? {
        id: 'revert',
        label: `Revert to ${s.previousVersion}`,
        disabled: !['idle', 'available', 'ready', 'error'].includes(s.status),
        explain: s.installKind === 'swap' ? `Downloads ${s.previousVersion} again and restarts ${name}.` : `Installs ${s.previousVersion} again and restarts ${name}.`,
        confirm: { text: `${s.installKind === 'swap' ? 'Download and go back to' : 'Revert to'} ${s.previousVersion}? ${name} will restart.`, confirmLabel: 'Revert', cancelLabel: 'Cancel' },
      } : null,
      restartConfirm: null,
      // a deb only opens the installer: no busy gate, no idle wait
      busyReason: s.installKind === 'deb-manual' ? null : s.busyReason || null,
    };
    const showOffer = () => {
      out.notes = s.available.notes ? sanitizeNotes(s.available.notes) : null;
      out.size = formatSize(s.available.size);
    };
    const check = (label = 'Check now', extra = {}) => btn('check', label, extra);

    switch (s.status) {
      case 'checking':
        out.headline = 'Checking for updates…';
        out.buttons = [check('Check now', { disabled: true })];
        break;
      case 'available':
        out.headline = `Version ${v} is available`;
        showOffer();
        out.buttons = [btn('download', 'Download', { primary: true }), check('Check now')];
        if (s.requiredByHub) out.message = { tone: 'notice', text: hubText(s, name) };
        break;
      case 'downloading': {
        out.headline = `Downloading version ${v}…`;
        showOffer();
        const p = s.progress && Number.isFinite(s.progress.percent) ? Math.max(0, Math.min(100, Math.round(s.progress.percent))) : null;
        out.progress = { percent: p, label: p === null ? 'Downloading…' : `${p}%` };
        break;
      }
      case 'ready': {
        out.headline = isRollback(s) ? `Going back to ${v} is ready` : `Version ${v} is ready`;
        showOffer();
        const deb = s.installKind === 'deb-manual';
        const busy = !deb && (!!s.busyReason || deferred);
        const why = s.busyReason || 'A session is working.';
        out.buttons = [btn('install-now', lab.now, { primary: true })];
        if (lab.idle) out.buttons.push(armed ? btn('install-idle', 'Scheduled', { disabled: true }) : btn('install-idle', lab.idle));
        if (s.requiredByHub) out.message = { tone: 'notice', text: hubText(s, name) };
        else if (deb) out.message = { tone: 'info', text: 'The update is downloaded. Open it in the Software Installer to finish.' };
        else if (s.installKind === 'swap') out.message = { tone: 'info', text: `${name} will reopen by itself.` };
        // The install was tried and did not happen (status stays ready, the error says why).
        if (s.error) {
          const path = deb && /(\/\S+)\s*$/.exec(String(s.error.detail || ''));
          if (path) out.message = { tone: 'error', text: `Couldn't open the installer. The update is saved at ${path[1]}.` };
          else {
            const e = ERRORS[s.error.code] || ERRORS.unknown;
            out.message = { tone: e.tone, text: e.text(name, s) };
            if (e.showDetail && s.error.detail) out.message.detail = String(s.error.detail);
            if (s.error.code === 'install-stalled') out.buttons[0].label = 'Try again';
          }
        }
        if (armed && lab.armed) out.message = { tone: 'info', text: lab.armed };
        if (busy) {
          out.message = { tone: 'notice', text: `${why} ${name} won't restart mid-task.` };
          out.restartConfirm = { text: `${why} ${lab.anyway}?`, confirmId: 'install-force', confirmLabel: lab.anyway, cancelLabel: 'Not now' };
        }
        break;
      }
      case 'installing':
        out.headline = `Installing version ${v}…`;
        out.message = { tone: 'info', text: `${name} will restart in a moment.` };
        break;
      case 'error': {
        const e = ERRORS[s.error && s.error.code] || ERRORS.unknown;
        out.headline = 'Update problem';
        // the message already carries the date; a relative "N days ago" beside it would only repeat it
        if (s.error && s.error.code === 'expired') out.lastChecked = null;
        out.message = { tone: e.tone, text: e.text(name, s) };
        if (e.showDetail && s.error && s.error.detail) out.message.detail = String(s.error.detail);
        // Never an Install or Download button on an error: the retry re-checks
        // the feed and re-verifies, it does not reuse a file that failed.
        out.buttons = e.retry ? [check('Try again', { primary: true })] : [check('Check now', { primary: s.error.code === 'expired' })];
        if (s.available && s.error.code !== 'downgrade' && ['verify', 'signature'].indexOf(s.error.code) < 0) showOffer();
        break;
      }
      default:
        if (s.lastCheckedAt) { out.headline = "You're up to date"; out.message = { tone: 'info', text: `${name} ${s.currentVersion} is the latest ${s.channel === 'beta' ? 'beta' : 'version'}.` }; } else out.headline = 'Not checked yet';
        out.buttons = [check('Check now', { primary: true })];
    }
    return out;
  }

  function hubText(s, name) {
    return `Update ${name} to keep using your team board (${s.requiredByHub.hubName} needs ${s.requiredByHub.minVersion}).`;
  }

  /** The tray's update items, in order. */
  function trayItems(state, { name = DEFAULT_NAME } = {}) {
    if (!state) {
      return [{ id: 'check', label: 'Check for Updates…', enabled: false }];
    }
    const s = state;
    const busy = s.status === 'checking' || s.status === 'downloading' || s.status === 'installing';
    const items = [{ id: 'check', label: 'Check for Updates…', enabled: !busy }];
    if (s.status === 'downloading') {
      const p = s.progress && Number.isFinite(s.progress.percent) ? `${Math.round(s.progress.percent)}%` : '';
      items.push({ id: 'progress', label: `Downloading update…${p ? ` ${p}` : ''}`, enabled: false });
    } else if (s.status === 'installing') {
      items.push({ id: 'progress', label: 'Installing update…', enabled: false });
    } else if (s.status === 'ready') {
      const v = s.available && s.available.version;
      const back = isRollback(s);
      if (s.installKind === 'deb-manual') items.push({ id: 'install', label: 'Open in Software Installer', enabled: true });
      else if (s.installKind === 'swap') {
        items.push({ id: 'install', label: `${back ? 'Quit and Go Back to' : 'Quit and Update'} ${name} ${v}`, enabled: true });
        items.push({ id: 'hint', label: `${name} will reopen by itself`, enabled: false });
      } else items.push({ id: 'install', label: `${back ? 'Restart to Go Back to' : 'Restart to Update'} ${name} ${v}`, enabled: true });
    }
    return items;
  }

  /** Changes when the tray's menu would; download progress counts in 10% steps so the menu is not rebuilt per percent. */
  function trayKey(state) {
    const s = state && state.progress && Number.isFinite(state.progress.percent) ? { ...state, progress: { ...state.progress, percent: Math.floor(state.progress.percent / 10) * 10 } } : state;
    return JSON.stringify(trayItems(s));
  }

  /**
   * The widget's "Update ready" row, or null. The widget may only ask for an
   * install (idle or now, never forced); everything else opens the page.
   * `armed`: "when you're not working" was already requested.
   */
  function widgetRow(state, { name = DEFAULT_NAME, armed = false } = {}) {
    if (!state) return null;
    const s = state;
    const v = s.available && s.available.version;
    const back = isRollback(s);
    const armedSub = `Will ${s.installKind === 'swap' ? (back ? 'go back' : 'quit and update') : back ? 'go back' : 'restart'} when you're not working with Claude`;
    if (s.requiredByHub && ['available', 'downloading', 'ready'].includes(s.status)) {
      const text = `Update ${name} to keep using your team board (${s.requiredByHub.hubName} needs ${s.requiredByHub.minVersion})`;
      if (s.status === 'downloading') {
        const p = s.progress && Number.isFinite(s.progress.percent) ? ` ${Math.round(s.progress.percent)}%` : '';
        return { kind: 'hub', text, sub: `Downloading…${p}`, button: null, later: true };
      }
      if (s.status === 'ready') {
        if (armed && s.installKind !== 'deb-manual') return { kind: 'hub', text, sub: armedSub, button: null, later: true };
        return { kind: 'hub', text, sub: null, button: btn('install-now', s.installKind === 'swap' ? (back ? 'Quit and go back' : 'Quit and update') : s.installKind === 'deb-manual' ? 'Open installer' : back ? 'Restart to go back' : 'Restart to update', { primary: true }), later: true };
      }
      return { kind: 'hub', text, sub: null, button: btn('open-updates', 'Open updates', { primary: true }), later: true };
    }
    if (s.status === 'ready') {
      const text = back ? `Going back to ${v} is ready` : 'Update ready';
      if (s.installKind === 'deb-manual') return { kind: 'ready', text, sub: 'Finish it in the Software Installer', button: btn('install-now', 'Open installer'), later: true };
      if (armed) return { kind: 'ready', text, sub: armedSub, button: null, later: true };
      const verb = s.installKind === 'swap' ? (back ? 'Go back' : 'Update') : 'Restart';
      return { kind: 'ready', text, sub: `${name} won't restart mid-task`, button: btn('install-idle', `${verb} when not working`), later: true };
    }
    return null;
  }

  /** A short plain message for a command that came back { ok: false }, or null. */
  function commandFailure(result) {
    if (!result || result.ok !== false || result.deferred) return null;
    const code = String(result.error || '').replace(/[^\w .:-]/g, '').slice(0, 80);
    return code ? `That didn't work (${code}). Try again.` : "That didn't work. Try again.";
  }

  return { view, trayItems, trayKey, widgetRow, commandFailure, sanitizeNotes, formatSize, lastChecked, cmpVersion, COMMANDS, ERRORS };
});
