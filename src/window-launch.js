// Whether the Buddy window (sidebar + pages) should open for a launch event.
// A normal launch, a dock click / re-open and a bare second launch show it;
// Open at Login and hook-triggered starts stay quiet (widget only), and dev,
// demo and visual-test runs keep opening only what their flags ask for.
const LOGIN_ACTIVATE_GRACE_MS = 10000;

function shouldOpenWindowOnLaunch({ event = 'launch', devRun = false, atLogin = false, hookLaunch = false, windowVisible = false, sinceLaunchMs = Infinity } = {}) {
  if (devRun || hookLaunch) return false;
  if (event === 'second-instance') return true;
  if (event === 'activate') return !windowVisible && !(atLogin && sinceLaunchMs < LOGIN_ACTIVATE_GRACE_MS);
  return !atLogin && !windowVisible;
}

function launchedAtLogin({ app, argv = process.argv, platform = process.platform }) {
  if (argv.includes('--hidden') || argv.includes('--autostart')) return true;
  if (platform !== 'darwin' && platform !== 'win32') return false;
  try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
}

module.exports = { shouldOpenWindowOnLaunch, launchedAtLogin, LOGIN_ACTIVATE_GRACE_MS };
