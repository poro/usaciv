// Founders daily challenge: everyone gets the same empty country on the same UTC day (seed "daily-YYYY-MM-DD", the
// same five starts) and 30 turns (1790–1906). The browser keeps the list of actions it applied; the server replays
// them with these same functions and scores the result, so a score can't be typed in (docs/MULTIPLAYER.md).
// Pure, no DOM: the Worker imports it.
import { newGame, RULES } from "./state.js";
import { apply } from "./actions.js";
import { prosperity } from "./score.js";

export const DAILY_TURNS = 30;
export const DAILY_MAX_ACTIONS = 6000;
export const dailySeed = (key) => `daily-${key}`;
export const isDailySeed = (seed) => /^daily-\d{4}-\d{2}-\d{2}$/.test(String(seed || ""));
export const dailyKeyOf = (seed) => (isDailySeed(seed) ? String(seed).slice(6) : null);

/** A new daily game for date key `key` (YYYY-MM-DD). */
export function newDaily(env, key) {
  return { ...newGame(env, dailySeed(key)), maxTurns: Math.min(RULES.maxTurns, DAILY_TURNS) };
}

// Fields an action may carry, and their types. Anything else is dropped before replay.
const FIELDS = { type: "s", cell: "i", party: "i", to: "i", town: "i|all", kind: "s", a: "i", b: "i", focus: "s", project: "s", on: "b" };
const TYPES = new Set(["start", "move", "found", "party", "improve", "link", "focus", "pin", "project", "grow", "festival", "auto", "end"]);

/** A clean copy of an action log, or {error}. */
export function cleanDailyLog(log) {
  if (!Array.isArray(log) || !log.length) return { error: "log must be a non-empty array" };
  if (log.length > DAILY_MAX_ACTIONS) return { error: `at most ${DAILY_MAX_ACTIONS} actions` };
  const out = [];
  for (const a of log) {
    if (!a || typeof a !== "object" || !TYPES.has(a.type)) return { error: "unknown action" };
    const c = {};
    for (const [k, t] of Object.entries(FIELDS)) {
      if (!(k in a)) continue;
      const v = a[k];
      const ok = t === "s" ? typeof v === "string" && v.length <= 20
        : t === "b" ? typeof v === "boolean"
        : t === "i|all" ? v === "all" || (Number.isInteger(v) && v >= 0 && v < 1e7)
        : Number.isInteger(v) && v >= 0 && v < 1e7;
      if (!ok) return { error: `bad field ${k}` };
      c[k] = v;
    }
    out.push(c);
  }
  return { log: out };
}

/** Replay a daily log. → {state, error, at}; stops at the first refused action. */
export function replayDaily(env, key, log) {
  let s = newDaily(env, key);
  for (let i = 0; i < log.length; i++) {
    const r = apply(env, s, log[i]);
    if (!r.ok) return { state: s, error: r.error || "refused", at: i };
    s = r.state;
  }
  return { state: s, error: null, at: log.length };
}

/** Replay and score a finished daily. → {ok, score, towns, turn} or {ok: false, error}. */
export function verifyDaily(env, key, log) {
  const c = cleanDailyLog(log);
  if (c.error) return { ok: false, error: c.error };
  const r = replayDaily(env, key, c.log);
  if (r.error) return { ok: false, error: `move ${r.at + 1} did not replay: ${r.error}` };
  if (r.state.phase !== "over") return { ok: false, error: "the game is not finished" };
  return { ok: true, score: prosperity(env, r.state).score, towns: r.state.towns.length, turn: r.state.turn, log: c.log };
}
