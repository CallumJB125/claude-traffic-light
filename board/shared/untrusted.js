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
// Lookalikes NFKC leaves alone: Cyrillic о, division slash ∕, modifier
// arrowhead ˂ and single guillemet ‹. One code unit each, so offsets in the
// folded copy are offsets in the text.
const CONFUSABLES = { '\u043e': 'o', '\u2215': '/', '\u02c2': '<', '\u2039': '<' };
const CONFUSABLE = /[\u043e\u2215\u02c2\u2039]/g;
// Any "<untrusted…" (the envelope's own tag, with or without a nonce, is one).
const ENVELOPE = /<\s*(\/?)\s*(untrusted)/gi;

/**
 * NFKC first (fullwidth ＜ and other compatibility forms fold to ASCII), then
 * drop invisibles, then defuse every "<untrusted" / "</untrusted" found in a
 * confusables-folded copy. Only the matches change; other text keeps its
 * original characters.
 */
export function neutralise(text) {
  const t = String(text ?? '').normalize('NFKC').replace(INVISIBLE, '');
  const folded = t.replace(CONFUSABLE, (c) => CONFUSABLES[c]);
  let out = '';
  let last = 0;
  for (const m of folded.matchAll(ENVELOPE)) {
    out += `${t.slice(last, m.index)}&lt;${m[1]}${m[2]}`;
    last = m.index + m[0].length;
  }
  return out + t.slice(last);
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
