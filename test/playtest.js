// Runs inside the Lights window (see main.js --playtest). Drives the real DOM
// like a user would and reports what broke. Restores the saved config at the
// end so a run never changes the user's rules.
(async () => {
  const log = [];
  let failed = 0;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (cond, msg) => { log.push(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failed += 1; };
  const rows = () => Array.from(document.querySelectorAll('#rule-list .rule'));
  const selectedRow = () => document.querySelector('#rule-list .rule.selected');
  const rowByName = (n) => rows().find((r) => r.querySelector('.name span:last-child').textContent === n);
  const fire = (el, type, init = {}) => el.dispatchEvent(new (type.startsWith('key') ? KeyboardEvent : Event)(type, { bubbles: true, cancelable: true, ...init }));
  const setInput = (el, v) => { el.value = v; fire(el, 'input'); fire(el, 'change'); };
  const stageLook = () => { const s = document.querySelector('#stage-rig svg'); return { cls: s.className.baseVal, eye: s.style.getPropertyValue('--eye-color'), lampOn: Array.from(new Set(Array.from(s.querySelectorAll('.lamp.on')).map((l) => l.dataset.slot).filter((x) => x !== 'any'))).join(',') || 'off' }; };

  const original = await window.lightsApi.getConfig();
  try {
    // ── boot
    ok(rows().length === original.rules.length, `list shows ${original.rules.length} saved rules`);
    ok(selectedRow() && $('name').value === original.rules[0].name, 'first rule selected and loaded in editor');
    ok($('save-btn').disabled, 'Save disabled when clean');

    // ── select another row
    const second = rows()[1];
    second.click();
    ok($('name').value === original.rules[1].name, 'clicking a row loads it');
    ok(!$('save-btn').disabled === false, 'selecting does not dirty');

    // ── add a rule
    $('add-btn').click();
    ok(rows().length === original.rules.length + 1, 'New rule adds a row');
    ok(document.activeElement === $('name'), 'name field focused for the new rule');
    const firstUnlocked = original.rules.findIndex((r) => !r.locked);
    ok(selectedRow() === rows()[firstUnlocked], 'new rule lands just below the locked rules');
    setInput($('name'), 'Playtest rule');
    ok(rowByName('Playtest rule'), 'renaming updates the list live');
    ok(!$('save-btn').disabled, 'Save enabled once dirty');

    // ── signals + tool row
    const toolRowVisibleBefore = !$('tool-row').hidden;
    ok(toolRowVisibleBefore, 'tool row visible for a tool signal');
    const chip = (label) => Array.from($('signals').querySelectorAll('.signal')).find((b) => b.textContent.trim() === label);
    chip('Claude uses a tool').click();
    ok(!chip('Claude uses a tool').classList.contains('on'), 'toggling a signal off');
    ok($('tool-row').hidden, 'tool row hides when no tool signal is selected');
    chip('Claude finishes a task').click();
    chip('3+ sessions at once').click();
    ok(chip('3+ sessions at once').classList.contains('on') && chip('Claude finishes a task').classList.contains('on'), 'multiple signals select');
    setInput($('tool'), 'mcp__*');

    // ── then: lamp, eyes, pose
    const lampBtns = Array.from($('lamps').querySelectorAll('.lampbtn'));
    lampBtns.find((b) => b.classList.contains('amber')).click();
    ok(stageLook().lampOn === 'amber', 'picking a lamp lights it on the stage');
    setInput($('eye-color'), '#ff00aa');
    ok(stageLook().eye === '#ff00aa', 'custom eye colour reaches the stage');
    const poseBtn = (p) => Array.from($('poses').querySelectorAll('.posebtn')).find((b) => b.title === p);
    poseBtn('bounce').click();
    ok(stageLook().cls.includes('pose-bounce'), 'pose applies on the stage');
    ok(poseBtn('bounce').classList.contains('on'), 'pose button shows selected');
    ok(Array.from($('poses').querySelectorAll('.posebtn')).length === 30, 'all 29 poses + keep are offered');
    ok($('text-row').hidden, 'banner text row hidden for a non-banner pose');
    poseBtn('banner').click();
    ok(!$('text-row').hidden, 'banner text row appears for the banner pose');
    setInput($('text'), 'feed me tokens please now');
    ok(document.querySelector('#stage-rig .banner-text').textContent === 'FEED ME TOKENS PLEASE NO', 'banner text reaches the stage, capitalised and capped');
    poseBtn('ak47').click();
    ok(stageLook().cls.includes('pose-ak47'), 'ak47 pose applies');
    poseBtn('bounce').click();
    const costumeBtn = (c) => Array.from($('costumes').querySelectorAll('.posebtn')).find((b) => b.title === c);
    ok(Array.from($('costumes').querySelectorAll('.posebtn')).length === 15, 'all 14 costumes + keep are offered');
    costumeBtn('unicorn').click();
    ok(stageLook().cls.includes('costume-unicorn'), 'costume applies on the stage');
    const pick = (id, title) => Array.from($(id).querySelectorAll('.posebtn')).find((b) => b.title === title).click();
    pick('signs', 'h5'); ok(stageLook().cls.includes('sign-h5'), 'sign layout applies on the stage');
    pick('shapes', 'heart'); ok(document.querySelector('#stage-rig .sign-h5 .lamp').getAttribute('href') === '#lamp-heart', 'lamp shape swaps the symbol');
    pick('signfx', 'neon'); ok(stageLook().cls.includes('signfx-neon'), 'sign effect applies');
    setInput($('number'), 'tasks');
    Array.from($('screenfx').querySelectorAll('button')).find((b) => b.textContent === 'confetti').click();
    pick('lampfx', 'strobe'); ok(stageLook().cls.includes('lampfx-strobe'), 'lamp effect applies on the stage');
    pick('bodies', 'robot'); ok(stageLook().cls.includes('body-robot'), 'body swap applies on the stage');
    pick('effects', 'rain'); ok(stageLook().cls.includes('effect-rain'), 'effect applies on the stage');
    pick('pets', 'duck'); ok(stageLook().cls.includes('pet-duck'), 'pet applies on the stage');
    pick('moods', 'heart'); ok(stageLook().cls.includes('eyes-heart'), 'mood eyes apply on the stage');
    setInput($('body-color'), '#1155cc');
    ok(document.querySelector('#stage-rig svg').style.getPropertyValue('--body-color') === '#1155cc', 'body colour reaches the stage');
    setInput($('cwd'), 'bondly*');
    setInput($('source'), 'cursor');
    const clickSel = $('click-field').querySelector('select');
    setInput(clickSel, 'url');
    ok(!$('click-field').querySelector('input').hidden, 'argument field appears for actions that take one');
    setInput($('click-field').querySelector('input'), 'https://example.com');
    setInput($('double-field').querySelector('select'), 'snooze');
    setInput($('sound'), 'Glass');
    ok(!$('sound-play').disabled, 'sound picked enables play');
    setInput($('eye-color'), '#ff00aa');
    setInput($('lamp-color'), '#00ffff');
    ok(document.querySelector('#stage-rig svg').style.getPropertyValue('--lamp-on') === '#00ffff', 'custom lamp colour reaches the stage');
    $('celebrate').checked = true; fire($('celebrate'), 'change');
    const chipsInRow = rowByName('Playtest rule').querySelectorAll('.chip').length;
    ok(chipsInRow === 8, `list row shows a chip per set channel (${chipsInRow})`);

    // ── keyboard reorder
    const me = rowByName('Playtest rule');
    const before = rows().indexOf(me);
    fire(me, 'keydown', { key: 'ArrowDown', altKey: true });
    ok(rows().indexOf(rowByName('Playtest rule')) === before + 1, 'alt+down moves the rule down');
    fire(rowByName('Playtest rule'), 'keydown', { key: 'ArrowUp', altKey: true });
    fire(rowByName('Playtest rule'), 'keydown', { key: 'ArrowUp', altKey: true });
    ok(rows().indexOf(rowByName('Playtest rule')) === firstUnlocked, 'cannot move above the locked rules');
    const lockedName = rows()[0].querySelector('.name span:last-child').textContent;
    fire(rows()[0], 'keydown', { key: 'ArrowDown', altKey: true });
    ok(rows()[0].querySelector('.name span:last-child').textContent === lockedName, 'locked rule does not move');
    fire(rowByName('Playtest rule'), 'keydown', { key: 'ArrowDown', altKey: true });
    ok(selectedRow() === rowByName('Playtest rule'), 'selection follows the moved rule');
    fire(rowByName('Playtest rule'), 'keydown', { key: 'ArrowUp', altKey: true });

    // ── locked protections
    const locked = rows()[0];
    locked.click();
    ok($('delete-btn').disabled, 'Delete disabled for a locked rule');
    ok($('enabled').disabled, 'Enabled toggle disabled for a locked rule');
    ok(locked.querySelector('input').disabled, 'list checkbox disabled for a locked rule');

    // ── stage caption explains composition
    rowByName('Subagent running')?.click();
    if (rowByName('Subagent running')) ok(/would come from/.test($('caption').textContent), 'caption explains which rule supplies the lamp');

    // ── save / revert round trip
    const dirtyCount = rows().length;
    $('save-btn').click();
    await sleep(150);
    const saved = await window.lightsApi.getConfig();
    ok(saved.rules.length === dirtyCount && saved.rules.some((r) => r.name === 'Playtest rule'), 'Save persists to config.json');
    ok($('save-btn').disabled, 'clean after save');
    const pt = saved.rules.find((r) => r.name === 'Playtest rule');
    ok(pt && pt.then.lamp === 'amber' && pt.then.lampColor === '#00ffff' && pt.then.eyes === '#ff00aa' && pt.then.pose === 'bounce' && pt.then.celebrate === true && pt.when.tool === 'mcp__*', 'saved rule carries every channel');
    ok(pt && pt.then.text === 'feed me tokens please no', 'banner text persists with the rule');
    ok(pt && pt.then.costume === 'unicorn', 'costume persists with the rule');
    ok(pt && pt.then.clicks.click.type === 'url' && pt.then.clicks.click.arg === 'https://example.com' && pt.then.clicks.double.type === 'snooze' && !pt.then.clicks.alt, 'programmed gestures persist');
    ok(pt && pt.then.lampFx === 'strobe', 'lamp effect persists');
    ok(pt && pt.then.sign === 'h5' && pt.then.lampShape === 'heart' && pt.then.signFx === 'neon' && pt.then.number === 'tasks' && pt.then.screenFx === 'confetti', 'sign, shape, sign effect, number and screen effect persist');
    ok(pt && pt.then.body === 'robot' && pt.then.effect === 'rain' && pt.then.pet === 'duck' && pt.then.bodyColor === '#1155cc' && pt.then.sound === 'Glass' && pt.when.cwd === 'bondly*' && pt.when.source === 'cursor', 'body, effect, pet, body colour, sound, project and agent scope persist');
    ok(pt && pt.when.signal.includes('many-sessions') && pt.when.signal.includes('stop') && !pt.when.signal.includes('tool-use'), 'saved rule carries the chosen signals');

    rowByName('Playtest rule').click();
    setInput($('name'), 'Renamed');
    $('revert-btn').click();
    ok(rowByName('Playtest rule') && !rowByName('Renamed'), 'Revert restores the saved rules');

    // ── delete via keyboard
    rowByName('Playtest rule').click();
    fire(rowByName('Playtest rule'), 'keydown', { key: 'Backspace' });
    ok(!rowByName('Playtest rule'), 'Backspace deletes an unlocked rule');
    ok(selectedRow(), 'selection moves to a neighbour after delete');

    // ── presets: built-in, then user-saved
    $('presets-btn').click();
    ok(!$('presets').hidden, 'Presets menu opens');
    document.querySelector('#presets [data-preset="party"]').click();
    ok(rows().some((r) => r.querySelector('.chip[title="pet: duck"]')), 'Party preset applies pets');
    $('presets-btn').click();
    document.querySelector('#presets [data-preset="minimal"]').click();
    ok($('presets').hidden, 'menu closes after picking');
    ok(rows().every((r) => !r.querySelector('.chip.pose-chip')), 'Minimal preset has no poses');
    $('presets-btn').click();
    ok($('preset-save').disabled, 'Save preset disabled with empty name');
    setInput($('preset-name'), 'Playtest set');
    ok(!$('preset-save').disabled, 'Save preset enabled once named');
    fire($('preset-form'), 'submit');
    await sleep(150);
    const mine = () => Array.from(document.querySelectorAll('#user-presets [data-user]')).find((b) => /playtest set/i.test(b.textContent));
    ok(!!mine(), 'user preset appears in the menu');
    let cfg = await window.lightsApi.getConfig();
    ok(cfg.presets.some((p) => p.name === 'Playtest set' && p.rules.length === rows().length), 'user preset persisted with its rules');
    // overwrite by same name keeps one entry
    setInput($('preset-name'), 'playtest SET');
    fire($('preset-form'), 'submit');
    await sleep(150);
    cfg = await window.lightsApi.getConfig();
    ok(cfg.presets.filter((p) => p.name.toLowerCase() === 'playtest set').length === 1, 'saving the same name overwrites instead of duplicating');
    document.querySelector('#presets [data-preset="classic"]').click();
    $('presets-btn').click();
    mine().click();
    ok(rows().every((r) => !r.querySelector('.chip.pose-chip')), 'applying the user preset restores its rules');
    $('presets-btn').click();
    mine().parentElement.querySelector('[data-remove]').click();
    await sleep(150);
    cfg = await window.lightsApi.getConfig();
    ok(!cfg.presets.some((p) => p.name.toLowerCase() === 'playtest set'), 'deleting a user preset persists');
    fire(window, 'keydown', { key: 'Escape' });
    ok($('presets').hidden, 'Escape closes the menu');

    // ── live mode + try on widget
    $('mode-live').click();
    await sleep(100);
    ok($('mode-live').classList.contains('on') && $('caption').textContent.length > 0, 'Live mode shows the live caption');
    $('mode-rule').click();
    $('try-btn').click();
    await sleep(150);
    const st = await window.lightsApi.getAggregateStatus();
    ok(st.reason === 'preview', 'Try on widget puts the widget into preview');

    // ── stats view
    $('view-stats').click();
    await sleep(150);
    ok($('main').dataset.view === 'stats' && $('rules').offsetParent === null, 'Stats view replaces the rules layout');
    ok($('chart').querySelectorAll('text').length >= 7, 'chart draws a label per day');
    ok(/working/.test($('stats-totals').textContent), 'totals line renders');
    $('view-rules').click();
    ok($('main').dataset.view === 'rules', 'back to rules');

    // ── empty state
    while (rows().some((r) => !r.classList.contains('locked'))) {
      const r = rows().find((x) => !x.classList.contains('locked'));
      r.click();
      fire(r, 'keydown', { key: 'Delete' });
    }
    ok(rows().length === 2 && /2 of 2 on/.test($('rule-count').textContent), 'only locked rules remain; count reads 2 of 2');
    $('revert-btn').click();
  } catch (e) {
    failed += 1;
    log.push(`✖ threw: ${e && e.stack ? e.stack : e}`);
  } finally {
    await window.lightsApi.saveConfig({ rules: original.rules, presets: original.presets || [] });
  }
  log.push(`— ${log.filter((l) => l.startsWith('✔')).length} passed, ${failed} failed`);
  return { log, failed };
})();
