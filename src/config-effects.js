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
  if (hit('voice')) d.applyVoiceHotkey();
  d.broadcastStatus();
}

module.exports = { applyConfigSideEffects };
