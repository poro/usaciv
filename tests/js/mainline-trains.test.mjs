// Mainline train animation and sound helpers (pure, no DOM): node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { buildRoutes, routeCells, trainsAt, pointAt, trainCount, phaseOf, MAX_TRAINS, TRAIN_SPEED, EXPRESS_SPEED } from "../../web/js/games/mainline/trains.js";
import { BLIPS } from "../../web/js/games/mainline/sound.js";
import { gameHtml } from "../../web/js/games/mainline/panel.js";

// a toy line of cells 0..5 along x (cell i at x = 10 i km)
const cx = (c) => c * 10, cy = () => 0;
const link = (a, b, extra = {}) => ({ a, b, ...extra });
const links = { "0-1": link(0, 1), "1-2": link(1, 2), "2-3": link(2, 3), "3-4": link(3, 4), "4-5": link(4, 5) };

test("routeCells follows the served keys from sv.from, either direction, and refuses damaged or stale links", () => {
  assert.deepEqual(routeCells({ from: 0, keys: ["0-1", "1-2", "2-3"] }, links), [0, 1, 2, 3]);
  assert.deepEqual(routeCells({ from: 3, keys: ["2-3", "1-2"] }, links), [3, 2, 1]);
  assert.equal(routeCells({ from: 0, keys: ["0-1", "3-4"] }, links), null, "keys that do not join");
  assert.equal(routeCells({ from: 0, keys: ["0-1", "1-9"] }, links), null, "missing link");
  assert.equal(routeCells({ from: 0, keys: ["0-1", "1-2"] }, { ...links, "1-2": link(1, 2, { d: 1 }) }), null, "damaged link");
  assert.equal(routeCells({ from: 0, keys: [] }, links), null);
});

test("buildRoutes: world-km polylines, train counts by pay and express, damaged routes skipped", () => {
  const served = new Map([
    ["a", { pay: 1, from: 0, keys: ["0-1", "1-2", "2-3", "3-4", "4-5"] }],
    ["b", { pay: 30, from: 5, keys: ["4-5", "3-4"] }],
    ["cut", { pay: 9, from: 0, keys: ["0-1"] }],
  ]);
  const cut = { ...links, "0-1": link(0, 1, { d: 1 }) };
  const rs = buildRoutes({ served, links, express: { b: 2030 }, cx, cy });
  assert.equal(rs.length, 3);
  const a = rs.find((r) => r.id === "a");
  assert.deepEqual(a.pts, [0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0]);
  assert.deepEqual(a.cum, [0, 10, 20, 30, 40, 50]);
  assert.equal(a.len, 50);
  assert.equal(a.n, 1);
  assert.equal(a.speed, TRAIN_SPEED);
  const b = rs.find((r) => r.id === "b");
  assert.equal(b.n, MAX_TRAINS + 1, "busy express route: the cap plus the express train");
  assert.ok(b.express && b.speed === EXPRESS_SPEED);
  // a damaged link on the route: no trains (evaluate() would not serve it; this guards a stale served map)
  assert.ok(!buildRoutes({ served, links: cut, cx, cy }).some((r) => r.id === "cut" || r.id === "a"));
  // minGap thins out trains on a short route (20 km long, 15 km gap: one train)
  const short = buildRoutes({ served: new Map([["b", served.get("b")]]), links, cx, cy, minGap: 15 });
  assert.equal(short[0].n, 1);
  // pure: inputs untouched
  assert.deepEqual(links["0-1"], { a: 0, b: 1 });
});

test("trainCount and phaseOf", () => {
  assert.equal(trainCount(0), 1);
  assert.equal(trainCount(3.9), 1);
  assert.equal(trainCount(4), 2);
  assert.equal(trainCount(1000), MAX_TRAINS);
  assert.equal(trainCount(0, true), 2);
  assert.equal(phaseOf("x"), phaseOf("x"));
  for (const id of ["a", "b", "faf:12", "m:48900-26420"]) assert.ok(phaseOf(id) >= 0 && phaseOf(id) < 1);
});

test("pointAt and trainsAt keep trains on the line, moving, and turning back at the ends", () => {
  const r = { id: "t", pts: [0, 0, 10, 0, 10, 10], cum: [0, 10, 20], len: 20, n: 2, speed: 10, phase: 0 };
  assert.deepEqual(pointAt(r, 5), { x: 5, y: 0, a: 0 });
  const p = pointAt(r, 15);
  assert.equal(p.x, 10);
  assert.equal(p.y, 5);
  assert.ok(Math.abs(p.a - Math.PI / 2) < 1e-9);
  assert.deepEqual([pointAt(r, -3).x, pointAt(r, 99).y], [0, 10], "clamped to the ends");
  // one way takes 2 s: train 0 starts at the first end, is at the far end at t = 2, back home at t = 4
  const at = (t) => trainsAt(r, t);
  assert.equal(at(0).length, 2);
  assert.deepEqual([at(0)[0].x, at(0)[0].y], [0, 0]);
  assert.deepEqual([at(1)[0].x, at(1)[0].y], [10, 0]);
  assert.ok(Math.abs(at(2)[0].y - 10) < 1e-9);
  assert.ok(Math.abs(at(3.5)[0].x - 5) < 1e-9 && Math.abs(at(3.5)[0].y) < 1e-9, "on its way back");
  assert.ok(Math.abs(at(3.5)[0].a - Math.PI) < 1e-9, "heading back along the first leg");
  // train 1 runs the other way, half a loop apart
  assert.ok(Math.abs(at(0)[1].x - 10) < 1e-9 && Math.abs(at(0)[1].y - 10) < 1e-9);
  assert.notDeepEqual(at(0.5)[0], at(0.5)[1], "two trains never ride on top of each other");
  assert.ok(Math.abs(Math.abs(at(0.5)[0].a - at(0.5)[1].a) - Math.PI) < 1e-9 || at(0.5)[0].a !== at(0.5)[1].a, "they head opposite ways");
  // always on the polyline (x in 0..10 on the first leg, y in 0..10 on the second)
  for (let t = 0; t < 10; t += 0.13) {
    for (const q of at(t)) {
      const onA = Math.abs(q.y) < 1e-9 && q.x >= -1e-9 && q.x <= 10 + 1e-9;
      const onB = Math.abs(q.x - 10) < 1e-9 && q.y >= -1e-9 && q.y <= 10 + 1e-9;
      assert.ok(onA || onB, `t=${t.toFixed(2)}: (${q.x}, ${q.y}) is on the track`);
    }
  }
  assert.deepEqual(at(7.25), at(7.25), "a pure function of time");
});

test("trains on a real game: every served contract gets a route from end to end, and the sim is untouched", () => {
  const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
  const data = { world: R("world"), cities: R("cities"), trade: R("trade"), infrastructure: R("infrastructure"), disasters: R("disasters") };
  const e = S.makeEnv(data, "texas");
  let s = S.newGame(e, { seed: 3 });
  for (let k = 0; k < 8; k++) s = S.greedyTurn(e, s);
  const ev = S.evaluate(e, s);
  assert.ok(ev.served.size > 2);
  const before = S.stateHash(s);
  const json = JSON.stringify(s);
  const g = e.hexmap.grid;
  const rs = buildRoutes({ served: ev.served, links: s.links, express: s.express, cx: g.cx, cy: g.cy, minGap: g.R * 2.2 });
  assert.equal(rs.length, ev.served.size, "intact network: every served contract has trains");
  for (const r of rs) {
    const c = e.contractById.get(r.id);
    const first = [r.pts[0], r.pts[1]], last = [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]];
    const ends = (end) => end.cells.map((x) => [g.cx(x), g.cy(x)]);
    const has = (list, p) => list.some(([x, y]) => x === p[0] && y === p[1]);
    assert.ok((has(ends(c.a), first) && has(ends(c.b), last)) || (has(ends(c.b), first) && has(ends(c.a), last)), `${r.id} runs end to end`);
    assert.ok(r.n >= 1 && r.n <= MAX_TRAINS + 1);
    for (const q of trainsAt(r, 12.3)) assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y));
  }
  assert.equal(S.stateHash(s), before);
  assert.equal(JSON.stringify(s), json);
});

test("panel: Trains and Sound toggles reflect the prefs; reduced motion disables Trains", () => {
  const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
  const data = { world: R("world"), cities: R("cities"), trade: R("trade"), infrastructure: R("infrastructure"), disasters: R("disasters") };
  const e = S.makeEnv(data, "texas");
  const s = S.newGame(e, { seed: 1 });
  const m = (ui) => ({ env: e, state: s, ev: S.evaluate(e, s), sum: S.summary(e, s), ui: { tab: "open", coach: null, ...ui }, sel: { start: null }, touch: false });
  assert.match(gameHtml(m({ trains: true, sound: false })), /data-act="trains" checked[\s\S]*data-act="sound" >/);
  assert.match(gameHtml(m({ trains: false, sound: true })), /data-act="trains" >[\s\S]*data-act="sound" checked/);
  assert.match(gameHtml(m({ trains: true, motion: false })), /data-act="trains"  disabled/);
});

test("sound blips are short synthesised voices", () => {
  for (const [name, voices] of Object.entries(BLIPS)) {
    assert.ok(voices.length >= 1, name);
    for (const [type, f0, f1, at, len, peak] of voices) {
      assert.ok(["sine", "square", "triangle", "sawtooth"].includes(type));
      assert.ok(f0 > 20 && f1 > 20, "exponential ramps need positive frequencies");
      assert.ok(at >= 0 && len > 0 && at + len <= 1, `${name} is under a second`);
      assert.ok(peak > 0 && peak <= 0.3, `${name} is quiet`);
    }
  }
});
