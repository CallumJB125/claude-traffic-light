const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Team, This Mac and board copy no longer uses Runners, observed, hub or Tackle jargon', () => {
  const banned = [/'Runners'/, /Team hub address/, /team hub’s address/, /Last report:/, /Paused: limit/, /Handing over'/, /Handed over'/, /Tackle with AI/, /label: 'Observed'/];
  for (const f of ['buddy-window/account.js', 'buddy-window/brand.js', 'board/shared/cardface.js', 'board/web/js/render-board.js', 'board/web/js/render-dialogs.js', 'board/web/js/history.js', 'board/web/js/view.js', 'board/web/js/palette.js', 'tasks.html']) {
    const src = read(f);
    for (const re of banned) assert.doesNotMatch(src, re, `${f} still has ${re}`);
  }
});

test('plan limit is amber and not a failure cross', () => {
  assert.match(read('board/shared/cardface.js'), /failed_limit: \{ icon: '⏸', label: 'Plan limit reached', tone: 'amber' \}/);
});
