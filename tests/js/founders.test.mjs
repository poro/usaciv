// node --test tests/js   (no npm, no dependencies): the Founders simulation on the real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/founders/sim/index.js";

const D = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const world = D("world"), resources = D("resources"), disasters = D("disasters");
const hazards = S.buildHazards(disasters, world);
const env = S.makeEnv({ world, resources, hazards });
const { T } = env;

test("terrain facts come from the real data", () => {
  assert.equal(T.landCells.length, world.owner.filter((o) => o >= 0).length);
  assert.ok(T.landCells.length > 4000);
  const onMiss = T.landCells.filter((c) => T.riverName[c] === "Mississippi");
  assert.ok(onMiss.length > 30, "the Mississippi crosses many hexes");
  assert.ok(onMiss.every((c) => T.river[c] === 1));
  assert.ok(T.landCells.some((c) => T.coast[c]) && T.landCells.some((c) => T.lake[c]));
  const mines = T.landCells.filter((c) => T.sites[c]?.some((s) => s.kind === "mine"));
  assert.ok(mines.length > 30);
});

test("the yield formula: shares, rivers, coast, relief, sites", () => {
  // A cropland hex on a rank-1 river: round(crop/25 + pasture/40 + grass/60) + 2 food, +2 trade.
  const c = T.landCells.find((i) => T.river[i] === 1 && T.relief[i] === 0 && !T.coast[i] && !T.lake[i] && T.pct.crop[i] > 50);
  assert.ok(c != null);
  const e = S.explainHex(T, c);
  const want = Math.round(T.pct.crop[c] / 25 + T.pct.pasture[c] / 40 + T.pct.grass[c] / 60) + 2;
  assert.equal(e.food, want);
  assert.ok(e.trade >= 2);
  assert.ok(e.parts.some((p) => /cropland/.test(p.label)) && e.parts.some((p) => /River/.test(p.label)));
  // Peaks: no food, no trade.
  for (const i of T.landCells.filter((x) => T.relief[x] === 3)) {
    const y = S.explainHex(T, i);
    assert.equal(y.food, 0);
    assert.equal(y.trade, 0);
  }
  // A mine site adds 3 materials over the same hex without it.
  const m = T.landCells.find((i) => T.sites[i]?.some((s) => s.kind === "mine") && !T.sites[i].some((s) => s.kind !== "mine"));
  const noSite = { ...T, sites: T.sites.map((v, i) => (i === m ? null : v)) };
  assert.equal(S.explainHex(T, m).materials - S.explainHex(noSite, m).materials, 3);
  // Off the map: nothing.
  assert.deepEqual(S.hexYield(T, world.owner.indexOf(-1)), { food: 0, materials: 0, trade: 0 });
  // Town centres always feed at least 2.
  for (const i of T.landCells.slice(0, 300)) assert.ok(S.hexYield(T, i, null, true).food >= 2);
});

test("starts are fair, seeded and on water", () => {
  const a = S.startOptions(env, "seed-1"), b = S.startOptions(env, "seed-1"), c = S.startOptions(env, "seed-2");
  assert.equal(a.length, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.cell), c.map((x) => x.cell));
  for (const s of a) {
    assert.ok(T.land[s.cell] && T.relief[s.cell] < 2);
    assert.ok(T.coast[s.cell] || T.lake[s.cell] || T.river[s.cell]);
  }
  const scores = a.map((s) => s.score);
  assert.ok(Math.max(...scores) - Math.min(...scores) < Math.max(...scores) * 0.5, "starts within a fair band");
});

test("actions: found, distance rule, settlers, improvements, links", () => {
  let s = S.newGame(env, "unit");
  assert.equal(s.phase, "setup");
  assert.equal(S.apply(env, s, { type: "end" }).ok, false);
  s = S.apply(env, s, { type: "start", cell: s.starts[2].cell }).state;
  assert.equal(s.phase, "play");
  const before = JSON.stringify(s);
  const r = S.apply(env, s, { type: "found", party: s.parties[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(JSON.stringify(s), before, "apply never mutates its input");
  s = r.state;
  const home = s.towns[0];
  assert.equal(home.pop, 2);
  assert.ok(S.owners(env, s)[home.cell] === home.id);
  // Settlers: cost materials and a person; cannot found within 2 hexes.
  s = { ...s, materials: 500 };
  const r2 = S.apply(env, s, { type: "party", town: home.id });
  assert.ok(r2.ok, r2.error);
  s = r2.state;
  assert.equal(s.towns[0].pop, 1);
  const p = s.parties[0];
  assert.match(S.apply(env, s, { type: "found", party: p.id }).error, /Too close/);
  const far = env.map.within(home.cell, 4).find((c) => env.map.dist(c, home.cell) === 4 && T.land[c] && T.relief[c] < 3);
  let moved = S.apply(env, s, { type: "move", party: p.id, to: far });
  assert.ok(moved.ok);
  s = moved.state;
  while (s.parties[0].cell !== far) {
    s = S.apply(env, s, { type: "end" }).state;
    if (s.parties[0].target == null && s.parties[0].cell !== far) s = S.apply(env, s, { type: "move", party: p.id, to: far }).state;
  }
  s = { ...s, materials: 500 };
  const r3 = S.apply(env, s, { type: "found", party: p.id });
  assert.ok(r3.ok, r3.error);
  s = r3.state;
  assert.equal(s.towns.length, 2);
  // Improvement: the first hex that fits any kind.
  const own = S.owners(env, s);
  let done = false;
  for (const c of T.landCells) {
    if (!own[c] || S.townAt(s, c)) continue;
    for (const kind of ["farmstead", "quarry", "dock", "mine"]) {
      if (S.improveBlocker(env, s, c, kind)) continue;
      const r4 = S.apply(env, s, { type: "improve", cell: c, kind });
      assert.ok(r4.ok);
      assert.equal(r4.state.materials, s.materials - S.IMPROVEMENTS[kind].cost);
      assert.ok(S.apply(env, r4.state, { type: "improve", cell: c, kind }).error);
      s = r4.state;
      done = true;
      break;
    }
    if (done) break;
  }
  assert.ok(done);
  // Road between the two towns adds trade to both.
  const [a, b] = s.towns;
  const t0 = S.townOutput(env, s, a).trade;
  const r5 = S.apply(env, s, { type: "link", a: a.id, b: b.id });
  assert.ok(r5.ok, r5.error);
  assert.equal(S.townOutput(env, r5.state, a).trade, t0 + S.RULES.roadTrade);
  assert.match(S.apply(env, r5.state, { type: "link", a: a.id, b: b.id }).error, /Rail opens/);
  // Focus and pins.
  const r6 = S.apply(env, r5.state, { type: "focus", town: a.id, focus: "materials" });
  assert.equal(r6.state.towns[0].focus, "materials");
});

test("hazards come from disasters.json and events are deterministic", () => {
  assert.ok(hazards && hazards.flood.length === world.counties.length);
  assert.ok(hazards.hurricane.some((n) => n > 5));
  assert.ok(Object.keys(hazards.drought).length > 30);
  const run = () => {
    let s = S.newGame(env, "events");
    for (let k = 0; k < 40; k++) s = S.botTurn(env, s);
    return s;
  };
  const x = run(), y = run();
  assert.deepEqual(x, y, "same seed → same game");
  const evs = x.log.filter((l) => l.kind === "event");
  assert.ok(evs.length > 0, "some events happened in 40 turns");
});

test("headless: a bot plays 60 turns, ends with several towns and a history comparison", () => {
  const H = S.makeHistory({ world, counties: D("counties"), cities: D("cities"), nation: D("nation") });
  assert.equal(H.top.length, 50);
  assert.ok(H.popTotal > 3e8);
  for (const seed of ["bot-1", "bot-2"]) {
    let s = S.newGame(env, seed);
    let turns = 0;
    while (s.phase !== "over") {
      s = S.botTurn(env, s);
      turns++;
      assert.ok(turns <= 61, "the game ends");
      assert.ok(s.materials >= 0);
      for (const t of s.towns) assert.ok(t.pop >= 1 && t.food >= 0);
      assert.ok(typeof S.nextHint(env, s) === "string");
    }
    assert.equal(turns, 60);
    assert.equal(s.turn, 60);
    assert.ok(s.towns.length > 1, `more than one town (${s.towns.length})`);
    const cells = s.towns.map((t) => t.cell);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) assert.ok(env.map.dist(cells[i], cells[j]) >= S.RULES.minTownDist);
    const h = S.compareHistory(env, s, H);
    assert.ok(h.popInside > 0 && h.popShare > 0 && h.popShare < 1);
    assert.ok(h.outputShare > 0 && h.landShare > 0);
    assert.ok(h.nearCount >= 0 && h.nearCount <= s.towns.length);
    assert.ok(S.prosperity(env, s).score > 0);
    // The whole game survives a JSON round trip (save and resume).
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  }
});
