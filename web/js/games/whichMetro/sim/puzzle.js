// Puzzle generation: which metros a day (or a practice seed) asks for. Pure and deterministic, no DOM.
//
// Daily: the pool (the POOL_SIZE most populous metros) is dealt from a fixed shuffle, ROUNDS per day, so a whole
// cycle (30 days with 150 metros) never repeats an answer; the next cycle is a new shuffle. Each day's rounds are
// ordered biggest metro first, a gentle warm-up. Practice: a seeded shuffle of the same pool.
import { makeRng } from "../../shared/rng.js";

export const ROUNDS = 5;
export const MAX_CLUES = 5;
export const POOL_SIZE = 150;
/** Puzzle #1. */
export const LAUNCH_DATE = "2026-11-26";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isDateKey(s) {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const dayNumber = (key) => {
  const m = DATE_RE.exec(key);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
};

/** Whole days from date key a to date key b (b − a). */
export const dayDiff = (a, b) => dayNumber(b) - dayNumber(a);

/** The puzzle number of a date (LAUNCH_DATE = 1). */
export const puzzleNumber = (key) => dayDiff(LAUNCH_DATE, key) + 1;

/** The answer pool: the `size` most populous metros (cities.json is sorted by population, but sort anyway). */
export function buildPool(cities, size = POOL_SIZE) {
  return cities
    .filter((c) => c.metro && c.cell != null)
    .sort((a, b) => b.population - a.population || (a.id < b.id ? -1 : 1))
    .slice(0, size);
}

const byPop = (pool) => (ids) => {
  const pop = new Map(pool.map((c) => [c.id, c.population]));
  return ids.slice().sort((a, b) => pop.get(b) - pop.get(a));
};

/** The answers (city ids, biggest first) for a daily date key. */
export function dailyAnswers(pool, key, rounds = ROUNDS) {
  const ids = pool.map((c) => c.id);
  const perCycle = Math.max(1, Math.floor(ids.length / rounds));
  const d = puzzleNumber(key) - 1;
  const cycle = Math.floor(d / perCycle);
  const slot = d - cycle * perCycle; // 0..perCycle-1, also for days before launch
  const deck = makeRng(`whichMetro:cycle:${cycle}`).shuffle(ids);
  return byPop(pool)(deck.slice(slot * rounds, slot * rounds + rounds));
}

/** The answers for a practice seed. */
export function practiceAnswers(pool, seed, rounds = ROUNDS) {
  const deck = makeRng(`whichMetro:practice:${seed}`).shuffle(pool.map((c) => c.id));
  return byPop(pool)(deck.slice(0, rounds));
}

/**
 * Read the URL param: null / "" → today's daily; "YYYY-MM-DD" → that day's daily (an "archive" puzzle when it is
 * not today; a future date or one before LAUNCH_DATE falls back to today); "practice-<seed>" → practice. Anything else → today.
 * → {mode: "daily" | "archive" | "practice", key, seed}
 */
export function parseParam(param, today) {
  const p = String(param ?? "").trim();
  const pm = /^practice-([a-z0-9]{1,24})$/i.exec(p);
  if (pm) return { mode: "practice", key: null, seed: pm[1].toLowerCase() };
  if (isDateKey(p) && dayDiff(p, today) > 0 && puzzleNumber(p) >= 1) return { mode: "archive", key: p, seed: null };
  return { mode: "daily", key: today, seed: null };
}

/** A fresh practice seed from any random source returning [0, 1). */
export function newPracticeSeed(random = Math.random) {
  let s = "";
  for (let k = 0; k < 6; k++) s += "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(random() * 32)];
  return s;
}
