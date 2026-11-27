// Rail Link (web/js/games/link/sim/link.js), the Worker's /api/link/daily and its race scorer. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as K from "../../web/js/games/link/sim/link.js";
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
const { RACE_GAMES, cleanRaceProgress } = await import("../../worker/racegames.js");
const dataUrl = (n) => new URL(`../../web/data/${n}.json`, import.meta.url);
const D = (n) => JSON.parse(readFileSync(dataUrl(n)));
const world = D("world");
const L = K.linkEnv({ world, infrastructure: D("infrastructure") }, makeHexMap(world));
const pool = K.linkPool(D("cities"), L);
const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };
const star = (p) => { // every metro by its own cheapest path from the first: a valid, lazier network
  const out = [];
  for (const c of p.cells.slice(1)) { const { prev } = K.dijkstra(L, [p.cells[0]], { target: c }); const path = K.pathTo(prev, c); for (let i = 1; i < path.length; i++) out.push([path[i - 1], path[i]]); }
  return out;
};

test("puzzles: deterministic, five metros well apart and reachable", () => {
  assert.ok(pool.length > 120);
  const a = K.linkPuzzle(pool, L, K.dailySeed("2026-11-27"));
  assert.deepEqual(K.linkPuzzle(pool, L, K.dailySeed("2026-11-27")), a);
  for (let k = 0; k < 15; k++) {
    const p = K.linkPuzzle(pool, L, `t${k}`);
    assert.equal(p.cells.length, K.TERMINALS);
    for (let i = 0; i < p.cells.length; i++) for (let j = i + 1; j < p.cells.length; j++) assert.ok(L.hexmap.km(p.cells[i], p.cells[j]) >= K.MIN_APART_KM);
    const reach = K.dijkstra(L, [p.cells[0]]);
    assert.ok(p.cells.every((c) => reach.dist[c] < Infinity));
  }
});

test("par joins everything, scores 1000; a star network costs at least as much; scoring rules", () => {
  for (let k = 0; k < 6; k++) {
    const p = K.linkPuzzle(pool, L, `s${k}`);
    const par = K.parNetwork(L, p.cells);
    assert.equal(K.connectedCount(p.cells, par.edges), K.TERMINALS);
    assert.deepEqual(K.scoreNetwork(L, p, par.edges, par), { score: 1000, cost: par.cost, par: par.cost });
    const s = K.scoreNetwork(L, p, star(p), par);
    assert.ok(s.cost >= par.cost && s.score <= 1000);
  }
  assert.equal(K.scoreFor(100, 110), 751);
  assert.equal(K.scoreFor(110, 100), 1331);
  const p = K.linkPuzzle(pool, L, "s0");
  const par = K.parNetwork(L, p.cells);
  assert.match(K.scoreNetwork(L, p, par.edges.slice(0, 5), par).error, /join all five/);
  assert.ok(K.scoreNetwork(L, p, [[0, 5000]], par).error, "not neighbours");
  assert.ok(K.scoreNetwork(L, p, "x", par).error);
  // duplicates and reversed links count once
  const dup = [...par.edges, ...par.edges.map(([a, b]) => [b, a])];
  assert.equal(K.scoreNetwork(L, p, dup, par).cost, par.cost);
});

test("Worker: daily endpoint, board, today, stats; race scorer", async () => {
  const wenv = { DB: makeD1(), ASSETS: assets, IP_SALT: "t" };
  const call = async (method, path, body, token) => {
    const res = await worker.fetch(new Request(`https://usaciv.test${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: "https://usaciv.test", "CF-Connecting-IP": "1.2.3.4", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), wenv);
    return { status: res.status, data: await res.json() };
  };
  const key = utcToday();
  const p = K.linkPuzzle(pool, L, K.dailySeed(key));
  const par = K.parNetwork(L, p.cells);
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  assert.equal((await call("POST", "/api/link/daily", { key, edges: par.edges.slice(0, 3) }, ann.token)).status, 400);
  const s = K.scoreNetwork(L, p, star(p), par);
  assert.deepEqual((await call("POST", "/api/link/daily", { key, edges: star(p) }, ann.token)).data, { score: s.score, rank: 1, total: 1 });
  assert.equal((await call("POST", "/api/link/daily", { key, edges: par.edges }, ann.token)).data.stored, true);
  assert.equal((await call("GET", `/api/link/daily/${key}`)).data.top[0].score, s.score);
  assert.deepEqual((await call("GET", "/api/today", undefined, ann.token)).data.games.link.you, { value: s.score, rank: 1 });
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.lk.best, s.score);

  const env = { ASSETS: assets };
  const pp = K.linkPuzzle(pool, L, K.practiceSeed("abc123"));
  const ppar = K.parNetwork(L, pp.cells);
  assert.deepEqual(await RACE_GAMES.link.score(env, "abc123", { edges: ppar.edges }), { score: 1000, round: 5 });
  assert.ok((await RACE_GAMES.link.score(env, "abc123", { edges: [] })).error);
  assert.deepEqual(cleanRaceProgress("link", { round: 3, score: 0 }), { round: 3, clues: 0, score: 0 });
  assert.equal(cleanRaceProgress("link", { round: 6, score: 0 }), null);
});
