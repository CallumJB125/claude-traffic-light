// One plain-English sentence for a rule, shown under each rule in the Lights
// list and live in the editor: "When Claude asks permission, and it stays
// that way for over 5 minutes, show the knock pose and notify your phone."
// Pure: describeRule(rule, catalogue) where catalogue is rules.js SIGNALS
// (or any [{id, label}]). Loaded by <script> and by require.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformRuleWords = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KEEP_CASE = /^(Claude|CI|PR|3\+)\b/;
  const lower = (label) => (KEEP_CASE.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
  function joinOr(items, word) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
  }
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  const NOTIFY = { desktop: 'send a desktop notification', phone: 'notify your phone', both: 'notify you on your desktop and phone' };
  const BUSY = { always: 'ping even while you are busy', never: "hold its pings while you're busy", mine: 'ping while you are busy only for your own cards' };

  function condition(rule, catalogue) {
    const w = rule.when || {};
    const sigs = Array.isArray(w.signal) ? w.signal : w.signal ? [w.signal] : [];
    const labels = sigs.map((id) => {
      const s = (catalogue || []).find((x) => x.id === id);
      return lower(s ? s.label : id);
    });
    let out = labels.length ? `When ${joinOr(labels, 'or')}` : 'Never (no signal picked)';
    if (!labels.length) return out;
    if (w.tool) out += ` using ${w.tool}`;
    if (w.cwd) out += ` in ${w.cwd}`;
    if (w.source) out += ` from ${w.source}`;
    if (w.forMinutes) out += `, and it stays that way for over ${w.forMinutes} minute${w.forMinutes === 1 ? '' : 's'}`;
    return out;
  }

  function actions(t) {
    const out = [];
    if (t.lamp) out.push(t.lamp === 'off' ? 'turn the lamp off' : `turn the lamp ${t.lampColor && isHex(t.lampColor) ? 'a custom colour' : t.lamp}`);
    if (t.lampFx && t.lampFx !== 'none') out.push(`make it ${t.lampFx}`);
    if (t.pose && t.pose !== 'none') out.push(`show the ${t.pose} pose${t.text && (t.pose === 'banner' || t.pose === 'bubble') ? ` reading "${t.text}"` : ''}`);
    if (t.eyes && t.eyes !== 'default') out.push(t.eyes === 'closed' ? 'close the eyes' : isHex(t.eyes) ? 'recolour the eyes' : `give Claude ${t.eyes} eyes`);
    if (t.costume && t.costume !== 'none') out.push(`dress Claude as ${t.costume}`);
    if (t.cameo && t.cameo !== 'none') out.push('show a cameo face');
    if (t.effect && t.effect !== 'none') out.push(t.effect === 'beard' ? 'grow a beard' : `add ${t.effect}`);
    if (t.screenFx && t.screenFx !== 'none') out.push(`add a ${t.screenFx} screen effect`);
    if (t.pet && t.pet !== 'none') out.push(`bring the ${t.pet}`);
    if (t.number) out.push(`count ${t.number} on the sign`);
    if (t.sound) out.push(t.sound.startsWith('file:') ? 'play your sound file' : t.sound === 'beep' ? 'beep' : `play the ${t.sound} sound`);
    if (t.celebrate) out.push('burst confetti');
    if (NOTIFY[t.notify]) out.push(NOTIFY[t.notify]);
    if (BUSY[t.busyPing]) out.push(BUSY[t.busyPing]);
    if (t.pauseNudges) out.push('pause its other nudges until you acknowledge it');
    return out;
  }

  function describeRule(rule, catalogue) {
    if (!rule) return '';
    const acts = actions(rule.then || {});
    const what = acts.length ? joinOr(acts, 'and') : 'change nothing you can see';
    const sentence = `${condition(rule, catalogue)}, ${what}.`;
    return rule.enabled === false ? `Off. ${sentence}` : sentence;
  }
  return { describeRule };
});
