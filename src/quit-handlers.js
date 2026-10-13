'use strict';
// One will-quit listener per app, however many modules need to clean up: Node
// warns (MaxListenersExceededWarning) once an emitter has more than ten.
const registries = new WeakMap();
function onQuit(app, handler) {
  let handlers = registries.get(app);
  if (!handlers) {
    handlers = [];
    registries.set(app, handlers);
    app.on('will-quit', (...args) => {
      for (const h of handlers.splice(0)) { try { h(...args); } catch { /* one failed cleanup must not skip the rest */ } }
    });
  }
  handlers.push(handler);
  return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); };
}
module.exports = { onQuit };
