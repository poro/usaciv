// Seeded randomness for game simulations. Deterministic across browsers and Node (32-bit integer math only),
// so a seed in the URL reproduces a game, and multiplayer can replay actions later.

/** Hash any string to an unsigned 32-bit seed (FNV-1a). */
export function seedFrom(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Today's date as YYYY-MM-DD in the player's local time zone (the daily-puzzle key). */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * makeRng(seed) → rng: a mulberry32 generator with helpers. `rng.state` can be saved and restored
 * (rng.state = saved) so a game in progress can be serialised.
 */
export function makeRng(seed) {
  let a = (typeof seed === "string" ? seedFrom(seed) : seed) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    /** Integer in [lo, hi] inclusive. */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** true with probability p. */
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Index chosen with probability proportional to weights[i] (>= 0). -1 if all are 0. */
    weighted(weights) {
      let total = 0;
      for (const x of weights) total += x > 0 ? x : 0;
      if (!(total > 0)) return -1;
      let r = next() * total;
      for (let k = 0; k < weights.length; k++) {
        const x = weights[k] > 0 ? weights[k] : 0;
        if (r < x) return k;
        r -= x;
      }
      return weights.length - 1;
    },
    /** Fisher-Yates shuffle of a copy. */
    shuffle(arr) {
      const out = arr.slice();
      for (let k = out.length - 1; k > 0; k--) {
        const j = Math.floor(next() * (k + 1));
        [out[k], out[j]] = [out[j], out[k]];
      }
      return out;
    },
    get state() { return a; },
    set state(v) { a = v >>> 0; },
  };
  return rng;
}
