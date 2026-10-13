'use strict';
// Only the owning main controller supplies this captured WebContents and the
// current-view predicate. No IDs, OS screen or arbitrary renderer are accepted.
async function captureOwnedView(contents, current, { deadlineMs = 2000 } = {}) {
  let timer, expired = false;
  const live = () => { try { return !expired && !contents.isDestroyed() && current() === true; } catch { return false; } };
  if (!contents || typeof current !== 'function' || !live()) return null;
  try {
    return await Promise.race([
      (async () => {
        // A DOM-ready newly attached view may not yet have a Viz surface.
        // Both animation frames and native capture share one total cutoff.
        const ready = await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        if (ready !== true || !live()) return null;
        const image = await contents.capturePage(undefined, { stayHidden: true });
        return live() && image && !image.isEmpty() ? image : null;
      })(),
      new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, deadlineMs); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
module.exports = { captureOwnedView };
