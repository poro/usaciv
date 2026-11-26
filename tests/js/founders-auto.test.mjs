// node --test tests/js/*.test.mjs: Founders polish (v0.2). Built-up hexes read and yield like the open land around
// them (no giveaway of the hidden cities), and the turn helpers (auto towns, repeat, "needs orders", the End-turn
// check) keep a late-game turn short.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/founders/sim/index.js";

const D = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const world = D("world"), cities = D("cities");
const env = S.makeEnv({ world, resources: D("resources"), hazards: S.buildHazards(D("disasters"), world) });
const { T, map } = env;
const cityList = Array.isArray(cities) ? cities : cities.cities;

// --- open land ------------------------------------------------------------------------------------------------------

test("open land: developed land goes back to the open land around it", () => {
  const dev = world.pct.developed;
  for (const i of T.landCells) {
    let tot = 0, real = 0;
    for (const k of S.OPEN_KEYS) { tot += T.pct[k][i]; real += world.pct[k][i] || 0; }
    assert.ok(tot <= Math.max(100, real), `shares of ${i} add up to ${tot}`); // (the data's own rounding can reach 101)
    assert.notEqual(T.openCover[i], S.COVER.URBAN, "no urban cover left on land");
    if ((dev[i] || 0) < 10 && world.cover[i] !== S.COVER.URBAN) {
      // Lightly built hexes keep their real shares and cover exactly.
      for (const k of S.OPEN_KEYS) assert.equal(T.pct[k][i], world.pct[k][i]);
      assert.equal(T.openCover[i], world.cover[i]);
    }
  }
  assert.equal(T.realPct, world.pct, "the real shares stay available");
  // Deterministic.
  const again = S.openLand(world);
  for (const k of S.OPEN_KEYS) assert.deepEqual(again.pct[k], T.pct[k]);
});

test("open land: real metro hexes yield like their neighbours, not like empty land", () => {
  const covered = new Set(cityList.filter((c) => c.cell != null && T.land[c.cell]).map((c) => c.cell));
  for (const i of T.landCells) if (world.cover[i] === S.COVER.URBAN) covered.add(i);
  const b = S.baseYields(T);
  const y = (c) => b.food[c] + b.materials[c];
  const ring = [];
  for (const c of covered) for (const n of map.within(c, 2)) if (T.land[n] && !covered.has(n)) ring.push(n);
  const mean = (arr) => arr.reduce((a, c) => a + y(c), 0) / arr.length;
  const mc = mean([...covered]), mr = mean(ring);
  assert.ok(Math.abs(mc - mr) < 0.35, `covered hexes average ${mc.toFixed(2)} food + materials, their neighbours ${mr.toFixed(2)}`);
  // The big built-up metros in particular: none of them is a dead hex any more.
  const big = cityList.filter((c) => c.cell != null && c.population > 2e6 && world.pct.developed[c.cell] >= 50);
  assert.ok(big.length >= 5);
  for (const c of big) {
    const e = S.explainHex(T, c.cell);
    assert.ok(e.food + e.materials >= 1, `${c.name} yields something`);
    let tot = 0;
    for (const k of S.OPEN_KEYS) tot += T.pct[k][c.cell];
    assert.ok(tot >= 80, `${c.name}'s open land fills the hex (${tot}%)`);
  }
});

// --- turn helpers ---------------------------------------------------------------------------------------------------

const lateCache = new Map();
function lateGame(seed, turn = 40) {
  const key = `${seed}:${turn}`;
  if (!lateCache.has(key)) {
    let s = S.newGame(env, seed);
    while (s.turn < turn) s = S.botTurn(env, s);
    lateCache.set(key, s);
  }
  return lateCache.get(key);
}
const allAuto = (s) => S.apply(env, s, { type: "auto", town: "all", on: true }).state;

test("auto: the action toggles one town or all of them", () => {
  const s = lateGame("auto-1");
  const t = s.towns[0];
  const on = S.apply(env, s, { type: "auto", town: t.id, on: true });
  assert.ok(on.ok);
  assert.equal(S.townById(on.state, t.id).auto, true);
  assert.ok(!s.towns[0].auto, "apply never mutates its input");
  const off = S.apply(env, on.state, { type: "auto", town: t.id, on: false }).state;
  assert.ok(!S.townById(off, t.id).auto);
  const all = allAuto(s);
  assert.ok(all.towns.every((x) => x.auto));
  assert.equal(S.apply(env, s, { type: "auto", town: 99999, on: true }).ok, false);
});

test("auto: towns spend sensibly when the turn ends, deterministically, and keep the player's marks", () => {
  const s0 = allAuto(lateGame("auto-1"));
  assert.ok(s0.towns.length >= 8, `a late game with many towns (${s0.towns.length})`);
  const a = S.runAuto(env, s0), b = S.runAuto(env, s0);
  assert.deepEqual(a, b, "same state → same orders");
  assert.ok(a.done.length >= 3, `auto gave ${a.done.length} orders`);
  assert.ok(a.state.materials >= S.autoReserve(s0), "keeps the settlers reserve");
  assert.ok(a.state.materials < s0.materials, "spends");
  // At most one build (improvement or project) per town.
  const builds = a.done.filter((d) => !/^(homesteaders|festival|road|rail)/.test(d.text));
  assert.equal(new Set(builds.map((d) => d.town)).size, builds.length);
  // Not the player's orders.
  assert.deepEqual(a.state.lastOrder, s0.lastOrder);
  for (const t of a.state.towns) assert.equal(t.acted, S.townById(s0, t.id).acted);
  // Ending the turn runs it and reports it.
  const e = S.apply(env, s0, { type: "end" }).state;
  assert.deepEqual(e.lastTurn.auto, a.done);
  // No auto towns: nothing happens.
  const none = S.runAuto(env, lateGame("auto-1"));
  assert.equal(none.done.length, 0);
  assert.equal(none.state, lateGame("auto-1"));
});

test("auto: a town the player ordered this turn is left alone", () => {
  let s = allAuto(lateGame("auto-1"));
  const t = s.towns.find((x) => !S.festivalBlocker({ ...s, materials: 1e4 }, x));
  s = S.apply(env, { ...s, materials: s.materials + 100 }, { type: "festival", town: t.id }).state;
  assert.equal(S.townById(s, t.id).acted, s.turn);
  assert.deepEqual(s.lastOrder, { type: "festival", town: t.id });
  const r = S.runAuto(env, s);
  assert.ok(r.done.every((d) => d.town !== t.id), "no auto orders for a town the player just ordered");
});

test("auto: an auto-only player (founds and sends settlers, then just ends turns) keeps up with the bot", () => {
  const autoTurn = (s0) => {
    let s = s0;
    const act = (a) => { const r = S.apply(env, s, a); if (r.ok) s = r.state; return r.ok; };
    if (s.phase === "setup") act({ type: "start", cell: s.starts[0].cell });
    for (const p of [...s.parties]) {
      const here = S.foundBlocker(env, s, p.cell) ? -Infinity : S.siteScore(env, p.cell);
      const best = S.bestSiteNear(env, s, p.cell, 6);
      if (here > -Infinity && (!best || here >= best.score * 0.92 || !s.towns.length)) { act({ type: "found", party: p.id }); continue; }
      if (best) act({ type: "move", party: p.id, to: best.cell });
    }
    if (s.turn < s.maxTurns - 12 && s.towns.length + s.parties.length < 12) {
      const t = s.towns.filter((x) => x.pop >= 3).sort((x, y) => y.pop - x.pop || x.id - y.id)[0];
      if (t && s.materials >= S.partyCost(s)) act({ type: "party", town: t.id });
    }
    for (const t of s.towns) if (!t.auto) act({ type: "auto", town: t.id, on: true });
    act({ type: "end" });
    return s;
  };
  let a = S.newGame(env, "bal-2"), b = S.newGame(env, "bal-2");
  let hoard = 0, maxHoard = 0;
  while (a.phase !== "over") {
    a = autoTurn(a);
    const income = Math.max(10, S.nationOutput(env, a).income);
    hoard = a.materials > 10 * income ? hoard + 1 : 0;
    maxHoard = Math.max(maxHoard, hoard);
  }
  while (b.phase !== "over") b = S.botTurn(env, b);
  assert.ok(maxHoard <= 2, `auto hoarded for ${maxHoard} turns`);
  const sa = S.prosperity(env, a).score, sb = S.prosperity(env, b).score;
  assert.ok(sa > 0.8 * sb, `auto score ${sa} vs bot ${sb}`);
});

test("late game: with every town on auto a turn is one click; doing the same by hand takes a dozen or more", () => {
  // Clicks by hand per order: an improvement = select town + click hex + build (3); a project, road, homesteaders or
  // festival = select town + button (2). On auto the same orders cost nothing: End turn is the only click.
  for (const seed of ["auto-1", "auto-2"]) {
    let s = lateGame(seed, 42);
    assert.ok(s.towns.length >= 8);
    s = allAuto(s);
    let byHand = 0;
    const turns = 5;
    for (let k = 0; k < turns; k++) {
      assert.equal(S.endTurnCheck(env, s), null, "End turn does not stop an all-auto country with no idle party");
      const r = S.runAuto(env, s);
      byHand += 1 + r.done.reduce((a, d) => a + (/ near /.test(d.text) ? 3 : 2), 0);
      s = S.apply(env, s, { type: "end" }).state;
    }
    assert.ok(byHand / turns >= 8, `${seed}: ${(byHand / turns).toFixed(1)} clicks a turn by hand`);
  }
});

test("repeat last order: homesteaders, festivals and improvements carry over to another town", () => {
  let s = { ...lateGame("auto-1"), materials: 5000 };
  const [t1, t2] = s.towns.filter((t) => !S.growBlocker(env, s, t)).slice(0, 2);
  assert.ok(t1 && t2, "two towns that can take homesteaders");
  s = S.apply(env, s, { type: "grow", town: t1.id }).state;
  assert.deepEqual(s.lastOrder, { type: "grow", town: t1.id });
  assert.deepEqual(S.repeatAction(env, s, t2.id), { type: "grow", town: t2.id });
  assert.equal(S.repeatAction(env, s, t1.id), null, "homesteaders only once a turn per town");
  assert.equal(S.orderLabel(s.lastOrder), "Homesteaders");
  // Improvements: the same kind on the other town's best hex.
  const idea = S.improvementIdeas(env, s)[0];
  s = S.apply(env, s, { type: "improve", cell: idea.cell, kind: idea.kind }).state;
  assert.deepEqual(s.lastOrder, { type: "improve", kind: idea.kind, town: idea.town });
  const other = s.towns.find((t) => t.id !== idea.town && S.repeatAction(env, s, t.id));
  if (other) {
    const a = S.repeatAction(env, s, other.id);
    assert.equal(a.type, "improve");
    assert.equal(a.kind, idea.kind);
    assert.equal(S.owners(env, s)[a.cell], other.id);
    assert.ok(S.apply(env, s, a).ok);
  }
  // No last order: nothing to repeat.
  assert.equal(S.repeatAction(env, { ...s, lastOrder: undefined }, t2.id), null);
});

test("needs orders and the End-turn check: only idle parties and unused materials stop the turn", () => {
  const base = lateGame("auto-1");
  // A fresh founding party with all its moves and no destination needs orders, and stops End turn once.
  let s = { ...base, materials: 5000 };
  const big = s.towns.find((t) => t.pop >= 2);
  s = S.apply(env, s, { type: "party", town: big.id }).state;
  const p = s.parties.at(-1);
  const need = S.ordersNeeded(env, s);
  assert.deepEqual(need[0], { kind: "party", id: p.id, why: "A founding party is waiting for orders" });
  assert.equal(S.endTurnCheck(env, s).kind, "party");
  // Materials piling up while a manual town could use them: a warning naming the town.
  const rich = { ...base, parties: [], materials: 5000 };
  const w = S.endTurnCheck(env, rich);
  assert.equal(w?.kind, "town");
  assert.ok(S.ordersNeeded(env, rich).some((x) => x.kind === "town" && x.id === w.id));
  // All on auto, or every town already ordered this turn: nothing needs orders.
  assert.equal(S.endTurnCheck(env, allAuto(rich)), null);
  assert.deepEqual(S.ordersNeeded(env, allAuto(rich)), []);
  const ordered = { ...rich, towns: rich.towns.map((t) => ({ ...t, acted: rich.turn })) };
  assert.equal(S.endTurnCheck(env, ordered), null);
  // A modest store (under 3 turns of income) never stops the turn.
  assert.equal(S.endTurnCheck(env, { ...base, parties: [], materials: 10 }), null);
});
