// Nonces seen per device, kept until the decision they came with has expired
// (plus skew). A decision can't be valid after that, so the cache can forget
// it. Bounded: when full of live entries it refuses (fails closed) rather than
// evicting something still replayable.
export class ReplayCache {
  constructor({ max = 10000, clock = () => Date.now() } = {}) {
    this.max = max;
    this.clock = clock;
    this.seen = new Map(); // `${deviceId}:${nonce}` → keepUntil
  }

  #sweep() {
    const now = this.clock();
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
  }

  // 'ok' (recorded now), 'replay' (already seen) or 'full'.
  checkAndRecord(deviceId, nonce, keepUntil) {
    const k = `${deviceId}:${nonce}`;
    if (this.seen.has(k) && this.seen.get(k) > this.clock()) return 'replay';
    if (this.seen.size >= this.max) this.#sweep();
    if (this.seen.size >= this.max) return 'full';
    this.seen.set(k, keepUntil);
    return 'ok';
  }
}
