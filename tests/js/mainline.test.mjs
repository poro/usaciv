// Mainline simulation tests: node --test tests/js/*.test.mjs   (no npm, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { linkCost, cellFactor, RAIL_DISCOUNT } from "../../web/js/games/mainline/sim/costs.js";
import { rollDisasters, HZ_ALL } from "../../web/js/games/mainline/sim/events.js";
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
  const keys = Object.keys(s.links).sort((x, y) => S.hardenOptions(e, s.links[y]).length - S.hardenOptions(e, s.links[x]).length || (x < y ? -1 : 1));
  s = S.apply(e, s, { type: "harden", key: keys[0] }); // no hz: every hazard on its record
  const opts = S.hardenOptions(e, s.links[keys[0]]);
  assert.ok(opts.length && opts.every((o) => o.done), "hardened against every hazard it has a record of");
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

test("hardening is per hazard type and priced by the local FEMA rate", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 3 });
  s = { ...s, cash: 500 };
  s = S.apply(e, s, { type: "build", path: S.plan(e, s, e.home.cell, e.cityById.get("19100").cell).path });
  // a link on the Gulf: hurricanes are its top hazard, and the dearest to harden
  const key = Object.keys(s.links).sort().find((k) => S.hardenOptions(e, s.links[k])[0]?.type === "hurricane");
  assert.ok(key, "a Houston link is hurricane-exposed");
  const opts = S.hardenOptions(e, s.links[key]);
  assert.ok(opts.length >= 2);
  for (let k = 1; k < opts.length; k++) assert.ok(opts[k - 1].lam >= opts[k].lam && opts[k - 1].cost >= opts[k].cost, "rate and price go together");
  s = S.apply(e, s, { type: "harden", key, hz: "hurricane" });
  assert.equal(S.hardenOptions(e, s.links[key]).find((o) => o.type === "hurricane").done, true);
  assert.match(S.check(e, s, { type: "harden", key, hz: "hurricane" }), /Already hardened/);
  // a hurricane-only hardened link holds against a hurricane but not against a flood
  const only = (t) => ({ ...e, hazard: new Map([...e.hazard].map(([k, h]) => [k, { ...h, p: 1, lam: Object.fromEntries(Object.keys(h.lam).map((x) => [x, x === t ? 1 : 0])) }])) });
  const linkOnly = { [key]: s.links[key] };
  let hurt = 0;
  for (let seed = 1; seed <= 20; seed++) hurt += rollDisasters(only("hurricane"), linkOnly, makeRng(seed), 2030).links[key].d;
  assert.equal(hurt, 0, "hurricane hardening holds");
  for (let seed = 1; seed <= 20; seed++) hurt += rollDisasters(only("flood"), linkOnly, makeRng(seed), 2030).links[key].d;
  assert.ok(hurt > 0, "but floods still cut it");
  // undo gives the money back
  const u = S.apply(e, s, { type: "undo" });
  assert.equal(u.links[key].h, 0);
});

test("double track and terminals raise pay; terminals need a station; undo restores them", () => {
  const e = env("texas");
  let s = { ...S.newGame(e, { seed: 3 }), cash: 2000 };
  s = S.apply(e, s, { type: "build", path: S.plan(e, s, e.home.cell, e.cityById.get("19100").cell).path });
  const before = S.evaluate(e, s);
  // double-track every link: routes on it pay DOUBLE_BONUS more, upkeep rises
  let d = s;
  for (const k of Object.keys(d.links)) d = S.apply(e, d, { type: "double", key: k });
  const ev = S.evaluate(e, d);
  assert.ok(Math.abs(ev.revenue - before.revenue * (1 + S.DOUBLE_BONUS)) < 0.2, `double track ${ev.revenue} vs ${before.revenue}`);
  assert.ok(ev.maint > before.maint);
  assert.match(S.check(e, d, { type: "double", key: Object.keys(d.links)[0] }), /Already/);
  // a terminal in Houston (its real port) raises pay on contracts touching Houston
  const site = e.hubs.get("26420");
  assert.equal(site.kind, "port");
  const h = S.apply(e, s, { type: "hub", city: "26420" });
  assert.equal(h.hubs["26420"], 1);
  assert.equal(h.cash, s.cash - site.base);
  assert.ok(S.evaluate(e, h).revenue > before.revenue);
  assert.equal(S.hubCost(e, h, "26420"), site.base * 2, "the next level costs more");
  // a metro off the network cannot have one
  assert.match(S.check(e, s, { type: "hub", city: "41700" }), /Connect San Antonio/);
  // terminals add growth: one turn later Houston is bigger than without
  const g1 = S.apply(e, h, { type: "endTurn" }), g0 = S.apply(e, s, { type: "endTurn" });
  assert.ok(g1.cities["26420"].gdp > g0.cities["26420"].gdp);
  const u = S.apply(e, h, { type: "undo" });
  assert.deepEqual(u.hubs, {});
  assert.equal(u.cash, s.cash);
});

test("repairs may run on credit, so one early storm cannot strand you", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 3 });
  s = S.apply(e, s, { type: "build", path: S.plan(e, s, e.home.cell, e.cityById.get("19100").cell).path });
  const broken = { ...s, cash: 0, links: Object.fromEntries(Object.entries(s.links).map(([k, l]) => [k, { ...l, d: 1 }])) };
  assert.equal(S.check(e, broken, { type: "repairAll" }), null);
  const fixed = S.apply(e, broken, { type: "repairAll" });
  assert.ok(fixed.cash < 0 && Object.values(fixed.links).some((l) => !l.d));
  assert.match(S.check(e, fixed, { type: "hub", city: "26420" }), /Not enough money/, "nothing else on credit");
  const next = S.apply(e, fixed, { type: "endTurn" });
  assert.ok(next.last.interest > 0, "debt pays interest");
});

test("v1 saves migrate: old hardening covered every hazard", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 3 });
  s = S.apply(e, s, { type: "build", path: S.plan(e, s, e.home.cell, e.cityById.get("19100").cell).path });
  const k = Object.keys(s.links)[0];
  const v1 = JSON.parse(JSON.stringify({ ...s, v: 1, hubs: undefined, links: { ...s.links, [k]: { ...s.links[k], h: 1, dt: undefined } } }));
  const m = S.migrate(v1);
  assert.equal(m.v, S.SAVE_VERSION);
  assert.equal(m.links[k].h, HZ_ALL);
  assert.deepEqual(m.hubs, {});
  assert.equal(S.migrate({ v: 99, links: {}, cities: {}, base: {} }), null);
  assert.ok(!S.check(e, m, { type: "endTurn" }) && S.apply(e, m, { type: "endTurn" }).year === m.year + 1);
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

test("balance: the greedy bot beats every goal (Sandbox included) when it upgrades; idling never does", () => {
  const trackOnly = (e, s) => S.greedyTurn(e, s, { upgrades: false });
  for (const sc of S.SCENARIOS) {
    const e = env(sc.id, sc.home ? null : "19100");
    const t0 = performance.now();
    const gs = run(e, 1, S.greedyTurn);
    const ms = performance.now() - t0;
    const g = S.summary(e, gs);
    const n = S.summary(e, run(e, 1, idle));
    const pct = (x) => `${(x * 100).toFixed(2)}%`;
    assert.ok(g.beat, `${sc.id}: bot ${pct(g.uplift)} beats the ${pct(sc.goal)} goal`);
    assert.ok(!n.beat && g.score > n.score, `${sc.id}: idling (${pct(n.uplift)}) does not`);
    assert.ok(ms < 5000, `${sc.id}: a bot game takes ${ms.toFixed(0)} ms`);
    // the upgrades are a real money sink that pays: the bot spends on them, and scores more than on track alone
    assert.ok(gs.totals.upgrades + gs.totals.hardening > 0, `${sc.id}: bot bought upgrades`);
    if (sc.home) {
      const t = S.summary(e, run(e, 1, trackOnly));
      assert.ok(g.uplift > t.uplift, `${sc.id}: upgrades lift GDP (${pct(g.uplift)} vs ${pct(t.uplift)} on track alone)`);
    }
  }
});

test("determinism: a recorded action list replays to the same state hash", () => {
  const e = env("rust");
  const log = [];
  let s = S.newGame(e, { seed: 11 });
  while (!s.over) s = S.greedyTurn(e, s, { log });
  assert.ok(log.some((a) => a.type === "build") && log.some((a) => a.type === "harden" || a.type === "double" || a.type === "hub"));
  // the log travels as JSON (as it would between browsers), then replays from a fresh game
  const wire = JSON.parse(JSON.stringify(log));
  let r = S.newGame(e, { seed: 11 });
  for (const a of wire) {
    assert.equal(S.check(e, r, a), null, `replayed ${a.type} is valid`);
    r = S.apply(e, r, a);
  }
  assert.equal(S.stateHash(r), S.stateHash(s));
  assert.equal(JSON.stringify(r), JSON.stringify(s));
  // a fresh env (as another client builds it) gives the same game too
  const e2 = S.makeEnv(data, "rust");
  let r2 = S.newGame(e2, { seed: 11 });
  for (const a of wire) r2 = S.apply(e2, r2, a);
  assert.equal(S.stateHash(r2), S.stateHash(s));
  const s0 = S.newGame(e, { seed: 11 });
  assert.notEqual(S.stateHash(S.apply(e, s0, wire[0])), S.stateHash(s0), "the hash sees a change");
});

test("determinism: no engine-dependent Math result reaches the sim unrounded", () => {
  // Math.exp / log / pow / hypot / trig may differ in the last digit between browsers. In sim/, each use must be
  // wrapped in fix(…) or Math.round(…) on the same line, so no comparison, roll or sum depends on that digit.
  const dir = new URL("../../web/js/games/mainline/sim/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, k) => {
      if (/^\s*\/\//.test(line)) return;
      if (/Math\.(exp|log|log1p|expm1|pow|hypot|sin|cos|tan|atan2?|cbrt)\b/.test(line)) {
        assert.ok(/\bfix\(|Math\.round\(/.test(line), `${f}:${k + 1} rounds its Math result: ${line.trim()}`);
      }
      assert.ok(!/Math\.random|Date\.now|performance\.now/.test(line), `${f}:${k + 1} uses no clock or Math.random`);
    });
  }
});

test("URL params round trip", () => {
  assert.deepEqual(parseParam(formatParam({ scenario: "texas", seed: 123 })), { scenario: "texas", seed: 123, home: null });
  assert.deepEqual(parseParam("sandbox.77.19100"), { scenario: "sandbox", seed: 77, home: "19100" });
  assert.equal(parseParam("nope.1"), null);
  assert.equal(parseParam(null), null);
});
