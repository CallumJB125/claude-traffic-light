// Burst status chip for the widget and the Usage header. Receives only the
// normalized {tone, label} from main (null on Windows/Linux or when Burst is
// not installed, which hides it). Polls only while the page is visible, at the
// interval main asks for; it stops for good when main says 0.
(() => {
  const api = (window.trafficLight && window.trafficLight.burstChip) ? window.trafficLight : (window.lightsApi && window.lightsApi.burstChip) ? window.lightsApi : null;
  if (!api) return;
  const widget = api === window.trafficLight;
  const host = widget ? document.body : document.querySelector('#mix > div');
  if (!host) return;
  const COLORS = { green: '#3fb950', amber: '#d29922', red: '#f85149', grey: '#8b949e' };
  const chip = document.createElement('div');
  chip.id = 'burst-chip';
  chip.hidden = true;
  chip.setAttribute('role', 'status');
  chip.title = 'Claude Burst';
  chip.style.cssText = widget
    ? 'position:fixed;left:50%;bottom:2px;transform:translateX(-50%);font:600 9px system-ui,sans-serif;padding:1px 6px;border-radius:8px;background:rgba(20,20,24,.82);color:#eee;white-space:nowrap;pointer-events:none;z-index:5'
    : 'display:inline-block;margin-top:4px;font:600 12px system-ui,sans-serif;padding:2px 9px;border-radius:10px;background:rgba(128,128,140,.18)';
  const dot = document.createElement('span');
  dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:baseline';
  const text = document.createElement('span');
  chip.append(dot, text);
  host.append(chip);

  let timer = null;
  let stopped = false;
  let onScreen = widget;
  async function poll() {
    clearTimeout(timer);
    if (stopped || !onScreen || document.visibilityState !== 'visible') return;
    let next = 30000;
    try {
      const r = await api.burstChip();
      const c = r && r.chip;
      chip.hidden = !c;
      if (c) { text.textContent = c.label; chip.title = c.tag ? `Claude Burst \u00b7 ${c.tag}` : 'Claude Burst'; dot.style.background = COLORS[c.tone] || COLORS.grey; }
      next = r && r.nextPollMs;
      if (!next) { stopped = true; return; }
    } catch { /* retry at the slow interval */ }
    timer = setTimeout(poll, next);
  }
  if (!widget) new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) poll(); else clearTimeout(timer); }).observe(host);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(timer); });
  poll();
})();
