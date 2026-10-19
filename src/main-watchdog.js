// A main thread stuck in a synchronous call (a file read waiting on a macOS
// privacy prompt, a hung native call) can't log anything, and console output
// from a worker is relayed through that same main thread. So a worker watches
// for the main thread's heartbeat and, when it stops, appends to app.log
// itself, naming the last startup step the main thread reached.

// Main-thread side. step() posts at once, so the worker knows the step even
// if the main thread blocks before its next beat.
function startMainWatchdog({ createWorker, intervalMs = 1000 }) {
  let worker;
  try {
    worker = createWorker();
    worker.unref?.();
    worker.on('error', () => { worker = null; });
  } catch {
    return { step() {}, stop() {} };
  }
  const beat = (step) => { try { worker?.postMessage({ at: Date.now(), step }); } catch { /* worker gone */ } };
  const timer = setInterval(() => beat(null), intervalMs);
  timer.unref?.();
  beat('load');
  return {
    step: (name) => beat(name),
    stop() { clearInterval(timer); worker?.terminate?.(); worker = null; },
  };
}

// Worker-side check, pure for the tests: → the line to log, or null.
function watchdogVerdict({ now, lastBeat, step, stallMs, reported }) {
  const gap = now - lastBeat;
  if (!reported && gap >= stallMs) {
    return `[watchdog] main thread blocked for ${Math.round(gap / 1000)} s (last startup step: ${step}); a synchronous file read can wait this long on a macOS privacy prompt (Desktop/Documents/Downloads access)`;
  }
  return null;
}

module.exports = { startMainWatchdog, watchdogVerdict };
