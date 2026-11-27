// Settle (web/js/games/settle/sim/settle.js), the Worker's /api/settle/daily and its race scorer. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as S from "../../web/js/games/settle/sim/settle.js";
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
const E = S.settleEnv({ world, counties: D("counties") }, makeHexMap(world));
const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };
const cities = D("cities");
const metroAt = new Map();
for (const c of cities) if (c.metro) for (const f of c.footprint || [c.cell]) if (!metroAt.has(f)) metroAt.set(f, c.name);

test("people per hex: the census total kept, cities heavier than their countryside", () => {
  const total = E.cellPop.reduce((a, b) => a + b, 0);
  const iPop = D("counties").columns.indexOf("population");
  const want = D("counties").rows.reduce((a, r) => a + (r[iPop] || 0), 0);
  assert.ok(total > want * 0.97 && total <= want + 1, `${total} vs ${want}`);
  const phx = cities.find((c) => c.name === "Phoenix" && c.metro);
  const ring = E.hexmap.within(phx.cell, 6).filter((c) => E.hexmap.dist(c, phx.cell) === 6 && world.owner[c] >= 0);
  assert.ok(ring.every((c) => E.cellPop[c] < E.cellPop[phx.cell] / 10), "Maricopa's desert is not full of people");
  assert.equal(E.regionCells.size, S.REGIONS.length);
});

test("par: five sites in the region, apart, mostly on real metros; puzzles deterministic; scoring", () => {
  assert.deepEqual(S.settlePuzzle(S.dailySeed("2026-11-27")), S.settlePuzzle(S.dailySeed("2026-11-27")));
  let onMetro = 0;
  for (const r of S.REGIONS) {
    const p = { region: r.id };
    const par = S.parSites(E, p);
    assert.equal(par.sites.length, S.SITES);
    for (let i = 0; i < S.SITES; i++) {
      assert.equal(S.siteProblem(E, p, par.sites.slice(0, i), par.sites[i]), null);
      onMetro += E.hexmap.within(par.sites[i], 1).some((c) => metroAt.has(c)) ? 1 : 0;
    }
    assert.deepEqual(S.scoreSites(E, p, par.sites, par).score, 1000);
  }
  assert.ok(onMetro >= S.REGIONS.length * S.SITES * 0.9, `${onMetro} par sites near a metro`);
  const p = { region: "tx" };
  const par = S.parSites(E, p);
  assert.match(S.scoreSites(E, p, par.sites.slice(0, 4), par).error, /need 5/);
  assert.match(S.scoreSites(E, p, [par.sites[0], par.sites[0] + 1, ...par.sites.slice(2)], par).error, /apart/);
  const ca = E.regionCells.get("cal")[0];
  assert.match(S.scoreSites(E, p, [ca, ...par.sites.slice(1)], par).error, /Texas/);
  // empty land scores little
  const rural = [...E.regionCells.get("tx")].sort((a, b) => E.cellPop[a] - E.cellPop[b]);
  const sparse = [];
  for (const c of rural) { if (!S.siteProblem(E, p, sparse, c)) sparse.push(c); if (sparse.length === 5) break; }
  assert.ok(S.scoreSites(E, p, sparse, par).score < 20);
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
  const p = S.settlePuzzle(S.dailySeed(key));
  const par = S.parSites(E, p);
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  assert.equal((await call("POST", "/api/settle/daily", { key, sites: par.sites.slice(0, 2) }, ann.token)).status, 400);
  assert.deepEqual((await call("POST", "/api/settle/daily", { key, sites: par.sites }, ann.token)).data, { score: 1000, rank: 1, total: 1 });
  assert.equal((await call("GET", `/api/settle/daily/${key}`)).data.top[0].score, 1000);
  assert.deepEqual((await call("GET", "/api/today", undefined, ann.token)).data.games.settle.you, { value: 1000, rank: 1 });
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.st.best, 1000);
  const env = { ASSETS: assets };
  const pp = S.settlePuzzle(S.practiceSeed("abc123"));
  assert.deepEqual(await RACE_GAMES.settle.score(env, "abc123", { sites: S.parSites(E, pp).sites }), { score: 1000, round: 5 });
  assert.ok((await RACE_GAMES.settle.score(env, "abc123", { sites: [] })).error);
  assert.deepEqual(cleanRaceProgress("settle", { round: 5, score: 0 }), { round: 5, clues: 0, score: 0 });
});
