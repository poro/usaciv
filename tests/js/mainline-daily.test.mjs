// Mainline daily challenge: sim/daily.js, verifyRun({daily}) and the Worker's /api/ml/daily. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { verifyRun, REQUIRED_DATA } from "../../web/js/games/mainline/sim/verify.js";
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
const data = Object.fromEntries(REQUIRED_DATA.map((n) => [n, JSON.parse(readFileSync(dataUrl(n)))]));

function botDaily(key) {
  const d = S.mlDaily(key);
  const e = S.makeEnv(data, d.scenario);
  let s = S.newDailyGame(e, d);
  const log = [];
  while (!s.over) s = S.greedyTurn(e, s, { log });
  return { d, e, s, log };
}

test("the day decides scenario and seed; three scenarios rotate; 10 years", () => {
  const a = S.mlDaily("2026-11-27"), b = S.mlDaily("2026-11-28"), c = S.mlDaily("2026-11-29"), a2 = S.mlDaily("2026-11-27");
  assert.deepEqual(a, a2);
  assert.deepEqual(new Set([a.scenario, b.scenario, c.scenario]), new Set(S.ML_DAILY_SCENARIOS));
  assert.equal(a.years, 10);
  assert.ok(a.seed >= 1 && a.seed <= 99999);
  assert.equal(S.mlDaily("2026-13-01"), null);
  assert.equal(S.mlDaily("nope"), null);
});

test("a daily game ends after 2035 and verifies only as that day's run", () => {
  const { d, e, s, log } = botDaily("2026-11-27");
  assert.equal(s.year, 2036);
  assert.equal(s.hist.length, 10);
  const v = verifyRun(data, { scenario: d.scenario, seed: d.seed, log: JSON.parse(JSON.stringify(log)), daily: d.key });
  assert.equal(v.ok, true, v.error);
  assert.equal(v.hash, S.stateHash(s));
  assert.equal(v.uplift, S.summary(e, s).uplift);
  assert.match(verifyRun(data, { scenario: d.scenario, seed: d.seed + 1, log, daily: d.key }).error, /Not that day/);
  assert.equal(verifyRun(data, { scenario: d.scenario, seed: d.seed, log }).ok, false, "as a free 25-year game it is unfinished");
});

test("Worker: first daily run counts, board, stats, merge", async () => {
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
  const { d, e, s, log } = botDaily(key);
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  assert.equal((await call("POST", "/api/ml/daily", { key: "2020-01-01", log }, ann.token)).status, 400);
  assert.equal((await call("POST", "/api/ml/daily", { key, log: log.slice(0, 5) }, ann.token)).status, 422);
  const r = await call("POST", "/api/ml/daily", { key, log }, ann.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.uplift, S.summary(e, s).uplift);
  assert.equal(r.data.rank, 1);
  assert.equal(r.data.scenario, d.scenario);
  assert.equal((await call("POST", "/api/ml/daily", { key, log }, ann.token)).data.stored, true);
  const b = (await call("GET", `/api/ml/daily/${key}`, undefined, ann.token)).data;
  assert.equal(b.total, 1);
  assert.equal(b.top[0].name, "Ann");
  assert.equal(b.you.rank, 1);
  assert.equal(b.scenario, d.scenario);
  const st = (await call("GET", "/api/account/stats", undefined, ann.token)).data;
  assert.equal(st.md.played, 1);
  assert.equal(st.md.best, Math.round(r.data.uplift * 10000));
  // an anonymous device's daily run moves into the account it signs in to
  const guest = (await call("POST", "/api/player", { name: "Guest" })).data;
  const bob = (await call("POST", "/api/player", { name: "Bob" })).data;
  await call("POST", "/api/ml/daily", { key, log }, guest.token);
  const code = (await call("POST", "/api/auth/link", {}, bob.token)).data.code;
  const m = (await call("POST", "/api/auth/link/redeem", { code }, guest.token)).data;
  assert.deepEqual(m.merged, { daily: 0, runs: 0 }, "today's daily run stays behind (the day is still open)");
  assert.equal((await call("GET", `/api/ml/daily/${key}`)).data.top.map((x) => x.name).join(), "Ann");
});
