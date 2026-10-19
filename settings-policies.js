// Settings → Privacy and data → Policies. A file of its own so the block can
// move with the Settings split; text goes in with textContent only. Nothing is
// written until the person has seen the exact file and pressed Write.
(function () {
  const api = window.settingsApi;
  const $ = (id) => document.getElementById(id);
  const block = $('policies');
  if (!block || !api || !api.policyState) return;
  const repo = $('policy-repo');
  const pack = $('policy-pack');
  let data = null;
  let reviewed = null;
  const say = (text) => { $('policy-status').textContent = text; };

  // Its own saves: the page-wide change listener must not save the config.
  block.addEventListener('change', (e) => e.stopPropagation());

  function describe(p) {
    if (!p) return 'No policy.';
    const where = p.source === 'repo' ? 'this repo’s .plexiform/policy.json' : p.source === 'default' ? 'your default policy' : null;
    const now = p.name ? `Under “${p.name}” from ${where}.${p.budget ? ` Budget: ${p.budget}.` : ''}` : 'No policy applies.';
    return p.warnings && p.warnings.length ? `${now} ${p.warnings.join(' ')}` : now;
  }

  function showCurrent() {
    if (!data) return;
    const r = repo.value === 'default' ? { name: data.default.name, source: data.default.name ? 'default' : null, warnings: data.default.warnings } : data.repos.find((x) => x.root === repo.value);
    $('policy-current').textContent = repo.value === 'default'
      ? (r.name ? `Your default is “${r.name}”.${r.budget ? ` Budget: ${r.budget}.` : ''} ${r.warnings.join(' ')}` : `No default policy. ${r.warnings.join(' ')}`).trim()
      : describe(r);
    const p = data.packs.find((x) => x.id === pack.value);
    $('policy-desc').textContent = p ? p.description : '';
  }

  function hideConfirm() { reviewed = null; $('policy-confirm').hidden = true; }

  function addRepo(r) {
    if (!data.repos.some((x) => x.root === r.root)) data.repos.push(r);
    if (!repo.querySelector(`option[value="${CSS.escape(r.root)}"]`)) repo.append(new Option(`${r.label} (${r.root})`, r.root));
    repo.value = r.root;
  }

  async function refresh() {
    data = await api.policyState().catch(() => null);
    if (!data || data.error) { say('Policies are unavailable right now.'); return; }
    const keepRepo = repo.value;
    const keepPack = pack.value;
    repo.replaceChildren(new Option('Default for every repo without its own policy', 'default'));
    for (const r of data.repos) repo.append(new Option(`${r.label} (${r.root})`, r.root));
    pack.replaceChildren(...data.packs.map((p) => new Option(p.name, p.id)));
    if ([...repo.options].some((o) => o.value === keepRepo)) repo.value = keepRepo;
    if (keepPack) pack.value = keepPack;
    showCurrent();
  }

  repo.addEventListener('change', () => { hideConfirm(); showCurrent(); });
  pack.addEventListener('change', () => { hideConfirm(); showCurrent(); });
  $('policy-pick').addEventListener('click', async () => {
    const r = await api.policyPickFolder().catch(() => null);
    if (!r || r.error) return;
    hideConfirm();
    addRepo(r);
    showCurrent();
  });
  $('policy-review').addEventListener('click', async () => {
    say('');
    const req = { target: repo.value, pack: pack.value };
    const r = await api.policyPreview(req).catch((err) => ({ error: err.message }));
    if (!r || r.error) { hideConfirm(); say(r ? r.error : 'Could not prepare the file.'); return; }
    reviewed = { ...req, content: r.content };
    $('policy-path').textContent = r.current == null ? `Plexiform will create ${r.path} with exactly this:` : `Plexiform will replace ${r.path} (it already has a policy) with exactly this:`;
    $('policy-content').textContent = r.content;
    $('policy-confirm').hidden = false;
  });
  $('policy-cancel').addEventListener('click', () => { hideConfirm(); say('Cancelled. Nothing was written.'); });
  $('policy-write').addEventListener('click', async () => {
    if (!reviewed) return;
    const r = await api.policyApply(reviewed).catch((err) => ({ error: err.message }));
    hideConfirm();
    if (!r || r.error) { say(r ? r.error : 'Could not write the file.'); return; }
    say(`Written: ${r.path}. New tool calls and prompts in that repo follow it now.`);
    await refresh();
  });
  refresh();
})();
