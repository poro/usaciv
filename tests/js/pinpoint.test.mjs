// Pinpoint (web/js/games/pinpoint/sim/rounds.js) and the Worker's /api/pp/daily. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as P from "../../web/js/games/pinpoint/sim/rounds.js";
import { makeHexMap } from "../../web/js/games/shared/hexmap.js";
import { makeD1 } from "./d1shim.mjs";
import { utcToday } from "../../worker/rules.js";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}", shortCircuit: true };
    return next(spec, ctx);
  },
});
const worker = (await import("../../worker/index.js")).default;
const dataUrl = (n) => new URL(`../../web/data/${n}.json`, import.meta.url);
const D = (n) => JSON.parse(readFileSync(dataUrl(n)));
const grid = makeHexMap(D("world")).grid;
const pool = P.buildPool({ cities: D("cities"), resources: D("resources"), wonders: D("wonders"), infrastructure: D("infrastructure") }, grid);

test("every slot has a deep pool of real places", () => {
  for (const s of P.SLOTS) assert.ok(pool[s].length >= 15, `${s}: ${pool[s].length}`);
  for (const p of Object.values(pool).flat()) {
    assert.ok(p.name && p.where && p.detail, p.id);
    assert.equal(p.x, grid.cx(p.cell));
  }
});

test("a day's rounds: deterministic, one per slot, distinct hexes, a metro first", () => {
  const a = P.dailyRounds(pool, "2026-11-27"), b = P.dailyRounds(pool, "2026-11-27"), c = P.dailyRounds(pool, "2026-11-28");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((p) => p.id), c.map((p) => p.id));
  assert.equal(a.length, P.ROUNDS);
  assert.deepEqual(new Set(a.map((p) => p.slot)), new Set(P.SLOTS));
  assert.equal(new Set(a.map((p) => p.cell)).size, P.ROUNDS);
  assert.equal(a[0].kind, "metro");
  for (let d = 1; d <= 30; d++) assert.equal(P.dailyRounds(pool, `2026-12-${String(d).padStart(2, "0")}`)[0].kind, "metro");
});

test("scoring: full marks within a hex, a point a km after that, never negative", () => {
  const p = P.dailyRounds(pool, "2026-11-27")[0];
  assert.deepEqual(P.scoreGuess(grid, p, p.cell), { km: 0, points: 1000 });
  const far = Object.values(pool).flat().find((q) => Math.hypot(q.x - p.x, q.y - p.y) > 2000);
  assert.equal(P.scoreGuess(grid, p, far.cell).points, 0);
  const mid = Object.values(pool).flat().find((q) => { const d = Math.hypot(q.x - p.x, q.y - p.y); return d > 200 && d < 600; });
  const r = P.scoreGuess(grid, p, mid.cell);
  assert.equal(r.points, 1000 - (r.km - 25));
  assert.ok(P.scoreGame(grid, [p], [1.5]).error);
  assert.ok(P.scoreGame(grid, [p], []).error);
  assert.equal(P.square(1000), "🟩");
  assert.equal(P.square(10), "🟥");
});

test("Worker: the server scores the guesses itself; first game counts; board", async () => {
  const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };
  const wenv = { DB: makeD1(), ASSETS: assets, IP_SALT: "t" };
  const call = async (method, path, body, token) => {
    const res = await worker.fetch(new Request(`https://usaciv.test${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: "https://usaciv.test", "CF-Connecting-IP": "1.2.3.4", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), wenv);
    return { status: res.status, data: await res.json() };
  };
  const key = utcToday();
  const rounds = P.dailyRounds(pool, key);
  const perfect = rounds.map((p) => p.cell);
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  const bob = (await call("POST", "/api/player", { name: "Bob" })).data;
  assert.equal((await call("POST", "/api/pp/daily", { key, guesses: perfect.slice(1) }, ann.token)).status, 400);
  assert.equal((await call("POST", "/api/pp/daily", { key: "2020-01-01", guesses: perfect }, ann.token)).status, 400);
  const r = await call("POST", "/api/pp/daily", { key, guesses: perfect }, ann.token);
  assert.deepEqual(r.data, { score: 8000, rank: 1, total: 1 });
  const off = perfect.map((c, i) => (i === 0 ? rounds[3].cell : c));
  const rb = (await call("POST", "/api/pp/daily", { key, guesses: off }, bob.token)).data;
  assert.equal(rb.rank, 2);
  assert.equal((await call("POST", "/api/pp/daily", { key, guesses: off }, ann.token)).data.stored, true);
  const b = (await call("GET", `/api/pp/daily/${key}`, undefined, bob.token)).data;
  assert.deepEqual(b.top.map((x) => x.name), ["Ann", "Bob"]);
  assert.equal(b.you.rank, 2);
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.pp.best, 8000);
});
