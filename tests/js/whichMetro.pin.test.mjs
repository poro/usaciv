// Which Metro? deal pins: daily puzzles are live, so the metros a date picks must never change.
// If one of these fails, a code change altered the deal (or cities.json's top-150 changed): do not "fix" the pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPool, dailyAnswers, practiceAnswers } from "../../web/js/games/whichMetro/sim/puzzle.js";

const cities = JSON.parse(readFileSync(new URL("../../web/data/cities.json", import.meta.url)));
const pool = buildPool(cities);

test("daily deal is pinned (puzzle #1 went live 2026-11-26)", () => {
  const pins = {
    "2026-11-26": ["25540", "40380", "41500", "21660", "19340"], // #1, launch day
    "2026-11-27": ["38060", "19820", "47260", "37100", "44060"],
    "2026-12-25": ["19740", "12420", "29820", "14260", "45940"], // cycle 1
    "2027-01-01": ["16740", "21340", "12260", "22220", "24540"],
    "2027-06-15": ["35380", "10580", "36100", "45940", "25860"],
  };
  for (const [key, ids] of Object.entries(pins)) assert.deepEqual(dailyAnswers(pool, key), ids, key);
});

test("practice deal is pinned", () => {
  assert.deepEqual(practiceAnswers(pool, "123"), ["10900", "39900", "44140", "42340", "25860"]);
});
