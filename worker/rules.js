// Pure rules for the multiplayer Worker (docs/MULTIPLAYER.md): names, Which Metro? step validation and replay,
// date-key window, race room codes and places, Mainline submission shape. No Workers globals, so
// tests/js/worker.test.mjs runs this under plain `node --test`.
import { isDateKey, dayDiff, puzzleNumber, ROUNDS, MAX_CLUES } from "../web/js/games/whichMetro/sim/puzzle.js";
import { newGame, guess, reveal, nextRound, totalScore, currentRound, MAX_SCORE } from "../web/js/games/whichMetro/sim/game.js";
import { isBlocked } from "./blocklist.js";

// --- names ---------------------------------------------------------------------------------------------------

export const NAME_MIN = 2;
export const NAME_MAX = 20;
// Latin letters (accents allowed), digits, space and _ - . '
const NAME_RE = /^[\p{Script=Latin}0-9 _\-.']+$/u;

/** Trim and collapse inner whitespace (NFC, so "José" is one form). */
export const normalizeName = (s) => String(s ?? "").normalize("NFC").trim().replace(/\s+/g, " ");

/** → {name} when acceptable, else {error}. */
export function checkName(raw) {
  if (typeof raw !== "string") return { error: "Name is required" };
  const name = normalizeName(raw);
  const len = [...name].length;
  if (len < NAME_MIN || len > NAME_MAX) return { error: `Name must be ${NAME_MIN}–${NAME_MAX} characters` };
  if (!NAME_RE.test(name)) return { error: "Name may use letters, digits, spaces and _ - . ' only" };
  if (!/[\p{Script=Latin}0-9]/u.test(name)) return { error: "Name needs a letter or digit" };
  if (isBlocked(name.normalize("NFD").replace(/\p{M}/gu, ""))) return { error: "Please pick another name" };
  return { name };
}

// --- Which Metro? --------------------------------------------------------------------------------------------

export const MAX_STEPS = 10;
export const MAX_ID = 40;

/**
 * Shape check of a submitted `rounds` array (≤ maxRounds rounds, ≤ MAX_STEPS steps each, ids strings ≤ MAX_ID).
 * → {rounds} (a clean copy holding only the known fields) or {error}.
 */
export function cleanRounds(rounds, maxRounds = ROUNDS) {
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > maxRounds) return { error: "rounds must be an array of 1–5 rounds" };
  const out = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (!r || typeof r !== "object" || !Array.isArray(r.steps)) return { error: `round ${i + 1}: steps missing` };
    if (r.steps.length > MAX_STEPS) return { error: `round ${i + 1}: too many steps` };
    const steps = [];
    for (const st of r.steps) {
      if (!st || typeof st !== "object") return { error: `round ${i + 1}: bad step` };
      if (st.t === "skip") steps.push({ t: "skip" });
      else if (st.t === "miss" || st.t === "hit") {
        if (typeof st.id !== "string" || st.id.length < 1 || st.id.length > MAX_ID) return { error: `round ${i + 1}: bad city id` };
        steps.push({ t: st.t, id: st.id });
      } else return { error: `round ${i + 1}: unknown step` };
    }
    out.push({ steps });
  }
  return { rounds: out };
}

/**
 * Replay cleaned rounds against `answers` with the browser's own sim (newGame/reveal/guess/nextRound) and score
 * with totalScore. Every step must be accepted by the sim and recorded exactly as submitted (a "hit" on a wrong id,
 * a repeated miss or a step after the round ended is rejected). `complete` requires every round finished;
 * otherwise only the last submitted round may be unfinished and later rounds score 0.
 * → {score, rounds} or {error}.
 */
export function replayRounds(answers, rounds, { complete = true } = {}) {
  if (complete && rounds.length !== answers.length) return { error: `expected ${answers.length} rounds` };
  if (rounds.length > answers.length) return { error: "too many rounds" };
  let s = newGame({ mode: "practice", answers });
  for (let i = 0; i < rounds.length; i++) {
    if (s.idx !== i || s.done) return { error: `round ${i + 1}: out of order` };
    for (let k = 0; k < rounds[i].steps.length; k++) {
      const st = rounds[i].steps[k];
      const before = s;
      s = st.t === "skip" ? reveal(s) : guess(s, st.id);
      const got = currentRound(s).steps;
      const last = got[got.length - 1];
      if (s === before || got.length !== k + 1 || last.t !== st.t || (st.id !== undefined && last.id !== st.id)) {
        return { error: `round ${i + 1}, step ${k + 1}: does not replay` };
      }
    }
    if (currentRound(s).done) s = nextRound(s);
    else if (complete || i < rounds.length - 1) return { error: `round ${i + 1}: not finished` };
  }
  if (complete && !s.done) return { error: "game not finished" };
  return { score: totalScore(s), rounds: s.rounds.slice(0, rounds.length).map((r) => ({ steps: r.steps })) };
}

/** Today's UTC date key. */
export const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** A daily key is accepted within one day of the server's UTC date, and never before puzzle #1. */
export const keyInWindow = (key, today) =>
  isDateKey(key) && Math.abs(dayDiff(today, key)) <= 1 && puzzleNumber(key) >= 1;

/** A 26-slot score histogram (0..MAX_SCORE) from [{score, n}] rows. */
export function histogram(rows) {
  const h = new Array(MAX_SCORE + 1).fill(0);
  for (const r of rows) if (r.score >= 0 && r.score <= MAX_SCORE) h[r.score] += r.n | 0;
  return h;
}

/** Clamp a value to an integer in [lo, hi], or null when it is not a finite number. */
export function intIn(v, lo, hi) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Display-only progress → {round, clues, score} (clamped) or null. */
export function cleanProgress(m) {
  const round = intIn(m?.round, 0, ROUNDS), clues = intIn(m?.clues, 0, MAX_CLUES), score = intIn(m?.score, 0, MAX_SCORE);
  return round == null || clues == null || score == null ? null : { round, clues, score };
}

// --- race rooms ----------------------------------------------------------------------------------------------

/** Room-code alphabet: no 0/O or 1/I. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 6;
export const MAX_PLAYERS = 8;
export const RACE_MINUTES = 30;
export const FORGET_HOURS = 2;

/** A room code from `randomByte()` → integer in [0, 256). 256 is a multiple of 32, so there is no bias. */
export function newRoomCode(randomByte) {
  let s = "";
  for (let k = 0; k < CODE_LEN; k++) s += CODE_ALPHABET[randomByte() % CODE_ALPHABET.length];
  return s;
}

export const isRoomCode = (s) => typeof s === "string" && s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

/**
 * Places by verified score, then finish time. Unfinished players have no place while the room is live; once it
 * is "done" they share the place after the last finisher, with score 0. Mutates and returns `players`.
 */
export function placePlayers(players, roomDone = false) {
  const fin = players.filter((p) => p.finishedAt != null).sort((a, b) => b.score - a.score || a.finishedAt - b.finishedAt);
  fin.forEach((p, k) => { p.place = k + 1; p.done = true; });
  for (const p of players) {
    if (p.finishedAt != null) continue;
    if (roomDone) { p.done = true; p.score = 0; p.place = fin.length + 1; }
    else p.place = null;
  }
  return players;
}

// --- Mainline ------------------------------------------------------------------------------------------------

export const ML_SCENARIOS = ["texas", "rust", "northeast", "sandbox"];
export const ML_MAX_LOG = 20000;

/** Shape check of a Mainline run submission → {scenario, seed, home, log} or {error}. */
export function cleanMlRun(b) {
  if (!b || typeof b !== "object") return { error: "body must be an object" };
  const { scenario, seed, log } = b;
  if (!ML_SCENARIOS.includes(scenario)) return { error: "unknown scenario" };
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) return { error: "seed must be a non-negative integer" };
  let home = null;
  if (scenario === "sandbox") {
    if (typeof b.home !== "string" || !/^\d{5}$/.test(b.home)) return { error: "sandbox runs need a 5-digit home" };
    home = b.home;
  }
  if (!Array.isArray(log) || log.length > ML_MAX_LOG) return { error: "log must be an array" };
  return { scenario, seed, home, log };
}
