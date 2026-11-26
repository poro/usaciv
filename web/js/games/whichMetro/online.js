// Which Metro? online play: pure helpers (no DOM, no network), unit-tested in tests/js/whichMetro.online.test.mjs.
// The UI that uses them lives in ./onlineUi.js; the API is docs/MULTIPLAYER.md.
import { dayDiff, isDateKey } from "./sim/puzzle.js";
import { totalScore } from "./sim/game.js";

/** The URL param of a race room: "race-<CODE>". */
export const raceParam = (code) => `race-${code}`;

/**
 * The room code in a "race-<code>" param (upper-cased), or null. Codes are 6 characters from the server's
 * unambiguous alphabet; any 4–10 letters and digits are accepted here and the server has the last word.
 */
export function parseRaceParam(param) {
  const m = /^race-([a-z0-9]{4,10})$/i.exec(String(param ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

/** True when a game of this mode/key can go on the daily leaderboard: today's daily, or yesterday's (archive). */
export function boardEligible(meta, today) {
  if (!meta || !isDateKey(meta.key) || !isDateKey(today)) return false;
  if (meta.mode === "daily") return true;
  if (meta.mode === "archive") return dayDiff(meta.key, today) <= 1;
  return false;
}

const cleanSteps = (r) => ({ steps: r.steps.map((s) => (s.t === "skip" ? { t: "skip" } : { t: s.t, id: s.id })) });

/** POST /api/wm/daily body for a finished daily game. */
export function dailyPayload(game) {
  return { key: game.key, rounds: game.rounds.map(cleanSteps) };
}

/** {t: "finish"} for a finished race game. */
export function finishMsg(game) {
  return { t: "finish", rounds: game.rounds.map(cleanSteps) };
}

/** {t: "progress"}: round is 1-based (the round being played, or the last one once done), clues as shown. */
export function progressMsg(game) {
  const r = game.rounds[game.idx] || game.rounds[game.rounds.length - 1];
  return { t: "progress", round: Math.min(game.idx, game.rounds.length - 1) + 1, clues: r ? r.clues : 0, score: totalScore(game) };
}

/**
 * A leading-and-trailing throttle: push(msg) sends at once when the last send is at least `interval` ms old,
 * otherwise keeps only the newest message and sends it when the interval is up. flush() sends a pending one now;
 * cancel() drops it. Timers are injectable for tests.
 */
export function makeThrottle(send, interval = 1000, { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity, pending = null, timer = null;
  const fire = () => {
    timer = null;
    if (pending == null) return;
    const m = pending;
    pending = null;
    last = now();
    send(m);
  };
  return {
    push(msg) {
      pending = msg;
      const wait = last + interval - now();
      if (wait <= 0) {
        if (timer != null) { clearTimer(timer); timer = null; }
        fire();
      } else if (timer == null) {
        timer = setTimer(fire, wait);
      }
    },
    flush() {
      if (timer != null) { clearTimer(timer); timer = null; }
      fire();
    },
    cancel() {
      if (timer != null) { clearTimer(timer); timer = null; }
      pending = null;
    },
    get pending() { return pending; },
  };
}

/** Reconnect delay for the n-th failed attempt (0-based): 0.5 s doubling to 15 s, plus up to 250 ms of jitter. */
export function backoffMs(n, random = Math.random) {
  return Math.min(15000, 500 * 2 ** Math.max(0, n)) + Math.floor(random() * 250);
}

/** Race players in standings order: placed first (by place), then finished, then by score, round and name. */
export function standings(players) {
  const inf = Number.POSITIVE_INFINITY;
  return (players || []).slice().sort((a, b) =>
    (a.place ?? inf) - (b.place ?? inf) ||
    (b.done ? 1 : 0) - (a.done ? 1 : 0) ||
    (b.score | 0) - (a.score | 0) ||
    (b.round | 0) - (a.round | 0) ||
    String(a.name).localeCompare(String(b.name)));
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n) {
  const v = Math.abs(n) % 100;
  const suf = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] || "th";
  return `${n}${suf}`;
}

/** A nickname as the server will store it: trimmed, inner whitespace collapsed (the server still validates). */
export const cleanName = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

/**
 * The leaderboard rows to show: the top rows with your own marked, plus your row after a gap when you are below
 * them. `you` is the server's {rank, score} or null; `myName` your nickname.
 * → [{rank, name, score, mine}] with {gap: true} between the top and your row.
 */
export function boardRows(top, you, myName) {
  const rows = (top || []).map((r) => ({ rank: r.rank, name: r.name, score: r.score, mine: false }));
  if (!you) return rows;
  let hit = rows.find((r) => r.rank === you.rank && r.score === you.score && r.name === myName) ||
    rows.find((r) => r.rank === you.rank && r.score === you.score);
  if (hit) hit.mine = true;
  else if (!rows.length || you.rank > rows[rows.length - 1].rank) {
    if (rows.length) rows.push({ gap: true });
    rows.push({ rank: you.rank, name: myName || "You", score: you.score, mine: true });
  }
  return rows;
}
