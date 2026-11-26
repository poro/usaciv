// Which Metro? online helpers (web/js/games/whichMetro/online.js): race params, payloads, throttling, standings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseRaceParam, raceParam, boardEligible, dailyPayload, finishMsg, progressMsg, makeThrottle, backoffMs, standings,
  ordinal, cleanName, boardRows,
} from "../../web/js/games/whichMetro/online.js";
import { buildPool, dailyAnswers, parseParam } from "../../web/js/games/whichMetro/sim/puzzle.js";
import { newGame, reveal, guess, nextRound, totalScore } from "../../web/js/games/whichMetro/sim/game.js";

const cities = JSON.parse(readFileSync(new URL("../../web/data/cities.json", import.meta.url)));
const pool = buildPool(cities);

test("race params round-trip and reject junk", () => {
  assert.equal(parseRaceParam("race-ABC234"), "ABC234");
  assert.equal(parseRaceParam("race-abc234"), "ABC234");
  assert.equal(parseRaceParam(raceParam("XYZ789")), "XYZ789");
  for (const p of [null, undefined, "", "race-", "race-AB", "race-ABC 23", "2026-11-26", "practice-abc", "race-ABCDEFGHIJK", "xrace-ABC234"]) {
    assert.equal(parseRaceParam(p), null, String(p));
  }
  // The pinned daily parser is untouched: a race param is not a daily key, it just falls back to today.
  assert.equal(parseParam("race-ABC234", "2026-11-26").mode, "daily");
});

test("leaderboard eligibility: today's daily and yesterday only", () => {
  const today = "2026-11-28";
  assert.equal(boardEligible({ mode: "daily", key: today }, today), true);
  assert.equal(boardEligible({ mode: "archive", key: "2026-11-27" }, today), true);
  assert.equal(boardEligible({ mode: "archive", key: "2026-11-26" }, today), false);
  assert.equal(boardEligible({ mode: "practice", key: null, seed: "abc" }, today), false);
  assert.equal(boardEligible({ mode: "race", key: null, seed: "abc", code: "ABC234" }, today), false);
  assert.equal(boardEligible(null, today), false);
});

function playDaily(key) {
  const answers = dailyAnswers(pool, key);
  let g = newGame({ mode: "daily", key, number: 1, answers });
  const wrong = pool.find((c) => !answers.includes(c.id)).id;
  g = guess(g, answers[0]); g = nextRound(g);                           // hit on clue 1
  g = guess(g, wrong); g = reveal(g); g = guess(g, answers[1]); g = nextRound(g); // miss, skip, hit
  for (let k = 2; k < 5; k++) { for (let j = 0; j < 5; j++) g = reveal(g); g = nextRound(g); } // give up
  return g;
}

test("daily payload is exactly the steps the server replays", () => {
  const g = playDaily("2026-11-26");
  assert.equal(g.done, true);
  const p = dailyPayload(g);
  assert.deepEqual(Object.keys(p), ["key", "rounds"]);
  assert.equal(p.key, "2026-11-26");
  assert.equal(p.rounds.length, 5);
  assert.deepEqual(p.rounds.map((r) => r.steps), g.rounds.map((r) => r.steps));
  assert.deepEqual(p.rounds[1].steps.map((s) => s.t), ["miss", "skip", "hit"]);
  assert.ok(p.rounds.every((r) => Object.keys(r).length === 1));
  assert.ok(p.rounds[0].steps[0].id && !("id" in p.rounds[2].steps[0]));
  // A copy: mutating the payload leaves the game alone.
  p.rounds[0].steps.push({ t: "skip" });
  assert.equal(g.rounds[0].steps.length, 1);
  const f = finishMsg(g);
  assert.equal(f.t, "finish");
  assert.deepEqual(f.rounds, dailyPayload(g).rounds);
});

test("progress message: 1-based round, clues shown, running score", () => {
  const answers = dailyAnswers(pool, "2026-11-26");
  let g = newGame({ mode: "race", seed: "abc", answers });
  assert.deepEqual(progressMsg(g), { t: "progress", round: 1, clues: 1, score: 0 });
  g = reveal(g);
  assert.deepEqual(progressMsg(g), { t: "progress", round: 1, clues: 2, score: 0 });
  g = guess(g, answers[0]); g = nextRound(g);
  assert.deepEqual(progressMsg(g), { t: "progress", round: 2, clues: 1, score: 4 });
  const done = playDaily("2026-11-26");
  assert.deepEqual(progressMsg(done), { t: "progress", round: 5, clues: 5, score: totalScore(done) });
});

function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    get pending() { return timers.size; },
  };
}

test("progress throttle: at most one message per second, newest wins, flush and cancel", () => {
  const clock = fakeClock();
  const sent = [];
  const th = makeThrottle((m) => sent.push([clock.now(), m]), 1000, clock);
  th.push("a");                       // first goes at once
  assert.deepEqual(sent, [[0, "a"]]);
  clock.advance(200); th.push("b");
  clock.advance(200); th.push("c");   // b is replaced by c
  assert.equal(sent.length, 1);
  clock.advance(600);                 // t = 1000
  assert.deepEqual(sent, [[0, "a"], [1000, "c"]]);
  clock.advance(1500); th.push("d");  // quiet for > 1 s: immediate again
  assert.deepEqual(sent.at(-1), [2500, "d"]);
  th.push("e"); th.flush();           // flush sends now
  assert.deepEqual(sent.at(-1), [2500, "e"]);
  clock.advance(100); th.push("f"); th.cancel();
  clock.advance(5000);
  assert.equal(sent.length, 4);
  assert.equal(clock.pending, 0);
  // Never two sends less than a second apart without flush.
  const s2 = [];
  const c2 = fakeClock();
  const t2 = makeThrottle((m) => s2.push(c2.now()), 1000, c2);
  for (let k = 0; k < 50; k++) { t2.push(k); c2.advance(130); }
  c2.advance(2000);
  for (let k = 1; k < s2.length; k++) assert.ok(s2[k] - s2[k - 1] >= 1000);
  assert.ok(s2.length >= 6 && s2.length <= 8);
});

test("reconnect backoff grows and caps", () => {
  const zero = () => 0;
  assert.equal(backoffMs(0, zero), 500);
  assert.equal(backoffMs(1, zero), 1000);
  assert.equal(backoffMs(3, zero), 4000);
  assert.equal(backoffMs(20, zero), 15000);
  assert.ok(backoffMs(2, () => 0.999) < 2250);
});

test("standings: places, then finished, then score", () => {
  const ps = [
    { id: "a", name: "Ann", score: 10, round: 3, done: false, place: null },
    { id: "b", name: "Bo", score: 18, round: 5, done: true, place: 2 },
    { id: "c", name: "Cy", score: 21, round: 5, done: true, place: 1 },
    { id: "d", name: "Di", score: 12, round: 4, done: false, place: null },
    { id: "e", name: "Ed", score: 5, round: 5, done: true },
  ];
  assert.deepEqual(standings(ps).map((p) => p.id), ["c", "b", "e", "d", "a"]);
  assert.deepEqual(standings(undefined), []);
});

test("ordinals and names", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  assert.equal(cleanName("  Mark   the\tGreat "), "Mark the Great");
  assert.equal(cleanName(null), "");
});

test("board rows mark your own row, or add it after a gap", () => {
  const top = [{ rank: 1, name: "Ann", score: 25 }, { rank: 2, name: "Bo", score: 22 }, { rank: 2, name: "Me", score: 22 }];
  const inTop = boardRows(top, { rank: 2, score: 22 }, "Me");
  assert.deepEqual(inTop.map((r) => r.mine), [false, false, true]);
  const below = boardRows(top, { rank: 40, score: 9 }, "Me");
  assert.equal(below.length, 5);
  assert.equal(below[3].gap, true);
  assert.deepEqual(below[4], { rank: 40, name: "Me", score: 9, mine: true });
  assert.ok(boardRows(top, null, "Me").every((r) => !r.mine));
  assert.deepEqual(boardRows([], { rank: 1, score: 3 }, "Me").map((r) => r.gap ? "gap" : r.name), ["Me"]);
});
