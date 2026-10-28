'use strict';
// QoL3a: a global key that brings forward the next session waiting on you (the widget click's queue, from anywhere).
// Off by default and never suggested: nothing is registered until the person types a key in. It yields to every other
// key Plexiform has (the widget's show and hide key, the task box and voice), compared in canonical form, so it never
// takes a key one of them is configured to use. config-effects applies it first (so it lets go before they try) and
// settles it last (so a key freed in the same save can be picked up).
const WidgetPage = require('./widget-page.js');
const { canonicalAccelerator, reserved: composeReserved } = require('./compose-shortcut.js');

const PRESS_GAP_MS = 500;

/** The keys next must leave alone: the widget's, the voice key and the task box's. */
function reserved(c, platform) {
  const out = composeReserved(c, platform);
  const k = canonicalAccelerator(c?.composeShortcut, platform);
  if (k) out.push({ key: k, owner: 'compose' });
  return out;
}

/**
 * deps: { globalShortcut, config() (loadConfig), onPress(), platform?, enabled? (false in a dev run: nothing is
 *         registered, specs press it through main's gated hook), now?, log? }
 */
function install(deps) {
  const platform = deps.platform || process.platform;
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  let held = null;
  let tried;
  let lastPress = -Infinity;
  let status = { accelerator: null, state: 'off' }; // off | on | taken | widget | compose | voice | dev

  function release() {
    if (!held) return;
    try { deps.globalShortcut.unregister(held); } catch { /* already gone */ }
    held = null;
  }

  /** One press per half second: a held key's auto-repeat must not walk the whole queue. */
  function press() {
    const t = now();
    if (t - lastPress < PRESS_GAP_MS) return false;
    lastPress = t;
    try { deps.onPress(); } catch (e) { log(`[next] ${e?.message ?? e}`); }
    return true;
  }

  function apply(c = deps.config()) {
    const want = WidgetPage.cleanAccelerator(c?.nextShortcut);
    const canon = canonicalAccelerator(want, platform);
    const clash = canon ? reserved(c, platform).find((r) => r.key === canon) : null;
    const inputs = JSON.stringify([canon, clash?.owner ?? null, deps.enabled !== false]);
    if (inputs === tried) return status;
    tried = inputs;
    release();
    if (!want) status = { accelerator: null, state: 'off' };
    else if (clash) status = { accelerator: want, state: clash.owner };
    else if (deps.enabled === false) status = { accelerator: want, state: 'dev' };
    else {
      let ok = false;
      try { ok = deps.globalShortcut.register(want, press); } catch { ok = false; }
      if (ok) { held = want; status = { accelerator: want, state: 'on' }; }
      else { status = { accelerator: want, state: 'taken' }; log(`[next] ${want} could not be registered (taken or not allowed)`); }
    }
    return status;
  }

  /** After every other key line: a key that was taken only because one of them still held it is tried once more. */
  function settle(c = deps.config()) {
    if (status.state !== 'taken') return status;
    tried = undefined;
    return apply(c);
  }

  function view() {
    const s = status;
    const line = s.state === 'widget' ? "Your widget's show and hide key uses this, so this one is off. Pick another key."
      : s.state === 'compose' ? 'Your task box key uses this, so this one is off. Pick another key.'
        : s.state === 'voice' ? 'Your voice key uses this, so this one is off. Pick another key.'
          : s.state === 'taken' ? 'Another app already uses this key, so this one is off. Pick another key.'
            : '';
    return { accelerator: s.accelerator, state: s.state, line };
  }

  return { apply, settle, view, press, release, get held() { return held; } };
}

module.exports = { install, reserved, PRESS_GAP_MS };
