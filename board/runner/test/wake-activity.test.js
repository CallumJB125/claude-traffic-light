// A throttled pre-sleep event must not become fresh activity after wake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Run, ACTIVITY_THROTTLE_MS } from '../run.js';
import { fakeClock } from './helpers.js';

test('wake discards throttled pre-sleep activity; only new activity is sent after recovery', () => {
  const clock = fakeClock();
  const sent = [];
  const run = new Run({ clock, opts: {}, log: {}, emitOut: (_run, msg) => sent.push(msg) }, {
    run_id: 'run-wake', card_id: 'card-wake', fence: 1, repo_id: 'repo-wake',
  });
  run.sawInit = true;
  run.firstActivity = true;
  run.lastActivitySentMono = clock.mono();
  run.activity('tool_start');
  const preSleepActivity = run.lastActivityMono;
  assert.equal(run.pendingActivity, 'tool_start');

  clock.advance(ACTIVITY_THROTTLE_MS + 1000);
  run.onWake(ACTIVITY_THROTTLE_MS + 1000);
  run.tick();
  assert.deepEqual(sent.filter((msg) => msg.kind === 'activity'), [], 'pre-sleep activity is never emitted as fresh after wake');
  assert.equal(run.lastActivityMono, preSleepActivity, 'wake keeps the real activity age');
  assert.equal(run.hb().post_wake_activity, false);

  run.activity('tool_end');
  run.tick();
  assert.deepEqual(sent.filter((msg) => msg.kind === 'activity').map((msg) => msg.source), ['tool_end']);
  assert.equal(run.hb().post_wake_activity, true);
});
