// The untrusted-content envelope (CONTRACT §7.4, D30). Everything people or
// earlier runs wrote reaches the agent inside it, so the model can always tell
// board data from the runner's own instructions. Browser-safe, dependency-free:
// the caller supplies the per-run nonce (runner: node:crypto).

export const UNTRUSTED_TAG = 'untrusted_board_content';
export const NONCE_RE = /^[0-9a-f]{8,64}$/;

// Invisible code points (format controls such as U+200B and the other
// default-ignorables) can split a tag so a regex misses it while the model
// still reads it as one.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ENVELOPE = new RegExp(`<\\s*(\\/?)\\s*(${UNTRUSTED_TAG})`, 'gi');

/**
 * NFKC first (fullwidth ＜ and other compatibility forms fold to ASCII), then
 * drop invisibles, then defuse every envelope tag, with or without a nonce.
 */
export function neutralise(text) {
  return String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(ENVELOPE, '&lt;$1$2');
}

export function envelopeTag(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new TypeError('untrusted(): a per-run hex nonce is required');
  return `${UNTRUSTED_TAG}_${nonce}`;
}

/** Wrap untrusted text in `<untrusted_board_content_<nonce> source="…">…</…_<nonce>>`. */
export function untrusted(source, text, nonce) {
  const tag = envelopeTag(nonce);
  const src = neutralise(source).replace(/["<>&\r\n]/g, ' ').slice(0, 200);
  return `<${tag} source="${src}">\n${neutralise(text)}\n</${tag}>`;
}
