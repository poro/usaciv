// Game state, scoring, share text and stats. Pure functions over plain JSON (saved as is in ctx.storage), no DOM.
//
// state = {v, mode: "daily" | "archive" | "practice", key, seed, number, answers: [id], idx, done,
//          rounds: [{answer, clues (1..MAX_CLUES shown), steps: [{t: "skip"} | {t: "miss", id} | {t: "hit", id}],
//                    solved, done}]}
// Each wrong guess or "next clue" is a step that shows the next clue. With the last clue showing, a wrong guess
// (or giving up) ends the round with 0 points. Points = MAX_CLUES + 1 − clues shown when solved.
import { MAX_CLUES, ROUNDS, dayDiff } from "./puzzle.js";

export const MAX_SCORE = ROUNDS * MAX_CLUES;

export function newGame({ mode, key = null, seed = null, number = null, answers }) {
  return {
    v: 1, mode, key, seed, number, answers: answers.slice(), idx: 0, done: false,
    rounds: answers.map((answer) => ({ answer, clues: 1, steps: [], solved: false, done: false })),
  };
}

const copy = (s) => ({ ...s, rounds: s.rounds.map((r) => ({ ...r, steps: r.steps.slice() })) });

export const currentRound = (s) => s.rounds[s.idx] || null;

function advance(r) {
  if (r.clues < MAX_CLUES) r.clues++;
  else r.done = true;
}

/** "Next clue" (or "give up" on the last clue). */
export function reveal(state) {
  const s = copy(state);
  const r = currentRound(s);
  if (!r || r.done || s.done) return state;
  r.steps.push({ t: "skip" });
  advance(r);
  return s;
}

/** A guess (a city id). Repeating an earlier wrong guess is ignored. */
export function guess(state, id) {
  const s = copy(state);
  const r = currentRound(s);
  if (!r || r.done || s.done || !id) return state;
  if (r.steps.some((st) => st.t === "miss" && st.id === id)) return state;
  if (id === r.answer) {
    r.steps.push({ t: "hit", id });
    r.solved = true;
    r.done = true;
  } else {
    r.steps.push({ t: "miss", id });
    advance(r);
  }
  return s;
}

/** Move on after a finished round; the game is done after the last one. */
export function nextRound(state) {
  const r = currentRound(state);
  if (!r || !r.done || state.done) return state;
  const s = copy(state);
  if (s.idx >= s.rounds.length - 1) s.done = true;
  else s.idx++;
  return s;
}

export const roundPoints = (r) => (r.solved ? MAX_CLUES + 1 - r.clues : 0);
/** Points a correct guess would earn right now. */
export const pointsAtStake = (r) => (r.done ? 0 : MAX_CLUES + 1 - r.clues);
export const totalScore = (s) => s.rounds.reduce((a, r) => a + roundPoints(r), 0);

/** One row of squares per round: 🟨 next clue, 🟥 wrong guess, 🟩 solved, ⬛ unused. */
export function roundSquares(r) {
  const sq = r.steps.map((st) => (st.t === "hit" ? "🟩" : st.t === "miss" ? "🟥" : "🟨"));
  while (sq.length < MAX_CLUES) sq.push("⬛");
  return sq.join("");
}

/** Spoiler-free share text (no city names). */
export function shareText(state, url = "") {
  const head = state.mode === "practice"
    ? `Which Metro? practice ${state.seed}`
    : `Which Metro? #${state.number}${state.mode === "archive" ? ` (${state.key})` : ""}`;
  const rows = state.rounds.map((r) => `${roundSquares(r)} ${roundPoints(r)}`);
  return [`${head} · ${totalScore(state)}/${MAX_SCORE}`, ...rows, url].filter(Boolean).join("\n");
}

// --- stats ---------------------------------------------------------------------------------------------------

export function emptyStats() {
  return { v: 1, played: 0, streak: 0, maxStreak: 0, best: 0, total: 0, perfect: 0, last: null, dist: new Array(MAX_SCORE + 1).fill(0) };
}

/** Stats after finishing the daily puzzle of date `key` with `score`. Idempotent per day. */
export function updateStats(stats, key, score, perfectRounds = 0) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.dist = Array.from({ length: MAX_SCORE + 1 }, (_, k) => (stats?.dist?.[k] | 0));
  if (s.last && dayDiff(s.last, key) <= 0) return s; // already counted (or an older day)
  s.played++;
  s.streak = s.last && dayDiff(s.last, key) === 1 ? s.streak + 1 : 1;
  s.maxStreak = Math.max(s.maxStreak, s.streak);
  s.best = Math.max(s.best, score);
  s.total += score;
  s.perfect += perfectRounds;
  s.dist[Math.max(0, Math.min(MAX_SCORE, score))]++;
  s.last = key;
  return s;
}

/** The streak as of `today`: it lapses once a whole day is skipped. */
export function liveStreak(stats, today) {
  if (!stats?.last) return 0;
  return dayDiff(stats.last, today) <= 1 ? stats.streak : 0;
}

/** Score distribution in buckets of 5 points: [{label: "0–4", count}, …, {label: "25", count}]. */
export function distBuckets(stats) {
  const d = stats?.dist || [];
  const out = [];
  for (let lo = 0; lo < MAX_SCORE; lo += 5) {
    let c = 0;
    for (let k = lo; k < lo + 5; k++) c += d[k] | 0;
    out.push({ label: `${lo}–${lo + 4}`, lo, hi: lo + 4, count: c });
  }
  out.push({ label: String(MAX_SCORE), lo: MAX_SCORE, hi: MAX_SCORE, count: d[MAX_SCORE] | 0 });
  return out;
}

/** True when a saved state looks usable for these answers (guards against a stale or edited save). */
export function validSave(saved, answers) {
  return !!saved && saved.v === 1 && Array.isArray(saved.rounds) && saved.rounds.length === answers.length &&
    saved.rounds.every((r, k) => r && r.answer === answers[k] && Array.isArray(r.steps) && r.clues >= 1 && r.clues <= MAX_CLUES) &&
    saved.idx >= 0 && saved.idx < answers.length;
}
