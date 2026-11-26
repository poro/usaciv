// node --test tests/js   (no npm, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeRng, seedFrom, todayKey } from "../../web/js/games/shared/rng.js";
import { makeHexMap, MinHeap } from "../../web/js/games/shared/hexmap.js";

const world = JSON.parse(readFileSync(new URL("../../web/data/world.json", import.meta.url)));

test("rng is deterministic and restorable", () => {
  const a = makeRng("seed"), b = makeRng(seedFrom("seed"));
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
  const s = a.state, n1 = a.next();
  a.state = s;
  assert.equal(a.next(), n1);
  for (let k = 0; k < 1000; k++) { const v = a.int(3, 7); assert.ok(v >= 3 && v <= 7); }
  assert.equal(a.weighted([0, 0, 5]), 2);
  assert.equal(a.weighted([0, 0]), -1);
  assert.deepEqual([...a.shuffle([1, 2, 3, 4])].sort(), [1, 2, 3, 4]);
  assert.match(todayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test("heap pops in priority order", () => {
  const h = new MinHeap();
  [5, 1, 4, 2, 3].forEach((p) => h.push(`x${p}`, p));
  assert.deepEqual([h.pop(), h.pop(), h.pop()], ["x1", "x2", "x3"]);
});

test("hexmap distances, neighbours and paths on the real grid", () => {
  const m = makeHexMap(world);
  const land = [];
  for (let i = 0; i < m.size; i++) if (m.isLand(i)) land.push(i);
  assert.ok(land.length > 4000);
  const a = land[1000];
  for (const n of m.neighbours(a)) assert.equal(m.dist(a, n), 1);
  assert.equal(m.within(a, 1).length, 7);
  assert.equal(m.within(a, 2).length, 19);
  const b = land[3000];
  const r = m.path(a, b, (x, y) => (m.isLand(y) ? 1 : Infinity), { minStep: 1 });
  assert.ok(r);
  assert.equal(r.path[0], a);
  assert.equal(r.path.at(-1), b);
  assert.ok(r.cost >= m.dist(a, b));
  for (let k = 1; k < r.path.length; k++) assert.equal(m.dist(r.path[k - 1], r.path[k]), 1);
  assert.equal(m.edgeKey(5, 3), m.edgeKey(3, 5));
});
