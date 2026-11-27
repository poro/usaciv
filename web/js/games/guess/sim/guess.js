// Ballpark: estimate real numbers on a slider. Six questions a day: four metro statistics (Metro Duel's: population,
// income, rent, home value, unemployment, GDP per person, growth, job mix) and two straight-line distances between
// metros. Pure (no DOM): the browser and the Worker build the same questions and score the same guesses.
//
// Points per question (0–100) fall with how far off the guess is, as a ratio (the larger of guess ÷ answer and
// answer ÷ guess) against each question type's tolerance, the ratio at which points reach 0:
// 100 × (1 − (ratio − 1) ÷ (tol − 1)). 5% off scores about 92 at a tolerance of 1.6. Growth (it crosses zero) is
// measured by its difference in percentage points instead.
import { makeRng } from "../../shared/rng.js";
import { STATS, duelPool, statById } from "../../duel/sim/duel.js";

export const ROUNDS = 6;
export const KM_ROUNDS = [2, 5]; // which questions ask for a distance
export const MAX_ROUND = 100;
export const MAX_SCORE = MAX_ROUND * ROUNDS;
export const KM_RANGE = [50, 4500];
export const KM_PAIR = [200, 3800];
// the ratio at which a guess earns nothing (growth: percentage points)
export const TOL = { population: 3, median_income: 1.6, median_rent: 1.7, home_value: 2.2, unemployment: 1.8, gdp_per: 1.8, jobs_manufacturing: 2.5, jobs_health: 1.8, jobs_finance: 2.2, jobs_professional: 2.2, growth: 0.06, km: 1.7 };
export { statById };

export const guessPool = (cities) => duelPool(cities);
export const kmBetween = (a, b) => Math.round(Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)));

/** Slider range for a question: [lo, hi] (log scale except growth). */
export function rangeFor(pool, q) {
  if (q.kind === "km") return KM_RANGE.slice();
  const s = statById(q.stat);
  const vals = pool.map((c) => s.value(c));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (s.signed) return [Math.floor(lo * 100) / 100 - 0.01, Math.ceil(hi * 100) / 100 + 0.01];
  return [lo * 0.8, hi * 1.25];
}

/**
 * ROUNDS questions from a seed: {kind: "stat", stat, city, answer} or {kind: "km", a, b, answer} (city ids; answers are
 * the real values, km rounded). No metro twice, no statistic twice.
 */
export function guessRounds(pool, seed) {
  const rng = makeRng(seed);
  const pick = (arr) => arr.splice(Math.floor(rng.next() * arr.length), 1)[0];
  const stats = STATS.slice();
  const left = pool.slice(0, 150); // the bigger metros: names people know
  const out = [];
  for (let k = 0; k < ROUNDS; k++) {
    if (KM_ROUNDS.includes(k)) {
      const a = pick(left);
      const cands = left.filter((c) => { const d = kmBetween(a, c); return d >= KM_PAIR[0] && d <= KM_PAIR[1]; });
      const b = cands[Math.floor(rng.next() * cands.length)];
      left.splice(left.indexOf(b), 1);
      out.push({ kind: "km", a: a.id, b: b.id, answer: kmBetween(a, b) });
    } else {
      const s = pick(stats), c = pick(left);
      out.push({ kind: "stat", stat: s.id, city: c.id, answer: s.value(c) });
    }
  }
  return out;
}
export const dailySeed = (key) => `guess:${key}`;
export const practiceSeed = (seed) => `guess-practice:${seed}`;

/** Points (0–100) for one guess. */
export function points(q, guess) {
  if (!Number.isFinite(guess)) return 0;
  const id = q.kind === "km" ? "km" : q.stat;
  if (id === "growth") return Math.max(0, Math.round(100 * (1 - Math.abs(guess - q.answer) / TOL.growth)));
  if (guess <= 0 || q.answer <= 0) return 0;
  const ratio = guess > q.answer ? guess / q.answer : q.answer / guess; // ≥ 1; plain division, the same in every engine
  return Math.max(0, Math.round(100 * (1 - (ratio - 1) / (TOL[id] - 1))));
}

/** Score guesses (numbers, in question order; `partial` allows 1–ROUNDS for races). → {score, points} or {error}. */
export function scoreGuesses(pool, rounds, guesses, { partial = false } = {}) {
  if (!Array.isArray(guesses) || (partial ? guesses.length < 1 || guesses.length > rounds.length : guesses.length !== rounds.length)) {
    return { error: partial ? `guesses must be 1–${rounds.length} numbers` : `need ${rounds.length} guesses` };
  }
  const pts = [];
  for (let i = 0; i < guesses.length; i++) {
    const [lo, hi] = rangeFor(pool, rounds[i]);
    if (typeof guesses[i] !== "number" || !Number.isFinite(guesses[i]) || guesses[i] < lo - 1e-9 || guesses[i] > hi + 1e-9) return { error: `guess ${i + 1} is out of range` };
    pts.push(points(rounds[i], guesses[i]));
  }
  return { score: pts.reduce((a, b) => a + b, 0), points: pts };
}

export const square = (p) => (p >= 90 ? "🟩" : p >= 70 ? "🟨" : p >= 40 ? "🟧" : "🟥");
