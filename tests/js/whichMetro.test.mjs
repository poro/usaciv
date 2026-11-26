// Which Metro? pure logic: puzzle generation, clues, scoring, stats, search.  node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROUNDS, MAX_CLUES, POOL_SIZE, LAUNCH_DATE, buildPool, dailyAnswers, practiceAnswers, parseParam, puzzleNumber,
  dayDiff, isDateKey, newPracticeSeed,
} from "../../web/js/games/whichMetro/sim/puzzle.js";
import { buildClues, whyLine, roughPeople, roughDollars, sig2, TIER_ORDER, POP_BANDS, popBand } from "../../web/js/games/whichMetro/sim/clues.js";
import { ambiguity, summarize, parseValue, cluesAgree } from "./whichMetro.ambiguity.mjs";
import { guessHint } from "../../web/js/games/whichMetro/sim/hint.js";
import {
  newGame, reveal, guess, nextRound, roundPoints, totalScore, shareText, roundSquares, updateStats, emptyStats,
  liveStreak, distBuckets, validSave, MAX_SCORE, pointsAtStake,
} from "../../web/js/games/whichMetro/sim/game.js";
import { buildIndex, matchCities, normalize } from "../../web/js/games/whichMetro/sim/search.js";
import { regionOf } from "../../web/js/games/whichMetro/sim/regions.js";

const load = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const cities = load("cities");
const citizens = load("citizens");
const districts = load("districts");
const nation = load("nation");
const byId = new Map(cities.map((c) => [c.id, c]));
const pool = buildPool(cities);
const data = { citizens, districts, nation, pool };

test("pool: the most populous metros", () => {
  assert.equal(pool.length, POOL_SIZE);
  assert.ok(pool.every((c) => c.metro));
  for (let k = 1; k < pool.length; k++) assert.ok(pool[k - 1].population >= pool[k].population);
  const smallest = pool.at(-1).population;
  assert.ok(cities.filter((c) => c.metro && c.population > smallest).length === POOL_SIZE - 1);
});

test("dates and puzzle numbers", () => {
  assert.equal(puzzleNumber(LAUNCH_DATE), 1);
  assert.equal(puzzleNumber("2026-11-27"), 2);
  assert.equal(dayDiff("2026-12-31", "2027-01-01"), 1);
  assert.equal(dayDiff("2027-03-10", "2027-03-14"), 4); // across a DST change: whole days
  assert.ok(isDateKey("2028-02-29"));
  assert.ok(!isDateKey("2027-02-29"));
  assert.ok(!isDateKey("2026-1-5"));
});

test("daily puzzles are deterministic, distinct, biggest first, and no repeats inside a cycle", () => {
  const a = dailyAnswers(pool, "2026-12-03"), b = dailyAnswers(pool, "2026-12-03");
  assert.deepEqual(a, b);
  assert.equal(a.length, ROUNDS);
  assert.equal(new Set(a).size, ROUNDS);
  for (let k = 1; k < a.length; k++) assert.ok(byId.get(a[k - 1]).population >= byId.get(a[k]).population);
  const seen = new Set();
  for (let d = 0; d < POOL_SIZE / ROUNDS; d++) {
    const key = new Date(Date.UTC(2026, 10, 26 + d)).toISOString().slice(0, 10);
    for (const id of dailyAnswers(pool, key)) {
      assert.ok(!seen.has(id), `repeat ${id} on ${key}`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, POOL_SIZE);
  assert.notDeepEqual(dailyAnswers(pool, "2026-11-26"), dailyAnswers(pool, "2026-11-27"));
  assert.equal(dailyAnswers(pool, "2025-01-01").length, ROUNDS); // before launch still works
});

test("practice puzzles follow their seed", () => {
  assert.deepEqual(practiceAnswers(pool, "abc"), practiceAnswers(pool, "abc"));
  assert.notDeepEqual(practiceAnswers(pool, "abc"), practiceAnswers(pool, "abd"));
  const seed = newPracticeSeed(() => 0.5);
  assert.match(seed, /^[a-z0-9]{6}$/);
});

test("URL param parsing", () => {
  const today = "2026-11-26";
  assert.deepEqual(parseParam(null, today), { mode: "daily", key: today, seed: null });
  assert.deepEqual(parseParam("2026-11-26", today), { mode: "daily", key: today, seed: null });
  assert.deepEqual(parseParam("2026-11-30", "2026-12-05"), { mode: "archive", key: "2026-11-30", seed: null });
  assert.deepEqual(parseParam("2027-01-01", today), { mode: "daily", key: today, seed: null }); // no peeking ahead
  assert.equal(parseParam("2026-11-27", "2026-11-28").mode, "archive");
  assert.equal(parseParam("2026-11-01", today).mode, "daily"); // before puzzle #1
  assert.deepEqual(parseParam("practice-Ab12", today), { mode: "practice", key: null, seed: "ab12" });
  assert.equal(parseParam("garbage", today).mode, "daily");
});

test("every pool metro gets five non-empty clues that never name it", () => {
  for (const city of pool) {
    const clues = buildClues(city, data);
    assert.equal(clues.length, MAX_CLUES);
    for (const c of clues) {
      const n = (c.facts?.length || 0) + (c.bars?.length || 0) + (c.chips?.length || 0);
      assert.ok(n > 0, `${city.name}: empty clue ${c.id}`);
    }
    // Tiers 1-4 must not contain the city's name (or its principal cities). Tier 5 names states only.
    const text = JSON.stringify(clues.slice(0, 4)).toLowerCase();
    const names = String(city.full).split(",")[0].split("-").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 3);
    for (const nm of names) {
      // a state- or word-like collision (e.g. "Washington" the state) is fine only in tier 5
      assert.ok(!text.includes(`"${nm}"`) && !text.includes(` ${nm} `) && !text.includes(`${nm} city`), `${city.name}: clue mentions ${nm}`);
    }
    assert.ok(JSON.stringify(clues[4]).includes("State"));
  }
});

test("district names come from the catalog, not hardcoded ids", () => {
  const catNames = new Set(districts.catalog.map((d) => d.name));
  let seen = 0;
  for (const city of pool) {
    const econ = buildClues(city, data).find((c) => c.id === "economy");
    for (const chip of econ.chips) { assert.ok(catNames.has(chip.label), chip.label); seen++; }
  }
  assert.ok(seen > 50);
  // A renamed catalog flows straight through.
  const renamed = structuredClone(districts);
  for (const d of renamed.catalog) d.name = `Renamed ${d.id}`;
  const sj = pool.find((c) => districts.cities[c.id]?.districts?.length);
  const chips = buildClues(sj, { ...data, districts: renamed }).find((c) => c.id === "economy").chips;
  assert.ok(chips.every((c) => c.label.startsWith("Renamed ")));
});

test("clues survive missing optional files", () => {
  const city = pool[10];
  const clues = buildClues(city, {});
  assert.equal(clues.length, MAX_CLUES);
  assert.ok(clues[0].bars.length > 0);
  assert.ok(clues.find((c) => c.id === "size").facts.length > 0);
  assert.ok(whyLine(city, {}).text.includes("Population"));
});

test("why line uses real numbers", () => {
  const sj = cities.find((c) => c.id === "41940"); // San Jose: semiconductors
  const w = whyLine(sj, data);
  assert.match(w.text, /\d/);
  assert.ok(w.tier >= 1 && w.tier <= 4);
  for (const c of pool) assert.ok(whyLine(c, data).text.length > 10);
});

test("rounding helpers", () => {
  assert.equal(sig2(2271012), 2300000);
  assert.equal(roughPeople(2271012), "about 2.3 million");
  assert.equal(roughPeople(372047), "about 370,000");
  assert.equal(roughPeople(20112448), "about 20 million");
  assert.equal(roughDollars(188209702000), "$190 billion");
  assert.equal(roughDollars(2.1e12), "$2.1 trillion");
  assert.equal(roughDollars(8.4e9), "$8.4 billion");
});

test("regions", () => {
  assert.deepEqual(regionOf("TX"), { division: "West South Central", region: "South" });
  assert.equal(regionOf("ZZ"), null);
});

test("scoring: clues, wrong guesses, misses, points and share text", () => {
  const answers = ["A", "B", "C", "D", "E"];
  let s = newGame({ mode: "daily", key: "2026-11-26", number: 1, answers });
  assert.equal(pointsAtStake(s.rounds[0]), 5);
  s = guess(s, "A"); // first clue: 5
  assert.equal(roundPoints(s.rounds[0]), 5);
  assert.equal(guess(s, "A"), s, "no guesses after a round ends");
  s = nextRound(s);
  s = reveal(s); s = guess(s, "X"); s = guess(s, "X"); // repeat ignored
  assert.equal(s.rounds[1].clues, 3);
  s = guess(s, "B"); // 3 clues: 3 points
  assert.equal(roundPoints(s.rounds[1]), 3);
  assert.equal(roundSquares(s.rounds[1]), "🟨🟥🟩⬛⬛");
  s = nextRound(s);
  for (let k = 0; k < 4; k++) s = reveal(s);
  assert.equal(s.rounds[2].clues, 5);
  assert.equal(s.rounds[2].done, false);
  s = guess(s, "Y"); // wrong on the last clue: miss
  assert.equal(s.rounds[2].done, true);
  assert.equal(roundPoints(s.rounds[2]), 0);
  assert.equal(roundSquares(s.rounds[2]), "🟨🟨🟨🟨🟥");
  s = nextRound(s);
  for (let k = 0; k < 4; k++) s = reveal(s);
  s = guess(s, "D"); // last clue: 1
  s = nextRound(s);
  for (let k = 0; k < 5; k++) s = reveal(s); // gave up
  assert.equal(s.rounds[4].done, true);
  assert.equal(nextRound(nextRound(s)).done, true);
  s = nextRound(s);
  assert.equal(s.done, true);
  assert.equal(totalScore(s), 5 + 3 + 0 + 1 + 0);
  const txt = shareText(s, "https://example.test/#play=whichMetro~2026-11-26");
  assert.match(txt, /^Which Metro\? #1 · 9\/25\n/);
  assert.equal(txt.split("\n").length, 1 + 5 + 1);
  for (const a of answers) assert.ok(!txt.includes(` ${a}\n`));
  assert.ok(validSave(s, answers) || s.idx === 4);
  assert.ok(!validSave(s, ["A", "B", "C", "D", "Z"]));
  assert.match(shareText({ ...s, mode: "practice", seed: "abc" }), /practice abc/);
});

test("stats: streaks, best, distribution, once per day", () => {
  let st = emptyStats();
  st = updateStats(st, "2026-11-26", 18, 1);
  st = updateStats(st, "2026-11-26", 25); // replay of the same day does not count
  assert.equal(st.played, 1);
  assert.equal(st.best, 18);
  st = updateStats(st, "2026-11-27", 20);
  assert.equal(st.streak, 2);
  st = updateStats(st, "2026-11-30", 7);
  assert.equal(st.streak, 1);
  assert.equal(st.maxStreak, 2);
  assert.equal(st.played, 3);
  assert.equal(st.total, 45);
  assert.equal(st.dist[20], 1);
  assert.equal(st.dist.length, MAX_SCORE + 1);
  assert.equal(liveStreak(st, "2026-12-01"), 1);
  assert.equal(liveStreak(st, "2026-12-02"), 0);
  const b = distBuckets(st);
  assert.equal(b.length, 6);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 3);
  assert.equal(updateStats(null, "2026-11-26", 3).played, 1);
});

test("search: names, labels, principal cities, duplicates", () => {
  const index = buildIndex(cities);
  assert.equal(normalize("  Winston–Salem!! "), "winston salem");
  const ny = matchCities(index, "new y");
  assert.equal(byId.get(ny[0].id).name, "New York");
  const pt = matchCities(index, "portland");
  assert.ok(pt.length >= 2);
  assert.equal(pt[0].label, "Portland, OR-WA"); // the bigger one first
  assert.equal(matchCities(index, "portland me")[0].label.startsWith("Portland, ME"), true);
  const fw = matchCities(index, "fort worth");
  assert.equal(byId.get(fw[0].id).name, "Dallas");
  assert.deepEqual(matchCities(index, ""), []);
  assert.ok(matchCities(index, "a", 5).length <= 5);
});

test("clue tiers come in TIER_ORDER: size before the economy, place last", () => {
  assert.deepEqual(TIER_ORDER, ["workforce", "people", "size", "economy", "where"]);
  for (const city of pool.slice(0, 20)) assert.deepEqual(buildClues(city, data).map((c) => c.id), TIER_ORDER);
});

test("wrong-guess hints: distance and direction, no names", () => {
  const sea = byId.get("42660"), mia = byId.get("33100"), bos = byId.get("14460"), nyc = byId.get("35620");
  const h = guessHint(sea, mia); // guessed Seattle, answer Miami
  assert.ok(h.km > 3500 && h.km < 6000, String(h.km));
  assert.equal(h.dir, "north-west");
  assert.equal(h.arrow, "↘");
  assert.match(h.text, /^[\d,]+ km too far north-west$/);
  assert.ok(!h.text.includes("Miami"));
  assert.equal(guessHint(mia, sea).dir, "south-east");
  assert.equal(guessHint(bos, nyc).dir.includes("north"), true);
  const tx = pool.filter((c) => c.states[0] === "TX");
  assert.ok(guessHint(tx[0], tx[1]).sameState);
  const hi = cities.find((c) => c.states[0] === "HI");
  if (hi) {
    const off = guessHint(sea, hi);
    assert.equal(off.km, null);
    assert.match(off.text, /lower 48/);
  }
  assert.equal(guessHint(null, sea).text, "");
});

test("ambiguity measure: reads clues as displayed", () => {
  assert.deepEqual(parseValue("28.2%").nums, [{ kind: "pct", v: 0.282 }]);
  assert.deepEqual(parseValue("≥2.4× the US share · 5.8% of jobs").nums.map((n) => n.kind), ["ratio", "pct"]);
  assert.deepEqual(parseValue("$105K").nums, [{ kind: "mag", v: 105000 }]);
  assert.deepEqual(parseValue("2 to 5 million").nums, []); // a band: words only
  const f = (value) => ({ facts: [{ label: "x", value }] });
  assert.ok(cluesAgree(f("20%"), f("21.5%")));
  assert.ok(!cluesAgree(f("28.2%"), f("9.3%")));
  assert.ok(cluesAgree(f("$100K"), f("$120K")));
  assert.ok(!cluesAgree(f("about 20 million"), f("about 13 million")));
  assert.ok(!cluesAgree(f("2 to 5 million"), f("5 million or more")));
  assert.ok(!cluesAgree(f("20%"), { facts: [{ label: "y", value: "20%" }] })); // different rows
});

test("clue 1 never singles out a metro; the 10 biggest need at least 2 clues on average", () => {
  const res = ambiguity(pool, (c) => buildClues(c, data), 2);
  const sum = summarize(res, 2);
  const lone = res.filter((r) => r.counts[0] === 1).map((r) => r.name);
  assert.deepEqual(lone, [], `clue 1 alone identifies: ${lone.join(", ")}`);
  assert.ok(sum.after1.median >= 10, `clue 1 leaves a median of ${sum.after1.median} metros plausible`);
  assert.ok(sum.top10need >= 2, `top 10 need ${sum.top10need} clues on average`);
});

test("clue 2 narrows the field without naming the answer; clue 3 still narrows it well", () => {
  const res = ambiguity(pool, (c) => buildClues(c, data), 3);
  const sum = summarize(res, 3);
  assert.ok(sum.after2.median >= 4, `clues 1-2 leave a median of ${sum.after2.median} metros plausible`);
  const lone = res.slice(0, 10).filter((r) => r.counts[1] === 1).map((r) => r.name);
  assert.deepEqual(lone, [], `clues 1-2 alone identify: ${lone.join(", ")}`);
  // Not too hard either: after three clues most metros are down to one or two candidates.
  assert.ok(sum.after3.median <= 2, `clues 1-3 leave a median of ${sum.after3.median} metros plausible`);
  // The facts that named New York and Chicago on their own are not in clue 2.
  const people = buildClues(byId.get("35620"), data).find((c) => c.id === "people");
  assert.ok(!people.facts.some((f) => /transit/i.test(f.label)), "transit belongs to a later clue");
});

test("no clue before the last shows absolute size: population is a broad band, never a count", () => {
  assert.equal(popBand(20e6), "5 million or more");
  assert.equal(popBand(1.5e6), "1 to 2 million");
  assert.equal(popBand(300000), POP_BANDS.at(-1).label);
  const bands = new Set(POP_BANDS.map((b) => b.label));
  for (const city of pool) {
    const clues = buildClues(city, data);
    const size = clues.find((c) => c.id === "size");
    assert.ok(bands.has(size.facts.find((f) => f.label === "Population").value), city.name);
    const text = JSON.stringify(clues.slice(0, 4));
    assert.ok(!/about [\d.,]+( million)?"|\d(K|M) (jobs|workers)|\$[\d.]+ (billion|trillion)/.test(text), `${city.name}: an absolute count in clues 1-4`);
  }
});
