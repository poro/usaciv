// Pure helpers of the multiplayer Worker (worker/rules.js, worker/blocklist.js). node --test, no Workers globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkName, normalizeName, cleanRounds, replayRounds, keyInWindow, utcToday, histogram, cleanProgress,
  CODE_ALPHABET, newRoomCode, isRoomCode, placePlayers, cleanMlRun, MAX_STEPS,
} from "../../worker/rules.js";
import { isBlocked, squash } from "../../worker/blocklist.js";
import { buildPool, dailyAnswers, practiceAnswers } from "../../web/js/games/whichMetro/sim/puzzle.js";

const cities = JSON.parse(readFileSync(new URL("../../web/data/cities.json", import.meta.url)));
const pool = buildPool(cities);
const answers = dailyAnswers(pool, "2026-11-27");
const wrong = (a) => pool.find((c) => c.id !== a).id;
const wrong2 = (a) => pool.filter((c) => c.id !== a)[1].id;

test("names: trim, collapse, length, charset, blocklist", () => {
  assert.equal(normalizeName("  Ada   Lovelace "), "Ada Lovelace");
  assert.deepEqual(checkName("  Ada   Lovelace "), { name: "Ada Lovelace" });
  assert.deepEqual(checkName("José_O'Neil-3.0"), { name: "José_O'Neil-3.0" });
  assert.ok(checkName("A").error);
  assert.ok(checkName("x".repeat(21)).error);
  assert.ok(!checkName("x".repeat(20)).error);
  assert.ok(checkName("<script>").error);
  assert.ok(checkName("Ада").error, "non-Latin letters are refused");
  assert.ok(checkName("--").error, "needs a letter or digit");
  assert.ok(checkName(42).error);
  assert.ok(checkName(undefined).error);
  assert.ok(checkName("H1tl3r fan").error);
  assert.ok(checkName("n.a.z.i").error);
  assert.ok(!checkName("Spicy Tycoon").error, "no false positives on ordinary words");
  assert.equal(squash("N4z1!"), "nazi");
  assert.ok(isBlocked("xxKKKxx"));
});

test("cleanRounds bounds-checks everything", () => {
  assert.ok(cleanRounds(null).error);
  assert.ok(cleanRounds([]).error);
  assert.ok(cleanRounds(new Array(6).fill({ steps: [] })).error);
  assert.ok(cleanRounds([{ steps: new Array(MAX_STEPS + 1).fill({ t: "skip" }) }]).error);
  assert.ok(cleanRounds([{ steps: [{ t: "hit", id: "x".repeat(41) }] }]).error);
  assert.ok(cleanRounds([{ steps: [{ t: "hit", id: 5 }] }]).error);
  assert.ok(cleanRounds([{ steps: [{ t: "boom" }] }]).error);
  assert.ok(cleanRounds([{}]).error);
  const c = cleanRounds([{ steps: [{ t: "skip", extra: 1 }, { t: "hit", id: "a", x: 2 }] }]);
  assert.deepEqual(c.rounds, [{ steps: [{ t: "skip" }, { t: "hit", id: "a" }] }]);
});

test("replay scores a valid game exactly like the sim", () => {
  const rounds = [
    { steps: [{ t: "hit", id: answers[0] }] }, // 5
    { steps: [{ t: "skip" }, { t: "hit", id: answers[1] }] }, // 4
    { steps: [{ t: "miss", id: wrong(answers[2]) }, { t: "skip" }, { t: "hit", id: answers[2] }] }, // 3
    { steps: [{ t: "skip" }, { t: "skip" }, { t: "skip" }, { t: "skip" }, { t: "skip" }] }, // gave up: 0
    { steps: [{ t: "skip" }, { t: "skip" }, { t: "skip" }, { t: "skip" }, { t: "hit", id: answers[4] }] }, // 1
  ];
  const r = replayRounds(answers, cleanRounds(rounds).rounds);
  assert.equal(r.error, undefined);
  assert.equal(r.score, 13);
  assert.deepEqual(r.rounds, rounds);
});

test("replay rejects forged or impossible logs", () => {
  const ok = answers.map((a) => ({ steps: [{ t: "hit", id: a }] }));
  assert.equal(replayRounds(answers, ok).score, 25);
  // a "hit" on a wrong city
  const forged = ok.map((r, k) => (k === 0 ? { steps: [{ t: "hit", id: wrong(answers[0]) }] } : r));
  assert.ok(replayRounds(answers, forged).error);
  // a repeated miss (the sim ignores it)
  const rep = ok.map((r, k) => (k === 1 ? { steps: [{ t: "miss", id: wrong(answers[1]) }, { t: "miss", id: wrong(answers[1]) }, { t: "hit", id: answers[1] }] } : r));
  assert.ok(replayRounds(answers, rep).error);
  // a step after the round ended
  const after = ok.map((r, k) => (k === 2 ? { steps: [{ t: "hit", id: answers[2] }, { t: "skip" }] } : r));
  assert.ok(replayRounds(answers, after).error);
  // an unfinished round, or too few rounds, for the daily
  const unfinished = ok.map((r, k) => (k === 3 ? { steps: [{ t: "miss", id: wrong(answers[3]) }] } : r));
  assert.ok(replayRounds(answers, unfinished).error);
  assert.ok(replayRounds(answers, ok.slice(0, 4)).error);
  // a miss naming the answer is a hit, so it does not replay as a miss
  const missAnswer = ok.map((r, k) => (k === 0 ? { steps: [{ t: "miss", id: answers[0] }, { t: "hit", id: answers[0] }] } : r));
  assert.ok(replayRounds(answers, missAnswer).error);
});

test("race replay accepts a partial run, scored as far as it got", () => {
  const ans = practiceAnswers(pool, "abc234");
  const part = [{ steps: [{ t: "hit", id: ans[0] }] }, { steps: [{ t: "miss", id: wrong(ans[1]) }, { t: "miss", id: wrong2(ans[1]) }] }];
  const r = replayRounds(ans, part, { complete: false });
  assert.equal(r.score, 5);
  // only the last submitted round may be unfinished
  const bad = [{ steps: [{ t: "skip" }] }, { steps: [{ t: "hit", id: ans[1] }] }];
  assert.ok(replayRounds(ans, bad, { complete: false }).error);
});

test("daily key window: ±1 day of UTC today, never before puzzle #1", () => {
  assert.equal(utcToday(Date.UTC(2026, 11, 3, 23, 59)), "2026-12-03");
  assert.ok(keyInWindow("2026-12-03", "2026-12-03"));
  assert.ok(keyInWindow("2026-12-02", "2026-12-03"));
  assert.ok(keyInWindow("2026-12-04", "2026-12-03"));
  assert.ok(!keyInWindow("2026-12-05", "2026-12-03"));
  assert.ok(!keyInWindow("2026-12-01", "2026-12-03"));
  assert.ok(!keyInWindow("2026-11-25", "2026-11-26"), "before launch");
  assert.ok(!keyInWindow("2026-02-30", "2026-02-28"));
  assert.ok(!keyInWindow(null, "2026-12-03"));
});

test("histogram has 26 slots", () => {
  const h = histogram([{ score: 0, n: 2 }, { score: 25, n: 1 }, { score: 99, n: 5 }]);
  assert.equal(h.length, 26);
  assert.equal(h[0], 2);
  assert.equal(h[25], 1);
});

test("progress is clamped display data", () => {
  assert.deepEqual(cleanProgress({ round: 2, clues: 3, score: 9 }), { round: 2, clues: 3, score: 9 });
  assert.deepEqual(cleanProgress({ round: 99, clues: -1, score: 1e9 }), { round: 5, clues: 0, score: 25 });
  assert.equal(cleanProgress({ round: "2", clues: 1, score: 1 }), null);
});

test("room codes: unambiguous alphabet, 6 characters", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  for (const c of "0O1I") assert.ok(!CODE_ALPHABET.includes(c));
  let b = 0;
  const code = newRoomCode(() => (b = (b + 37) % 256));
  assert.equal(code.length, 6);
  assert.ok(isRoomCode(code));
  assert.ok(!isRoomCode("ABC10O"));
  assert.ok(!isRoomCode("abcdef"));
  assert.ok(!isRoomCode("ABCDEFG"));
});

test("places: by verified score, then finish time; unfinished placed last when the room closes", () => {
  const ps = [
    { id: "a", score: 10, finishedAt: 300 },
    { id: "b", score: 12, finishedAt: 400 },
    { id: "c", score: 10, finishedAt: 200 },
    { id: "d", score: 20, finishedAt: null },
  ];
  placePlayers(ps);
  assert.deepEqual(ps.map((p) => p.place), [3, 1, 2, null]);
  placePlayers(ps, true);
  assert.deepEqual(ps.map((p) => [p.place, p.score]), [[3, 10], [1, 12], [2, 10], [4, 0]]);
});

test("Mainline submission shape", () => {
  assert.deepEqual(cleanMlRun({ scenario: "texas", seed: 7, home: "12345", log: [] }), { scenario: "texas", seed: 7, home: null, log: [] });
  assert.deepEqual(cleanMlRun({ scenario: "sandbox", seed: 0, home: "38060", log: [{ type: "endTurn" }] }).home, "38060");
  assert.ok(cleanMlRun({ scenario: "sandbox", seed: 0, log: [] }).error);
  assert.ok(cleanMlRun({ scenario: "mars", seed: 0, log: [] }).error);
  assert.ok(cleanMlRun({ scenario: "rust", seed: -1, log: [] }).error);
  assert.ok(cleanMlRun({ scenario: "rust", seed: 1.5, log: [] }).error);
  assert.ok(cleanMlRun({ scenario: "rust", seed: 1, log: "x" }).error);
});
