// State Shapes (web/js/games/shapes/sim/shapes.js), the Worker's /api/shapes/daily and its race scorer. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as S from "../../web/js/games/shapes/sim/shapes.js";
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
const world = JSON.parse(readFileSync(dataUrl("world")));
const pool = S.shapePool(world);
const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };

test("pool: states big enough to read, with their hexes", () => {
  assert.ok(pool.length >= 35);
  assert.ok(pool.every((s) => s.cells.length >= S.MIN_HEXES && /^[A-Z]{2}$/.test(s.abbr)));
  assert.ok(!pool.some((s) => s.abbr === "RI" || s.abbr === "DE"));
  assert.ok(pool.find((s) => s.abbr === "TX").cells.length > 300);
});

test("rounds: deterministic, eight states, decoys close in size, upright first then turned", () => {
  const a = S.shapeRounds(pool, S.dailySeed("2026-11-27"));
  assert.deepEqual(S.shapeRounds(pool, S.dailySeed("2026-11-27")), a);
  assert.equal(a.length, S.ROUNDS);
  for (let k = 0; k < 100; k++) {
    const rs = S.shapeRounds(pool, `t${k}`);
    assert.equal(new Set(rs.map((r) => r.answer)).size, S.ROUNDS);
    rs.forEach((r, i) => {
      assert.equal(r.options.length, S.CHOICES);
      assert.equal(new Set(r.options).size, S.CHOICES);
      assert.ok(r.options.includes(r.answer));
      if (i < S.UPRIGHT) assert.equal(r.turn, 0); else if (i < S.FREE_TURNS) assert.equal(r.turn, 3); else assert.ok(r.turn >= 1 && r.turn <= 5);
    });
  }
});

test("silhouette: turning by 60° six times is the identity; a half turn keeps the box; hexes stay on the lattice", () => {
  const tx = pool.find((s) => s.abbr === "TX").cells;
  const s0 = S.silhouette(tx, world.grid.cols, 0), s6 = S.silhouette(tx, world.grid.cols, 6), s3 = S.silhouette(tx, world.grid.cols, 3);
  assert.deepEqual(s6, s0);
  assert.ok(Math.abs(s3.w - s0.w) < 1e-9 && Math.abs(s3.h - s0.h) < 1e-9);
  // every turned centre is still a lattice point: y a multiple of 1.5, distinct points as many as cells
  for (let t = 0; t < 6; t++) {
    const s = S.silhouette(tx, world.grid.cols, t);
    assert.equal(new Set(s.pts.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`)).size, tx.length);
    assert.ok(s.pts.every(([, y]) => Math.abs(((y - 1) / 1.5) - Math.round((y - 1) / 1.5)) < 1e-9));
  }
});

test("scoring, the daily endpoint and the race scorer", async () => {
  const rs = S.shapeRounds(pool, "x");
  assert.deepEqual(S.scoreShapes(rs, rs.map((r) => r.answer)).score, 8);
  assert.ok(S.scoreShapes(rs, rs.slice(0, 3).map((r) => r.answer)).error);
  assert.equal(S.scoreShapes(rs, rs.slice(0, 3).map((r) => r.answer), { partial: true }).score, 3);
  assert.ok(S.scoreShapes(rs, ["ZZ"], { partial: true }).error);

  const wenv = { DB: makeD1(), ASSETS: assets, IP_SALT: "t" };
  const call = async (method, path, body, token) => {
    const res = await worker.fetch(new Request(`https://usaciv.test${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: "https://usaciv.test", "CF-Connecting-IP": "1.2.3.4", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), wenv);
    return { status: res.status, data: await res.json() };
  };
  const key = utcToday();
  const day = S.shapeRounds(pool, S.dailySeed(key));
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  const picks = day.map((r, i) => (i === 7 ? r.options.find((o) => o !== r.answer) : r.answer));
  assert.equal((await call("POST", "/api/shapes/daily", { key, picks: picks.slice(0, 7) }, ann.token)).status, 400);
  assert.deepEqual((await call("POST", "/api/shapes/daily", { key, picks }, ann.token)).data, { score: 7, rank: 1, total: 1 });
  assert.equal((await call("POST", "/api/shapes/daily", { key, picks: day.map((r) => r.answer) }, ann.token)).data.stored, true);
  assert.equal((await call("GET", `/api/shapes/daily/${key}`)).data.top[0].score, 7);
  assert.deepEqual((await call("GET", "/api/today", undefined, ann.token)).data.games.shapes.you, { value: 7, rank: 1 });
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.sh.best, 7);

  const env = { ASSETS: assets };
  const prs = S.shapeRounds(pool, S.practiceSeed("abc123"));
  assert.deepEqual(await RACE_GAMES.shapes.score(env, "abc123", { picks: prs.slice(0, 5).map((r) => r.answer) }), { score: 5, round: 5 });
  assert.ok((await RACE_GAMES.shapes.score(env, "abc123", { picks: [] })).error);
  assert.deepEqual(cleanRaceProgress("shapes", { round: 8, score: 8 }), { round: 8, clues: 0, score: 8 });
  assert.equal(cleanRaceProgress("shapes", { round: 9, score: 1 }), null);
});
