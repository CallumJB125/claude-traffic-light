// Voice reply in a session: the browser's own speech recognition dictates into
// the reply box. Nothing is sent automatically; the person still presses Send.
// Plexiform's code never handles audio; depending on the browser, the speech
// service (Apple or Google) may receive it to turn it into text.

/** The browser's SpeechRecognition constructor, or null when there is none. */
export function speechRecognition(g = globalThis) {
  return g?.SpeechRecognition || g?.webkitSpeechRecognition || null;
}

export const speechSupported = (g = globalThis) => typeof speechRecognition(g) === 'function';

/** Dictated text appended to what is already typed (never replacing it), capped at max. */
export function appendDictation(existing, transcript, max = 4000) {
  const t = String(transcript ?? '').replace(/\s+/g, ' ').trim();
  const cur = String(existing ?? '');
  if (!t) return cur;
  const next = cur.trim() ? `${cur.replace(/\s+$/, '')} ${t}` : t;
  return next.slice(0, max);
}

/**
 * Listen once and put the words into box (a textarea-like {value, disabled}).
 * Returns the recognizer, or null when speech or the box is unavailable.
 */
export function dictateInto(box, { g = globalThis, lang, max = 4000, onEnd = () => {} } = {}) {
  const SR = speechRecognition(g);
  if (typeof SR !== 'function' || !box || box.disabled) return null;
  const rec = new SR();
  rec.lang = lang || g.navigator?.language || 'en-US';
  rec.interimResults = false;
  rec.continuous = false;
  rec.onresult = (ev) => {
    const words = Array.from(ev.results ?? []).map((r) => r[0]?.transcript ?? '').join(' ');
    box.value = appendDictation(box.value, words, max);
    box.dispatchEvent?.(new g.Event('input', { bubbles: true }));
  };
  rec.onend = () => onEnd();
  rec.onerror = () => onEnd();
  rec.start(); // privacy-flow: phone-voice-reply
  return rec;
}
