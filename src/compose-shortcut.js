'use strict';
// The task box's global shortcut (plan-orchestrator O4, review round 1). Off on every OS by default: ⇧⌘Space
// (Ctrl+Shift+Space elsewhere) is VS Code's and Cursor's "Trigger Parameter Hints", and registering it succeeds, so a
// default would silently take that key from the person's editor (team-lead, 2026-10-24). The person turns it on.
// The widget and voice keys always win: compose never registers a key either of them is configured to use, and it
// compares canonical accelerators, so CmdOrCtrl+Shift+Space and Shift+Command+Space are one key. The check reads
// config, never another module's live registration (review R2).
const WidgetPage = require('./widget-page.js');
const Voice = require('./voice.js');

const SUGGESTED = 'CommandOrControl+Shift+Space';
const ORDER = ['Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

/** One spelling per key: Cmd/Command/CmdOrCtrl/CommandOrControl → Command on macOS (Control elsewhere), Option → Alt, Ctrl → Control, Meta → Super; modifiers in a fixed order. */
function canonicalAccelerator(a, platform = process.platform) {
  const clean = WidgetPage.cleanAccelerator(a);
  if (!clean) return null;
  const parts = clean.split('+');
  const key = parts.pop();
  const mac = platform === 'darwin';
  const map = (m) => {
    const l = m.toLowerCase();
    if (l === 'command' || l === 'cmd') return mac ? 'Command' : 'Super';
    if (l === 'commandorcontrol' || l === 'cmdorctrl') return mac ? 'Command' : 'Control';
    if (l === 'control' || l === 'ctrl') return 'Control';
    if (l === 'alt' || l === 'option') return 'Alt';
    if (l === 'meta' || l === 'super') return mac ? 'Command' : 'Super';
    if (l === 'altgr') return 'AltGr';
    return 'Shift';
  };
  const mods = [...new Set(parts.map(map))].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** How the one-click button names the suggested key on this OS. */
const suggestedLabel = (platform = process.platform) => (platform === 'darwin' ? '⇧⌘Space' : 'Ctrl+Shift+Space');

/** The keys compose must leave alone, from config: the widget's and the voice key. */
function reserved(c, platform) {
  const out = [];
  const w = canonicalAccelerator(c?.widgetShortcut, platform);
  if (w) out.push({ key: w, owner: 'widget' });
  // Voice keys are bare F13–F19 (src/voice.js); compose always has a modifier, so this only guards a future change.
  const hk = Voice.hotkey(Voice.normalizeConfig(c?.voice).hotkey);
  if (hk) out.push({ key: hk.accelerator, owner: 'voice' });
  return out;
}

/**
 * deps: { globalShortcut, config() (loadConfig), onPress(), platform?, enabled? (false in a dev run: nothing is
 *         registered, specs press it through main's gated hook), log? }
 * Order (review R5): config-effects calls apply() before the widget and voice lines, so compose has always let go of a
 * key before either of them tries it, and the widget's own "last tried" cache never records a key compose held.
 */
function install(deps) {
  const platform = deps.platform || process.platform;
  const log = deps.log || (() => {});
  let held = null;        // the accelerator compose has registered
  let tried;              // the inputs last applied, so nothing is retried until one of the three settings changes
  let status = { accelerator: null, state: 'off' }; // off | on | taken | widget | voice | dev

  function release() {
    if (!held) return;
    try { deps.globalShortcut.unregister(held); } catch { /* already gone */ }
    held = null;
  }

  /** Re-apply from config c. Called before the widget and voice lines whenever any of the three keys changes (R5). */
  function apply(c = deps.config()) {
    const want = WidgetPage.cleanAccelerator(c?.composeShortcut);
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
      try { ok = deps.globalShortcut.register(want, () => { try { deps.onPress(); } catch (e) { log(`[compose] ${e?.message ?? e}`); } }); } catch { ok = false; }
      if (ok) { held = want; status = { accelerator: want, state: 'on' }; }
      else { status = { accelerator: want, state: 'taken' }; log(`[compose] ${want} could not be registered (taken or not allowed)`); }
    }
    return status;
  }

  /** After the widget and voice lines: a key that was taken only because one of them still held it is tried once more. */
  function settle(c = deps.config()) {
    if (status.state !== 'taken') return status;
    tried = undefined;
    return apply(c);
  }

  /** What the settings field and compose:info show. */
  function view() {
    const s = status;
    const line = s.state === 'widget' ? 'Used by your widget shortcut, so the task box has none. Pick another key.'
      : s.state === 'voice' ? 'Used by your voice key, so the task box has none. Pick another key.'
        : s.state === 'taken' ? 'Another app already uses this key, so the task box has none. Pick another key.'
          : '';
    return { accelerator: s.accelerator, state: s.state, line, suggested: SUGGESTED, suggestedLabel: suggestedLabel(platform),
      editorNote: `This takes ${suggestedLabel(platform)} from every app, including Parameter Hints in VS Code and Cursor. Clear the field to give it back.` };
  }

  return { apply, settle, view, release, get held() { return held; } };
}

module.exports = { install, canonicalAccelerator, suggestedLabel, reserved, SUGGESTED };
