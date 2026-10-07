'use strict';

// Main-side wiring for the This Mac "Keep this Mac awake while AI is working" switch.
// With Burst present (macOS) the switch is Burst's machine-wide lid-closed setting, behind a
// native consent dialog the renderer cannot skip. Otherwise it is Electron's powerSaveBlocker,
// held only while an AI session is working. The choice is saved as config.keepAwake:
// 'off' | 'app' | 'ac' | 'always'.

const Actions = require('./burst-actions.js');
const Sleepers = require('./sleep-assertions.js');

const IDLE_MINUTES = 120;
const APP_LABEL = 'Stops the Mac sleeping on its own while an AI session is working. It does not keep a closed laptop awake or the screen on.';
const BURST_LABEL = 'Uses Claude Burst to keep this Mac awake, lid closed included, while Claude Code is in use.';

function consent(burstMode) {
  const always = burstMode === 'always';
  return {
    title: 'Keep this Mac awake',
    detail: [
      'This is a machine-wide Mac setting, changed through Claude Burst. It applies to everything on this Mac, not only Plexiform, and it keeps Claude Code running with the lid closed.',
      '',
      always ? 'Plugged in and on battery: a closed laptop in a bag will get warm and can run the battery flat.' : 'Plugged in only: on battery the Mac sleeps as normal.',
      `It stops ${IDLE_MINUTES / 60} hours after the last Claude Code use. Burst may ask for your password in Terminal to apply it.`,
      '',
      'Turn it off here at any time.',
    ].join('\n'),
  };
}

function register({ utilityHandle, allowed, isMac, burst, keepAwake, dialog, getPref, setPref, listAssertions = Sleepers.listAssertions, log = () => {} }) {
  const present = () => {
    if (!isMac || !burst) return null;
    const s = burst.snapshot();
    return s && s.d && s.d.kind === 'present' && s.url ? s.url : null;
  };
  const view = () => {
    const pref = getPref();
    const viaBurst = !!present() || pref === 'ac' || pref === 'always';
    return { on: pref !== 'off', via: viaBurst ? 'burst' : 'app', mode: pref === 'always' ? 'always' : 'ac', label: viaBurst ? BURST_LABEL : APP_LABEL, held: keepAwake.held() };
  };
  const apply = () => keepAwake.setWanted(getPref() === 'app');

  async function set(req) {
    if (!req || typeof req.enabled !== 'boolean') return { ok: false, error: 'Bad request.' };
    const pref = getPref();
    const url = present();
    if (!req.enabled) {
      if (pref === 'ac' || pref === 'always') {
        if (!url) return { ok: false, error: 'Burst is not answering, so its setting was not changed.' };
        try { await Actions.setKeepAwake({ url, mode: 'off' }); } catch (e) { log('[keep-awake] off failed', e && e.code); return { ok: false, error: 'Could not turn it off in Burst. Nothing was changed.' }; }
      }
      setPref('off'); apply();
      return { ok: true, view: view() };
    }
    if (!url) {
      if (pref === 'ac' || pref === 'always') return { ok: false, error: 'Burst is not answering, so its setting was not changed.' };
      setPref('app'); apply();
      return { ok: true, view: view() };
    }
    const mode = req.mode === 'always' ? 'always' : 'ac';
    const c = consent(mode);
    const r = await dialog.showMessageBox({ type: 'warning', title: c.title, message: c.title, detail: c.detail, buttons: ['Cancel', 'Keep this Mac awake'], defaultId: 0, cancelId: 0, noLink: true });
    if (r.response !== 1) return { ok: false, cancelled: true };
    try { await Actions.setKeepAwake({ url, mode, idleMinutes: IDLE_MINUTES }); } catch (e) {
      log('[keep-awake] burst failed', e && e.code);
      return { ok: false, error: e.code === 'http' && e.detail ? `Burst refused it: ${e.detail}` : e.code === 'timeout' ? 'Burst did not answer in time.' : 'Could not change Burst\'s setting. Nothing was changed.' };
    }
    setPref(mode); apply();
    return { ok: true, view: view() };
  }

  // The This Mac readout. Programs holding the Mac awake come from the operating system and need no
  // Burst; everything else is Burst's own answer, null when it is absent. Never a hotspot password.
  async function macView() {
    if (!isMac) return null;
    const others = (await listAssertions({ platform: 'darwin' }).catch(() => [])).slice(0, 10).map((a) => ({ pid: a.pid, process: a.process, name: a.name, for: a.for || '' }));
    const url = present();
    const read = (name) => (url && burst.read ? burst.read(name).catch(() => null) : Promise.resolve(null));
    const [mac, automask, settings] = await Promise.all([read('mac'), read('automask'), read('settings')]);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const ka = mac ? obj(mac.keep_awake) : null;
    const live = ka ? obj(ka.live) : {};
    const pref = getPref();
    let drift = '';
    if (ka) {
      if (ka.problem) drift = `Burst says its setting is saved but not applied on this Mac: ${String(ka.problem).slice(0, 200)}`;
      else if ((pref === 'ac' || pref === 'always') && ka.mode !== pref) drift = `Plexiform is set to ${pref === 'always' ? 'plugged in and on battery' : 'plugged in only'}, but Burst has ${ka.mode === 'off' ? 'it off' : String(ka.mode)}.`;
      else if (pref === 'off' && ka.mode && ka.mode !== 'off') drift = 'Burst is keeping this Mac awake although the switch above is off.';
      else if (ka.mode && ka.mode !== 'off' && live.sleep_disabled === false) drift = 'Burst has it on, but the Mac is not actually staying awake with the lid shut right now.';
    }
    const hs = settings ? obj(settings.hotspot) : null;
    const am = automask ? { enabled: automask.enabled === true, rules: (Array.isArray(automask.rules) ? automask.rules : []).filter((r) => r && r.on === true).length } : null;
    const st = (burst.snapshot().d || {}).state;
    const mode = st && st.mode;
    const remote = !url || !mode ? null : mode === 'transparent' ? 'Remote Control keeps working: Burst is in transparent mode.' : 'Burst is in base-URL mode, which turns Claude Code\u2019s Remote Control off.';
    return {
      others,
      burst: url ? {
        keepAwake: ka ? { mode: String(ka.mode || 'off'), idleMinutes: Number(ka.idle_minutes) || 0, onAc: live.on_ac === true, sleepDisabled: live.sleep_disabled === true, drift } : null,
        hotspot: hs ? { ssid: String(hs.ssid || ''), when: String(hs.when || ''), online: hs.online === true } : null,
        automask: am,
        remote,
      } : null,
    };
  }

  utilityHandle('keepawake:mac', allowed, async () => macView());
  utilityHandle('keepawake:get', allowed, async () => view());
  utilityHandle('keepawake:set', allowed, async (_e, req) => set(req));
  apply();
  return { view, set, macView, sync: (sessions) => keepAwake.sync(sessions), hold: (on) => keepAwake.setHold(on) };
}

module.exports = { register, consent, IDLE_MINUTES };
