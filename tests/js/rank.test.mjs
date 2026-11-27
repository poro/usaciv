// Metro Ranking (web/js/games/rank/sim/rank.js), the Worker's /api/rank/daily and a rank race. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as R from "../../web/js/games/rank/sim/rank.js";
import { makeD1 } from "./d1shim.mjs";
import { utcToday } from "../../worker/rules.js";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}", shortCircuit: true };
    return next(spec, ctx);
  },
});
const worker = (await import("../../worker/index.js")).default;
const { RACE_GAMES, cleanRaceProgress } = await import("../../worker/racegames.js");
const dataUrl = (n) => new URL(`../../web/data/${n}.json`, import.meta.url);
const cities = JSON.parse(readFileSync(dataUrl("cities")));
const pool = R.rankPool(cities);
const byId = new Map(pool.map((c) => [c.id, c]));
const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };

test("rounds: deterministic, five stats, no repeated metro, every pair well apart, order is high to low", () => {
  const a = R.rankRounds(pool, R.dailySeed("2026-11-27"));
  assert.deepEqual(R.rankRounds(pool, R.dailySeed("2026-11-27")), a);
  assert.notDeepEqual(R.rankRounds(pool, R.dailySeed("2026-11-28")), a);
  assert.equal(a.length, R.ROUNDS);
  assert.equal(new Set(a.map((r) => r.stat)).size, R.ROUNDS);
  assert.equal(new Set(a.flatMap((r) => r.ids)).size, R.ROUNDS * R.SIZE);
  for (let k = 0; k < 200; k++) {
    for (const r of R.rankRounds(pool, `t${k}`)) {
      const s = R.statById(r.stat);
      const v = r.order.map((id) => s.value(byId.get(id)));
      assert.deepEqual([...r.ids].sort(), [...r.order].sort());
      for (let i = 1; i < v.length; i++) {
        assert.ok(v[i - 1] > v[i], `${r.stat} not descending`);
        const sep = s.signed ? (v[i - 1] - v[i]) / 0.05 : (v[i - 1] - v[i]) / Math.max(Math.abs(v[i - 1]), Math.abs(v[i]));
        assert.ok(sep >= R.MIN_SEP - 1e-12, `${r.stat} too close`);
      }
    }
  }
});

test("scoring: 10 points a pair, validation, partial for races", () => {
  const rs = R.rankRounds(pool, "x");
  const r = rs[0];
  assert.equal(R.roundPoints(r, r.order), 100);
  assert.equal(R.roundPoints(r, [...r.order].reverse()), 0);
  const swap = [r.order[1], r.order[0], ...r.order.slice(2)];
  assert.equal(R.roundPoints(r, swap), 90);
  assert.deepEqual(R.scoreRank(rs, rs.map((x) => x.order)), { score: 500, points: [100, 100, 100, 100, 100] });
  assert.ok(R.scoreRank(rs, rs.slice(0, 2).map((x) => x.order)).error, "the daily needs all five");
  assert.equal(R.scoreRank(rs, rs.slice(0, 2).map((x) => x.order), { partial: true }).score, 200);
  assert.ok(R.scoreRank(rs, [[r.order[0], r.order[0], ...r.order.slice(2)]], { partial: true }).error, "duplicates");
  assert.ok(R.scoreRank(rs, [[...r.order.slice(0, 4), rs[1].order[0]]], { partial: true }).error, "a metro from another round");
  assert.ok(R.scoreRank(rs, "nope").error);
  assert.equal(R.square(100), "🟩"); assert.equal(R.square(80), "🟨"); assert.equal(R.square(50), "🟧"); assert.equal(R.square(40), "🟥");
});

test("Worker: daily endpoint scores, first game counts, board, today, stats, account delete", async () => {
  const wenv = { DB: makeD1(), ASSETS: assets, IP_SALT: "t" };
  const call = async (method, path, body, token) => {
    const res = await worker.fetch(new Request(`https://usaciv.test${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: "https://usaciv.test", "CF-Connecting-IP": "1.2.3.4", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), wenv);
    return { status: res.status, data: await res.json() };
  };
  const key = utcToday();
  const day = R.rankRounds(pool, R.dailySeed(key));
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  const bob = (await call("POST", "/api/player", { name: "Bob" })).data;
  assert.equal((await call("POST", "/api/rank/daily", { key, orders: day.slice(0, 3).map((r) => r.order) }, ann.token)).status, 400);
  assert.equal((await call("POST", "/api/rank/daily", { key: "2001-01-01", orders: day.map((r) => r.order) }, ann.token)).status, 400);
  const orders = day.map((r, i) => (i === 0 ? [r.order[1], r.order[0], ...r.order.slice(2)] : r.order));
  assert.deepEqual((await call("POST", "/api/rank/daily", { key, orders }, ann.token)).data, { score: 490, rank: 1, total: 1 });
  assert.deepEqual((await call("POST", "/api/rank/daily", { key, orders: day.map((r) => r.order) }, ann.token)).data, { score: 490, rank: 1, total: 1, stored: true });
  assert.deepEqual((await call("POST", "/api/rank/daily", { key, orders: day.map((r) => r.order) }, bob.token)).data, { score: 500, rank: 1, total: 2 });
  const board = (await call("GET", `/api/rank/daily/${key}`, undefined, ann.token)).data;
  assert.deepEqual(board.top.map((r) => [r.name, r.score, r.rank]), [["Bob", 500, 1], ["Ann", 490, 2]]);
  assert.deepEqual(board.you, { score: 490, rank: 2 });
  assert.deepEqual((await call("GET", "/api/today", undefined, ann.token)).data.games.rank, { key, total: 2, you: { value: 490, rank: 2 } });
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.rk.best, 490);
  assert.equal((await call("DELETE", "/api/account", { confirm: "Ann" }, ann.token)).status, 200);
  assert.equal((await call("GET", `/api/rank/daily/${key}`)).data.total, 1);
});

test("race scorer: partial rankings count, bad ones are refused, progress bounds", async () => {
  const env = { ASSETS: assets };
  const rs = R.rankRounds(pool, R.practiceSeed("abc123"));
  assert.deepEqual(await RACE_GAMES.rank.score(env, "abc123", { orders: rs.slice(0, 2).map((r) => r.order) }), { score: 200, round: 2 });
  assert.deepEqual(await RACE_GAMES.rank.score(env, "abc123", { orders: rs.map((r) => r.order) }), { score: 500, round: 5 });
  assert.ok((await RACE_GAMES.rank.score(env, "abc123", { orders: [["x"]] })).error);
  assert.deepEqual(cleanRaceProgress("rank", { round: 2, score: 190 }), { round: 2, clues: 0, score: 190 });
  assert.equal(cleanRaceProgress("rank", { round: 2, score: 501 }), null);
});
