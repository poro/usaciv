// Metro Duel (web/js/games/duel/sim/duel.js) and the Worker's /api/duel/daily. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as D from "../../web/js/games/duel/sim/duel.js";
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
const cities = JSON.parse(readFileSync(dataUrl("cities")));
const pool = D.duelPool(cities);
const byId = new Map(pool.map((c) => [c.id, c]));

test("sequences: deterministic, chained, never a near-tie, no repeated stat in a row", () => {
  assert.equal(pool.length, D.POOL_SIZE);
  const a = D.duelSequence(pool, "duel:2026-11-27"), b = D.duelSequence(pool, "duel:2026-11-27");
  assert.deepEqual(a, b);
  assert.equal(a.length, D.DAILY_DUELS);
  for (let i = 0; i < a.length; i++) {
    const d = a[i], s = D.statById(d.stat);
    const va = s.value(byId.get(d.a)), vb = s.value(byId.get(d.b));
    assert.notEqual(d.a, d.b);
    assert.equal(d.higher, vb > va);
    if (!s.signed) assert.ok(Math.abs(va - vb) / Math.max(va, vb) >= D.MIN_GAP - 1e-12, `${i} ${d.stat}`);
    if (i) { assert.equal(d.a, a[i - 1].b); assert.notEqual(d.stat, a[i - 1].stat); }
  }
  // early duels are easier than late ones on average
  const gapAt = (d) => { const s = D.statById(d.stat); if (s.signed) return null; const x = s.value(byId.get(d.a)), y = s.value(byId.get(d.b)); return Math.abs(x - y) / Math.max(x, y); };
  const avg = (xs) => { const v = xs.map(gapAt).filter((x) => x != null); return v.reduce((p, q) => p + q, 0) / v.length; };
  const many = Array.from({ length: 20 }, (_, k) => D.duelSequence(pool, `t${k}`));
  assert.ok(avg(many.flatMap((s) => s.slice(0, 4))) > avg(many.flatMap((s) => s.slice(20))));
});

test("streakOf counts right answers up to the first wrong one", () => {
  const seq = D.duelSequence(pool, "x");
  const right = seq.map((d) => d.higher);
  assert.deepEqual(D.streakOf(seq, right), { streak: 30, over: true, answered: 30 });
  assert.deepEqual(D.streakOf(seq, [...right.slice(0, 5), !right[5]]), { streak: 5, over: true, answered: 6 });
  assert.deepEqual(D.streakOf(seq, right.slice(0, 3)), { streak: 3, over: false, answered: 3 });
  assert.ok(D.streakOf(seq, ["yes"]).error);
  assert.ok(D.streakOf(seq, [...right, true]).error);
});

test("Worker: only finished runs, server-counted streak, first run counts, board", async () => {
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
  const seq = D.duelSequence(pool, D.dailySeed(key));
  const right = seq.map((d) => d.higher);
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  const bob = (await call("POST", "/api/player", { name: "Bob" })).data;
  assert.equal((await call("POST", "/api/duel/daily", { key, answers: right.slice(0, 4) }, ann.token)).status, 422, "unfinished");
  const r = await call("POST", "/api/duel/daily", { key, answers: [...right.slice(0, 7), !right[7]] }, ann.token);
  assert.deepEqual(r.data, { streak: 7, rank: 1, total: 1 });
  const rb = await call("POST", "/api/duel/daily", { key, answers: right }, bob.token);
  assert.deepEqual(rb.data, { streak: 30, rank: 1, total: 2 });
  assert.equal((await call("POST", "/api/duel/daily", { key, answers: right }, ann.token)).data.streak, 7, "first run counts");
  const b = (await call("GET", `/api/duel/daily/${key}`, undefined, ann.token)).data;
  assert.deepEqual(b.top.map((x) => [x.name, x.streak, x.rank]), [["Bob", 30, 1], ["Ann", 7, 2]]);
  assert.deepEqual(b.you, { streak: 7, rank: 2 });
  assert.equal((await call("GET", "/api/account/stats", undefined, bob.token)).data.dl.best, 30);
});

test("GET /api/today: every daily's player count and, signed in, your rank", async () => {
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
  const seq = D.duelSequence(pool, D.dailySeed(key));
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  await call("POST", "/api/duel/daily", { key, answers: [!seq[0].higher] }, ann.token);
  const anon = (await call("GET", "/api/today")).data;
  assert.deepEqual(Object.keys(anon.games).sort(), ["duel", "founders", "mainline", "pinpoint", "trip", "whichMetro"]);
  assert.equal(anon.games.duel.total, 1);
  assert.equal(anon.games.duel.you, null);
  const mine = (await call("GET", `/api/today?local=${key}`, undefined, ann.token)).data;
  assert.deepEqual(mine.games.duel.you, { value: 0, rank: 1 });
  assert.equal(mine.games.pinpoint.you, null);
  assert.equal((await call("GET", "/api/today?local=1999-01-01")).data.local, key, "an out-of-window local date falls back to UTC");
});

test("Road Trip: trips, best loop, scoring and the daily endpoint", async () => {
  const T = await import("../../web/js/games/trip/sim/trip.js");
  const tpool = T.tripPool(cities);
  const t = T.tripFor(tpool, "trip:2026-11-27");
  assert.deepEqual(T.tripFor(tpool, "trip:2026-11-27"), t);
  assert.equal(t.stops.length, T.STOPS);
  for (const s of t.stops) assert.ok(T.km(s, t.start) <= T.RADIUS_KM);
  const best = T.scoreTrip(t, t.best.order);
  assert.equal(best.points, 1000);
  assert.equal(best.km, best.best);
  const rev = T.scoreTrip(t, [...t.best.order].reverse());
  assert.equal(rev.points, 1000, "the reverse loop is just as short");
  assert.ok(T.scoreTrip(t, t.best.order.slice(1)).error);
  assert.ok(T.scoreTrip(t, [...t.best.order.slice(1), t.best.order[1]]).error);
  // every order scores ≤ 1000
  const worst = T.scoreTrip(t, [t.best.order[0], t.best.order[3], t.best.order[1], t.best.order[4], t.best.order[2], t.best.order[5]]);
  assert.ok(worst.points <= 1000 && worst.km >= best.km);

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
  const day = T.tripFor(tpool, T.dailySeed(key));
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  assert.equal((await call("POST", "/api/trip/daily", { key, order: day.best.order.slice(2) }, ann.token)).status, 400);
  const r = (await call("POST", "/api/trip/daily", { key, order: day.best.order }, ann.token)).data;
  assert.equal(r.score, 1000);
  assert.equal(r.rank, 1);
  assert.equal((await call("GET", `/api/trip/daily/${key}`)).data.top[0].name, "Ann");
  assert.equal((await call("GET", "/api/today", undefined, ann.token)).data.games.trip.you.value, 1000);
});
