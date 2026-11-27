// Mainline daily challenge: one scenario and seed a day for everyone (UTC), a 10-year game (2026–2035), one board.
// The scenario rotates Texas Triangle → Rust to Rail → Northeast Corridor by day; the seed comes from the date.
// The server derives both from the date key, so a client can't pick an easier day. Pure.
import { seedFrom } from "../../shared/rng.js";
import { newGame } from "./state.js";
import { START_YEAR } from "./scenarios.js";

export const ML_DAILY_YEARS = 10;
export const ML_DAILY_SCENARIOS = ["texas", "rust", "northeast"];
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isMlDailyKey = (k) => typeof k === "string" && KEY_RE.test(k) && !Number.isNaN(Date.parse(`${k}T00:00:00Z`));

/** The day's challenge: {key, scenario, seed, years}, or null for a bad key. */
export function mlDaily(key) {
  if (!isMlDailyKey(key)) return null;
  const days = Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000);
  return { key, scenario: ML_DAILY_SCENARIOS[((days % 3) + 3) % 3], seed: 1 + (seedFrom(`mainline-daily:${key}`) % 99999), years: ML_DAILY_YEARS };
}

/** A new daily game (the state carries `daily` and `end`, so its hash differs from a free game on the same seed). */
export function newDailyGame(env, d) {
  return { ...newGame(env, { seed: d.seed }), end: START_YEAR + d.years - 1, daily: d.key };
}
