// Metro Ranking: five real metros and one statistic; put them in order, highest first. Pure (no DOM): the browser
// and the Worker build the same rounds from a seed and score the same orders.
//
// Statistics and metros are Metro Duel's (duel/sim/duel.js: Census ACS incl. the job mix, BEA GDP, Census
// population estimates). Within a round every two metros differ by at least MIN_SEP (relative; growth, which
// crosses zero, by MIN_SEP × 5 percentage points), so each order has one right answer a careful player can find.
// A round scores 10 points for each pair of metros in the right order (10 pairs, so 0–100); five rounds a day.
import { makeRng } from "../../shared/rng.js";
import { STATS, duelPool, statById } from "../../duel/sim/duel.js";

export const ROUNDS = 5;
export const SIZE = 5;
export const MIN_SEP = 0.08;
export const PAIR_POINTS = 10;
export const MAX_ROUND = PAIR_POINTS * (SIZE * (SIZE - 1)) / 2; // 100
export const MAX_SCORE = MAX_ROUND * ROUNDS; // 500
export { statById };

export const rankPool = (cities) => duelPool(cities);

function sep(stat, a, b) {
  if (stat.signed) return Math.abs(a - b) / 0.05;
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m > 0 ? Math.abs(a - b) / m : 0;
}

/**
 * ROUNDS rounds from a seed: [{stat: statId, ids: [cityId × SIZE] (shown order), order: [cityId × SIZE] (highest
 * first)}]. Five different statistics; no metro appears twice in a day.
 */
export function rankRounds(pool, seed) {
  const rng = makeRng(seed);
  const pick = (arr) => arr.splice(Math.floor(rng.next() * arr.length), 1)[0];
  const stats = STATS.slice();
  const used = new Set();
  const out = [];
  for (let k = 0; k < ROUNDS; k++) {
    let ids = null, stat = null;
    for (let tries = 0; tries < 6 && !ids; tries++) {
      stat = pick(stats);
      const cands = pool.filter((c) => !used.has(c.id));
      const chosen = [];
      while (cands.length && chosen.length < SIZE) {
        const c = pick(cands);
        const v = stat.value(c);
        if (chosen.every((o) => sep(stat, v, stat.value(o)) >= MIN_SEP)) chosen.push(c);
      }
      if (chosen.length === SIZE) ids = chosen;
    }
    if (!ids) throw new Error("rankRounds: pool too small");
    ids.forEach((c) => used.add(c.id));
    const order = ids.slice().sort((a, b) => stat.value(b) - stat.value(a)).map((c) => c.id);
    out.push({ stat: stat.id, ids: ids.map((c) => c.id), order });
  }
  return out;
}
export const dailySeed = (key) => `rank:${key}`;
export const practiceSeed = (seed) => `rank-practice:${seed}`;

/** Points for one order (an array of the round's ids, highest first): 10 per pair in the right order. */
export function roundPoints(round, order) {
  const pos = new Map(round.order.map((id, i) => [id, i]));
  let n = 0;
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) if (pos.get(order[i]) < pos.get(order[j])) n++;
  return n * PAIR_POINTS;
}

/** True when `order` is a permutation of the round's metros. */
export function validOrder(round, order) {
  return Array.isArray(order) && order.length === SIZE && new Set(order).size === SIZE && order.every((id) => round.ids.includes(id));
}

/**
 * Score a list of orders (one per round, in round order; `partial` allows fewer than ROUNDS, for races that stop
 * early). → {score, points: [0–100]} or {error}.
 */
export function scoreRank(rounds, orders, { partial = false } = {}) {
  if (!Array.isArray(orders) || (partial ? orders.length < 1 || orders.length > rounds.length : orders.length !== rounds.length)) {
    return { error: partial ? `orders must be 1–${rounds.length} rankings` : `need ${rounds.length} rankings` };
  }
  const points = [];
  for (let i = 0; i < orders.length; i++) {
    if (!validOrder(rounds[i], orders[i])) return { error: `ranking ${i + 1} must list the round's ${SIZE} metros once each` };
    points.push(roundPoints(rounds[i], orders[i]));
  }
  return { score: points.reduce((a, b) => a + b, 0), points };
}

/** A share square for a round's points. */
export const square = (p) => (p >= MAX_ROUND ? "🟩" : p >= 80 ? "🟨" : p >= 50 ? "🟧" : "🟥");
