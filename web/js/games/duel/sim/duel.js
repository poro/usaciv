// Metro Duel: higher or lower on real metro statistics. Pure (no DOM): the browser and the Worker build the same
// sequence of duels from a seed and count the same streak.
//
// A duel shows metro A with its value for one statistic and metro B with that value hidden: does B have more or
// less? Answer right and B becomes the next A (with a new statistic); the first wrong answer ends the run. The two
// values always differ by at least MIN_GAP (relative), and the gap narrows as the streak grows (BANDS), so early
// duels are easy and later ones are close. Data: cities.json (Census ACS, BEA GDP, Census population estimates).
import { makeRng } from "../../shared/rng.js";

export const DAILY_DUELS = 30;
export const MIN_GAP = 0.04;
export const POOL_SIZE = 250; // the largest metros
// relative gap |a − b| ÷ max(a, b) allowed at each step (narrower bands later); the last band repeats
export const BANDS = [[0.25, 0.8], [0.25, 0.8], [0.2, 0.6], [0.2, 0.6], [0.15, 0.45], [0.12, 0.35], [0.1, 0.3], [0.08, 0.25], [0.06, 0.2], [0.04, 0.15]];

const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
export const STATS = [
  { id: "population", label: "population", more: "more people", value: (c) => c.population, fmt: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} million` : Math.round(n).toLocaleString("en-US")), src: "Census ACS" },
  { id: "median_income", label: "median household income", more: "a higher median household income", value: (c) => c.median_income, fmt: money, src: "Census ACS" },
  { id: "median_rent", label: "median rent", more: "a higher median rent", value: (c) => c.median_rent, fmt: (n) => `${money(n)} a month`, src: "Census ACS" },
  { id: "home_value", label: "median home value", more: "a higher median home value", value: (c) => c.home_value, fmt: money, src: "Census ACS" },
  { id: "unemployment", label: "unemployment rate", more: "a higher unemployment rate", value: (c) => c.unemployment, fmt: pct1, src: "Census ACS" },
  { id: "gdp_per", label: "GDP per person", more: "a higher GDP per person", value: (c) => (c.gdp && c.population ? c.gdp / c.population : null), fmt: money, src: "BEA" },
  { id: "growth", label: "population growth 2021–2025", more: "faster population growth since 2021", value: (c) => c.growth, fmt: (x) => `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(1)}%`, src: "Census estimates", signed: true },
];
export const statById = (id) => STATS.find((s) => s.id === id) || null;

/** The metros a duel can use: the POOL_SIZE largest with every statistic present. */
export function duelPool(cities) {
  return cities.filter((c) => c.metro && STATS.every((s) => Number.isFinite(s.value(c))))
    .sort((a, b) => b.population - a.population || (a.id < b.id ? -1 : 1)).slice(0, POOL_SIZE);
}

// Relative gap; growth (which crosses zero) uses its spread instead: |a − b| ÷ 0.05, capped at 1.
function gap(stat, a, b) {
  if (stat.signed) return Math.min(1, Math.abs(a - b) / 0.05);
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m > 0 ? Math.abs(a - b) / m : 0;
}

/**
 * n duels from a seed: [{a: cityId, b: cityId, stat: statId, higher: bool (b's value is higher)}], chained so each
 * duel's b is the next duel's a.
 */
export function duelSequence(pool, seed, n = DAILY_DUELS) {
  const rng = makeRng(seed);
  const byId = new Map(pool.map((c) => [c.id, c]));
  let a = pool[Math.floor(rng.next() * Math.min(60, pool.length))];
  const recent = [a.id];
  let lastStat = null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const statsLeft = STATS.filter((s) => s.id !== lastStat);
    const stat = statsLeft[Math.floor(rng.next() * statsLeft.length)];
    const va = stat.value(a);
    const [lo, hi] = BANDS[Math.min(k, BANDS.length - 1)];
    const ok = (c, min, max) => { const d = gap(stat, va, stat.value(c)); return !recent.includes(c.id) && d >= min && d <= max; };
    let cands = pool.filter((c) => ok(c, Math.max(MIN_GAP, lo), hi));
    if (!cands.length) cands = pool.filter((c) => ok(c, MIN_GAP, Infinity));
    const b = cands[Math.floor(rng.next() * cands.length)];
    out.push({ a: a.id, b: b.id, stat: stat.id, higher: stat.value(b) > va });
    recent.push(b.id);
    if (recent.length > 12) recent.shift();
    lastStat = stat.id;
    a = byId.get(b.id);
  }
  return out;
}
export const dailySeed = (key) => `duel:${key}`;

/** The streak a list of answers (true = "higher") earns: correct answers before the first wrong one. */
export function streakOf(seq, answers) {
  if (!Array.isArray(answers)) return { error: "answers must be an array" };
  if (answers.length > seq.length) return { error: "too many answers" };
  let n = 0;
  for (let i = 0; i < answers.length; i++) {
    if (typeof answers[i] !== "boolean") return { error: `answer ${i + 1} must be true or false` };
    if (answers[i] !== seq[i].higher) return { streak: n, over: true, answered: i + 1 };
    n++;
  }
  return { streak: n, over: n === seq.length, answered: answers.length };
}
