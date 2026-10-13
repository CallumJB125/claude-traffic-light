// The gallery page's search and filters. The list is built into the page at
// deploy time; this only shows and hides items, so it never writes markup.
(function () {
  const list = document.getElementById('cg-list');
  if (!list) return;
  const items = [...list.querySelectorAll('.cg-item')];
  const search = document.getElementById('cg-search');
  const stack = document.getElementById('cg-stack');
  const count = document.getElementById('cg-count');
  const chips = [...document.querySelectorAll('[data-cg-kind]')];
  let kind = '';
  function apply() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const li of items) {
      const ok = (!kind || li.dataset.kind === kind)
        && (!stack.value || li.dataset.stacks.split(' ').some((s) => s === stack.value || s === 'any'))
        && words.every((w) => li.dataset.text.includes(w));
      li.hidden = !ok;
      if (ok) shown += 1;
    }
    count.textContent = shown === items.length ? `${items.length} items` : `${shown} of ${items.length} items`;
  }
  for (const chip of chips) chip.addEventListener('click', () => {
    kind = chip.dataset.cgKind;
    for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
    apply();
  });
  search.addEventListener('input', apply);
  stack.addEventListener('change', apply);
  apply();
})();
