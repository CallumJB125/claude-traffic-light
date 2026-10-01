// The feedback form. Text goes in with textContent only; every action is a
// call into main through the preload.
(function () {
  const api = window.feedbackApi;
  const $ = (id) => document.getElementById(id);
  const say = (t, bad) => { $('status').textContent = t; $('status').dataset.state = bad ? 'err' : ''; };
  const draft = () => ({
    kind: document.querySelector('input[name="kind"]:checked').value,
    text: $('text').value, expected: $('expected').value,
    diagnostics: $('diag-on').checked, screenshot: $('shot-on').checked && !$('shot').hidden,
  });

  async function capture() {
    const r = await api.screenshot($('shot-which').value);
    if (!r || r.error) { $('shot').hidden = true; $('shot-caption').textContent = (r && r.error) || 'Could not capture.'; return; }
    $('shot').src = r.dataUrl;
    $('shot').hidden = false;
    $('shot-caption').textContent = `This is ${r.label}. Only Plexiform's own windows are captured, never your screen or other apps.`;
  }

  $('shot-on').addEventListener('change', async () => {
    $('shot-wrap').hidden = !$('shot-on').checked;
    if (!$('shot-on').checked) { $('shot').hidden = true; api.clearScreenshot(); return; }
    await capture();
  });
  $('shot-which').addEventListener('change', capture);

  $('see').addEventListener('click', async () => {
    const box = $('included');
    if (!box.hidden) { box.hidden = true; return; }
    const r = await api.preview({ ...draft(), text: $('text').value || '(nothing written yet)', diagnostics: true });
    box.textContent = r && !r.error ? `${r.markdown}${$('diag-on').checked ? `\n--- diagnostics.txt ---\n${r.diagnostics}` : '\n(Diagnostics are switched off.)'}` : 'Could not build the preview.';
    box.hidden = false;
  });

  $('save').addEventListener('click', async () => {
    say('');
    const r = await api.save(draft());
    if (!r || r.error) { say((r && r.error) || "Couldn't save the report.", true); return; }
    $('form').hidden = true;
    $('done').hidden = false;
  });
  $('show').addEventListener('click', () => api.showReport());
  $('copy').addEventListener('click', async () => { await api.copyReport(); say('Copied.'); });
  $('github').addEventListener('click', () => api.openGithub());

  (async () => {
    const info = await api.info();
    if (!info) return;
    for (const w of info.windows) { const o = document.createElement('option'); o.value = w.id; o.textContent = w.label; $('shot-which').append(o); }
    if (!info.windows.length) { $('shot-on').disabled = true; $('shot-caption').textContent = 'No Plexiform window is open to capture.'; }
    $('github').hidden = !info.github;
  })();
})();
