// Fence tokens: (epoch, n). `n` is the card's monotonic integer fence and the
// ONLY thing that decides validity; `epoch` is the hub_epoch that issued or
// last confirmed it, so a runner can tell a hub restart happened (first HB of
// a new epoch = design §4.1 #20). A restore from backup bumps n by 1000 so an
// older DB can never re-issue a fence a zombie still holds (design §5.3).
//
// Browser-safe, dependency-free.

export const RESTORE_BUMP = 1000;

export function makeFence(n, epoch) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`fence n must be a non-negative integer, got ${n}`);
  if (typeof epoch !== 'string' || !epoch) throw new TypeError('fence epoch must be a non-empty string');
  return Object.freeze({ n, epoch });
}

// Negative when a is older than b. Epoch never breaks ties: two tokens with
// the same n name the same lease, whichever epoch confirmed it.
export function compareFence(a, b) {
  return a.n - b.n;
}

export function isCurrent(held, current) {
  return !!held && !!current && held.n === current.n;
}

export function bump(f, epoch = f.epoch) {
  return makeFence(f.n + 1, epoch);
}

export function restoreBump(f, epoch) {
  return makeFence(f.n + RESTORE_BUMP, epoch);
}

// Wire form "n@epoch" for logs, run-token payloads and ref names that need
// both parts; JSON messages carry {n, epoch} or a bare integer `fence` where
// the epoch is implied by the connection's welcome.
export function formatFence(f) {
  return `${f.n}@${f.epoch}`;
}

export function parseFence(s) {
  const m = /^(\d+)@(.+)$/.exec(String(s));
  if (!m) throw new TypeError(`bad fence token: ${s}`);
  return makeFence(Number(m[1]), m[2]);
}

// Git names derived from the fence (design §5.3 "Git"). A zombie can't
// clobber a successor's ref because every fence gets its own names.
export function branchName(key, n) {
  return `board/${key}-r${n}`;
}

export function snapshotRef(key, n) {
  return `refs/board/${key}/r${n}`;
}

export function salvageRef(key, n) {
  return `refs/board/${key}/r${n}-salvage`;
}
