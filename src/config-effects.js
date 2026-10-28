// What a changed setting has to reach outside config.json. Shared by a normal
// save and by a restore, so a restored config does not leave the running app
// disagreeing with it (a Tailscale listener still up, hooks still installed).
// `touched(key)` lets a save count a key it named even if the value is the same.
function applyConfigSideEffects(prev, next, d, touched) {
  const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
  const hit = touched || changed;
  if (!!prev.askFromWidget !== !!next.askFromWidget) d.installHooks();
  if (next.busyCalendar === true && !prev.busyCalendar) d.enableCalendar();
  if (hit('showWidget')) d.applyWidgetVisibility();
  if (hit('remoteTailscale')) d.syncTailnetListener();
  if (hit('remoteInteractionHost') || hit('teamSessionSharing')) d.syncInteractionHost?.();
  if (hit('menuBarMode') || hit('showWidget')) d.createTray();
  // The task box's shortcut first whenever any of the three keys changes (review R5): the widget and voice keys
  // win, so compose lets go of a key before either of them takes it.
  const composeHit = hit('composeShortcut') || hit('widgetShortcut') || hit('voice');
  // QoL3a: the next-waiting key yields to all three, so it lets go first and settles last.
  const nextHit = composeHit || hit('nextShortcut');
  if (nextHit) d.nextShortcut?.(next);
  if (composeHit) d.composeShortcut?.(next);
  if (hit('voice')) d.applyVoiceHotkey();
  if (hit('lowPower')) d.applyLowPower?.();
  if (hit('fastHook')) d.syncFastHook?.();
  if (hit('agentMailInbox')) d.syncAgentMail?.();
  if (hit('agentBus')) d.syncAgentBus?.();
  if (hit('widgetShortcut') || hit('widgetSize')) d.widgetPolish?.(prev, next);
  // C4: "Show chats" (homeComposer) flipped: the main window drops a showing new chat and tells its sidebar.
  if ((prev.homeComposer !== false) !== (next.homeComposer !== false)) d.chatsChanged?.();
  // Then once more if it was taken: clearing the widget's key gives the task box the key it was waiting for.
  if (composeHit) d.composeShortcutSettle?.(next);
  if (nextHit) d.nextShortcutSettle?.(next);
  d.broadcastStatus();
}

module.exports = { applyConfigSideEffects };
