// Mainline simulation tests: node --test tests/js/*.test.mjs   (no npm, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { linkCost, cellFactor, RAIL_DISCOUNT } from "../../web/js/games/mainline/sim/costs.js";
import { rollDisasters } from "../../web/js/games/mainline/sim/events.js";
import { makeRng } from "../../web/js/games/shared/rng.js";
import { parseParam, formatParam } from "../../web/js/games/mainline/params.js";

const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const data = { world: R("world"), cities: R("cities"), trade: R("trade"), infrastructure: R("infrastructure"), disasters: R("disasters") };
const envs = new Map();
const env = (id, home) => {
  const k = `${id}:${home || ""}`;
  if (!envs.has(k)) envs.set(k, S.makeEnv(data, id, { home }));
  return envs.get(k);
};
const run = (e, seed, turn) => {
  let s = S.newGame(e, { seed });
  while (!s.over) s = turn(e, s);
  return s;
};
const idle = (e, s) => S.apply(e, s, { type: "endTurn" });

test("every scenario builds a region, cities and both kinds of contracts", () => {
  for (const sc of S.SCENARIOS) {
    const e = env(sc.id, sc.home ? null : "19100");
    assert.ok(e.home, `${sc.id} home`);
    assert.ok(e.cities.length >= 10, `${sc.id} cities`);
    assert.ok(e.contracts.some((c) => c.kind === "faf"), `${sc.id} has FAF contracts`);
    assert.ok(e.contracts.some((c) => c.kind === "model"), `${sc.id} has model contracts`);
    for (const c of e.contracts) {
      assert.ok(c.a.cells.length && c.b.cells.length, `${c.id} ends`);
      assert.ok(!c.a.cells.some((x) => c.b.cells.includes(x)), `${c.id} ends are disjoint`);
      assert.ok(c.value > 0);
    }
    for (const id of sc.bounds?.cities || []) assert.ok(e.cityById.get(id), `${sc.id}: city ${id} exists`);
  }
  assert.equal(env("sandbox", "19100").contracts.filter((c) => c.kind === "faf").length, 40);
  assert.equal(env("sandbox", "19100").home.name, "Dallas");
  // Houston–Dallas is the Texas Triangle's biggest model flow
  const tx = env("texas");
  assert.ok(tx.contracts.find((c) => c.kind === "model" && [c.a.name, c.b.name].sort().join() === "Dallas,Houston"));
});

test("costs follow terrain, water and real rail", () => {
  const e = env("sandbox", "19100");
  const w = data.world;
  let ocean = -1, foreign = -1;
  for (let i = 0; i < w.owner.length; i++) {
    if (ocean < 0 && w.owner[i] === -1 && w.water[i] === 1) ocean = i;
    if (foreign < 0 && w.owner[i] === -2) foreign = i;
  }
  assert.equal(cellFactor(w, ocean), Infinity);
  assert.equal(cellFactor(w, foreign), Infinity);
  // every link touching a foreign or ocean hex is forbidden
  for (const bad of [ocean, foreign]) for (const n of e.hexmap.neighbours(bad)) assert.equal(e.edgeCost(bad, n), Infinity);
  // a real rail link is discounted against the same hexes without rail
  const [a, b] = data.infrastructure.rail.find(([p, q]) => w.owner[p] >= 0 && w.owner[q] >= 0 && !e.rivers.has(e.hexmap.edgeKey(p, q)));
  const raw = linkCost({ ...e, rail: new Map() }, a, b);
  assert.ok(e.edgeCost(a, b) <= raw * Math.max(...RAIL_DISCOUNT) + 0.1, "rail discount");
  // mountains cost more than plains
  const flat = [], steep = [];
  for (let i = 0; i < w.owner.length && (flat.length < 50 || steep.length < 50); i++) {
    if (w.owner[i] < 0) continue;
    for (const n of e.hexmap.neighbours(i)) {
      if (w.owner[n] < 0 || e.rail.has(e.hexmap.edgeKey(i, n)) || e.rivers.has(e.hexmap.edgeKey(i, n))) continue;
      if (w.relief[i] === 0 && w.relief[n] === 0) flat.push(e.edgeCost(i, n));
      if (w.relief[i] >= 2 && w.relief[n] >= 2) steep.push(e.edgeCost(i, n));
    }
  }
  assert.ok(Math.min(...steep) > Math.max(...flat) * 0.9, "mountains are dearer");
  assert.ok(e.rivers.size > 100, "river crossings detected");
});

test("Texas region keeps you out of other states", () => {
  const e = env("texas");
  const w = data.world;
  const az = w.states.findIndex((s) => s.abbr === "AZ");
  for (let i = 0; i < w.owner.length; i++) if (w.owner[i] === az) assert.equal(e.inRegion(i), false);
  assert.ok(e.inRegion(e.home.cell));
});

test("build, undo and the rules on money and connection", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 7 });
  const dallas = e.cityById.get("19100");
  const p = S.plan(e, s, e.home.cell, dallas.cell);
  assert.ok(p.path && p.cost > 0 && p.cost < s.cash, `Houston–Dallas route costs ${p.cost}`);
  assert.equal(p.error, null);
  const s1 = S.apply(e, s, { type: "build", path: p.path });
  assert.equal(Object.keys(s1.links).length, p.path.length - 1);
  assert.equal(s1.cash, Math.round((s.cash - p.cost) * 10) / 10);
  assert.ok(S.evaluate(e, s1).served.size >= 1, "Houston–Dallas is served");
  // rebuilding the same route is free and refused
  assert.match(S.check(e, s1, { type: "build", path: p.path }), /Already built/);
  // undo restores links and cash exactly
  const s2 = S.apply(e, s1, { type: "undo" });
  assert.deepEqual(s2.links, s.links);
  assert.equal(s2.cash, s.cash);
  assert.equal(S.check(e, s2, { type: "undo" }), "Nothing to undo this turn");
  // track that touches neither the network nor the home metro is refused
  const sa = e.cityById.get("41700"), au = e.cityById.get("12420");
  const far = S.plan(e, s, sa.cell, au.cell);
  assert.match(far.error, /Connect to your network/);
  assert.equal(S.apply(e, s, { type: "build", path: far.path }), s);
  // you cannot spend money you do not have
  const poor = { ...s, cash: 1 };
  assert.match(S.check(e, poor, { type: "build", path: p.path }), /Not enough money/);
  // undo does not survive the end of a turn
  assert.equal(S.apply(e, s1, { type: "endTurn" }).undo.length, 0);
});

test("the sim is deterministic and survives a save round trip", () => {
  const e = env("texas");
  const a = run(e, 42, S.greedyTurn);
  const b = run(e, 42, S.greedyTurn);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // save mid-game as JSON, reload, continue: same result
  let s = S.newGame(e, { seed: 42 });
  for (let k = 0; k < 10; k++) s = S.greedyTurn(e, s);
  let r = JSON.parse(JSON.stringify(s));
  while (!s.over) s = S.greedyTurn(e, s);
  while (!r.over) r = S.greedyTurn(e, r);
  assert.equal(JSON.stringify(s), JSON.stringify(r));
  // a different seed rolls different storms
  const c = run(e, 43, S.greedyTurn);
  assert.notEqual(JSON.stringify(a.hist.map((h) => h.hits)), JSON.stringify(c.hist.map((h) => h.hits)));
});

test("disasters damage unhardened links only; repair and harden work", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 3 });
  const p = S.plan(e, s, e.home.cell, e.cityById.get("19100").cell);
  s = S.apply(e, s, { type: "build", path: p.path });
  const keys = Object.keys(s.links).sort();
  s = S.apply(e, s, { type: "harden", key: keys[0] });
  assert.equal(s.links[keys[0]].h, 1);
  // a storm everywhere: every county hits, every exposed link is damaged
  const stormy = { ...e, hazard: new Map([...e.hazard].map(([k, h]) => [k, { ...h, p: 1 }])) };
  const hit = rollDisasters({ ...stormy }, s.links, makeRng(1), 2030);
  assert.ok(hit.events.length > 0);
  assert.equal(hit.links[keys[0]].d, 0, "hardened link held");
  assert.ok(Object.values(hit.links).some((l) => l.d === 1), "something broke");
  for (const ev of hit.events) {
    assert.ok(ev.name && ev.total >= ev.count && ev.years > 20, "event cards quote the FEMA rate");
  }
  // damaged links carry nothing; repairing restores service
  const broken = { ...s, links: hit.links, cash: 500 };
  const before = S.evaluate(e, s).served.size, during = S.evaluate(e, broken).served.size;
  assert.ok(during < before);
  const fixed = S.apply(e, broken, { type: "repairAll" });
  assert.equal(S.evaluate(e, fixed).served.size, before);
  assert.ok(fixed.cash < broken.cash);
});

test("doing nothing ties baseline America; growth follows the real trend", () => {
  const e = env("texas");
  const s = run(e, 5, idle);
  const sum = S.summary(e, s);
  assert.equal(sum.uplift, 0);
  assert.equal(sum.beat, false);
  assert.equal(s.hist.length, 25);
  assert.equal(s.year, 2051);
  const austin = e.cities[e.cityIdx.get("12420")];
  assert.ok(s.base["12420"].pop > austin.pop0 * 1.3, "Austin keeps growing fast");
});

test("balance: a simple greedy builder beats doing nothing and the Texas goal", () => {
  const e = env("texas");
  for (const seed of [1, 2]) {
    const g = S.summary(e, run(e, seed, S.greedyTurn));
    const n = S.summary(e, run(e, seed, idle));
    assert.ok(g.score > n.score, `greedy ${g.score} > idle ${n.score}`);
    assert.ok(g.beat, `greedy uplift ${(g.uplift * 100).toFixed(2)}% beats the ${(e.scenario.goal * 100).toFixed(1)}% goal`);
  }
});

test("URL params round trip", () => {
  assert.deepEqual(parseParam(formatParam({ scenario: "texas", seed: 123 })), { scenario: "texas", seed: 123, home: null });
  assert.deepEqual(parseParam("sandbox.77.19100"), { scenario: "sandbox", seed: 77, home: "19100" });
  assert.equal(parseParam("nope.1"), null);
  assert.equal(parseParam(null), null);
});
