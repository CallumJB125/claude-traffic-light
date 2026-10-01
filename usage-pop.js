// textContent only: the summary comes from main already worded.
function show(s) {
  const rows = document.getElementById('rows');
  rows.replaceChildren();
  for (const r of s.rows) {
    const wrap = document.createElement('div');
    wrap.className = 'row';
    const dt = document.createElement('dt');
    dt.textContent = r.label;
    const dd = document.createElement('dd');
    dd.textContent = r.value;
    wrap.append(dt, dd);
    rows.append(wrap);
  }
  if (s.empty) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = s.empty;
    rows.append(p);
  }
  document.getElementById('note').textContent = s.note;
}

window.usagePop.onUpdate(show);
window.usagePop.get().then(show);
document.getElementById('full').addEventListener('click', () => window.usagePop.openFull());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.usagePop.close(); });
