// Mainline power and fibre networks (sim/utility.js and the "line" action in sim/state.js). node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { verifyRun, REQUIRED_DATA, shapeError } from "../../web/js/games/mainline/sim/verify.js";

const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const data = Object.fromEntries(REQUIRED_DATA.map((n) => [n, R(n)]));
const texas = S.makeEnv(data, "texas");
const centre = (e, id) => e.cities[e.cityIdx.get(id)].cell;

test("power and talent contracts: real sites, capped, deterministic", () => {
  const u = texas.utility;
  assert.equal(u.power.length, 24);
  assert.equal(u.talent.length, 12);
  for (const c of u.power) {
    assert.ok(S.POWER_TYPES.includes(c.type));
    assert.ok(c.mw > 0 && c.base > 0);
    assert.notEqual(c.cell, centre(texas, c.city), "never a plant that already sits at the substation");
  }
  assert.deepEqual(S.makeEnv(data, "texas").utility.power.map((c) => c.id), u.power.map((c) => c.id));
  const sand = S.makeEnv(data, "sandbox", { home: "38060" });
  assert.equal(sand.utility.power.length, 60);
  assert.ok(sand.utility.power.some((c) => c.name === "Palo Verde" && sand.cityById.get(c.city).name === "Phoenix"));
  assert.equal(S.transitionShare("coal_plant", 2026), 0);
  assert.equal(S.transitionShare("coal_plant", 2035), 0.2);
  assert.equal(S.transitionShare("gas_plant", 2049), 0.2);
  assert.equal(S.transitionShare("nuclear", 2049), 0);
});

test("a power line: anchors, cost, pay, upkeep, undo back to the exact old state", () => {
  let s = S.newGame(texas, { seed: 3 });
  const h0 = S.stateHash(s);
  const c = texas.utility.power.find((x) => x.type === "nuclear");
  const p = S.planLine(texas, s, "power", c.cell, centre(texas, c.city));
  assert.ok(p.path && p.cost > 0, p.error);
  // a line must start at a plant, its metro, your own lines or home
  const anchors = S.lineAnchors(texas, s, "power");
  let stray = null;
  for (let x = 0; x < texas.region.length && !stray; x++) {
    if (texas.region[x] !== 1 || anchors.has(x)) continue;
    const y = texas.hexmap.neighbours(x).find((n) => texas.region[n] === 1 && !anchors.has(n));
    if (y != null) stray = [x, y];
  }
  assert.match(S.check(texas, s, { type: "line", net: "power", path: stray }), /Start at a power plant/);
  assert.match(S.check(texas, s, { type: "line", net: "water", path: p.path }), /Unknown network/);
  const before = S.evaluate(texas, s);
  s = S.apply(texas, s, { type: "line", net: "power", path: p.path });
  assert.ok(s.lines, "lines appear with the first one");
  assert.equal(Object.keys(s.lines).length, p.path.length - 1);
  assert.equal(s.cash, Math.round((70 - p.cost) * 10) / 10);
  assert.equal(s.totals.lines, p.cost);
  const ev = S.evaluate(texas, s);
  assert.ok(ev.utility.power.size >= 1, "a line that passes other plants on the way picks them up too");
  assert.equal(ev.utility.power.get(c.id), c.base, "growth 1 in the first year");
  assert.ok(ev.revenue > before.revenue);
  assert.ok(ev.maint > before.maint);
  assert.equal(S.check(texas, s, { type: "line", net: "power", path: p.path }), "Already built");
  // a second, parallel fibre on the same hexes is its own network
  assert.equal(S.check(texas, s, { type: "line", net: "fibre", path: p.path }) === "Already built", false);
  const undone = S.apply(texas, s, { type: "undo" });
  assert.equal(undone.lines, undefined);
  assert.equal(S.stateHash({ ...undone, nv: 0 }), S.stateHash({ ...S.newGame(texas, { seed: 3 }), nv: 0 }));
  assert.notEqual(h0, S.stateHash(s));
  // end the year: the pay lands in cash
  const next = S.apply(texas, s, { type: "endTurn" });
  assert.equal(next.year, 2027);
  assert.ok(next.last.revenue >= c.base);
});

test("coal pays less each decade; fibre adds GDP growth at both ends", () => {
  const coal = texas.utility.power.find((x) => x.type === "coal_plant");
  let s = S.newGame(texas, { seed: 1 });
  s = { ...s, cash: 500 };
  const p = S.planLine(texas, s, "power", coal.cell, centre(texas, coal.city));
  s = S.apply(texas, s, { type: "line", net: "power", path: p.path });
  const pay = (year) => S.serveUtility(texas, { ...s, year }).power.get(coal.id);
  assert.equal(pay(2026), coal.base);
  assert.ok(Math.abs(pay(2035) - coal.base * 0.8) < 1e-6);
  assert.ok(Math.abs(pay(2045) - coal.base * 0.6) < 1e-6);

  const t = texas.utility.talent[0];
  const a = centre(texas, t.a), b = centre(texas, t.b);
  let f = { ...S.newGame(texas, { seed: 1 }), cash: 500 };
  const fp = S.planLine(texas, f, "fibre", a, b);
  f = S.apply(texas, f, { type: "line", net: "fibre", path: fp.path });
  const u = S.serveUtility(texas, f);
  assert.equal(u.talent.has(t.id), true);
  assert.equal(u.extra[texas.cityIdx.get(t.a)], S.TALENT_GROWTH);
  const plain = S.apply(texas, { ...S.newGame(texas, { seed: 1 }), cash: 500 }, { type: "endTurn" });
  const wired = S.apply(texas, f, { type: "endTurn" });
  assert.ok(wired.cities[t.a].gdp > plain.cities[t.a].gdp, "talent link speeds growth");
});

test("runs with lines verify on the server; versus refuses lines; shapes", () => {
  const e = texas;
  let s = S.newGame(e, { seed: 7 });
  const log = [];
  const act = (a) => { assert.equal(S.check(e, s, a), null); s = S.apply(e, s, a); log.push(a); };
  const c = e.utility.power[0];
  act({ type: "line", net: "power", path: S.planLine(e, s, "power", c.cell, centre(e, c.city)).path });
  while (!s.over) s = S.greedyTurn(e, s, { log });
  const v = verifyRun(data, JSON.parse(JSON.stringify({ scenario: "texas", seed: 7, home: null, log })));
  assert.equal(v.ok, true, v.error);
  assert.equal(v.hash, S.stateHash(s));
  assert.equal(shapeError({ type: "line", net: "power", path: [1, 2] }, 1e6), null);
  assert.equal(shapeError({ type: "line", net: "gas", path: [1, 2] }, 1e6), "Bad network");
  assert.equal(shapeError({ type: "line", path: [1, 2] }, 1e6), 'Missing "net"');
  const vs = S.newVersus(e, { seed: 1, years: 10, players: [{ name: "A" }, { name: "B", bot: true }] });
  // versus: every company may wire its own lines (not exclusive like freight contracts)
  const vp = S.planLine(e, vs.players[0].state, "power", c.cell, centre(e, c.city)).path;
  assert.equal(S.vsCheck(e, vs, 0, { type: "line", net: "power", path: vp }), null);
  const r = S.vsAct(e, vs, 0, { type: "line", net: "power", path: vp });
  assert.equal(r.error, null);
  assert.ok(r.vs.players[0].state.lines && !r.vs.players[1].state.lines);
});
