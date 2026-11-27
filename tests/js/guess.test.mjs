// Ballpark (web/js/games/guess/sim/guess.js), the Worker's /api/guess/daily and its race scorer. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as G from "../../web/js/games/guess/sim/guess.js";
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
const pool = G.guessPool(JSON.parse(readFileSync(dataUrl("cities"))));
const assets = { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) };

test("questions: deterministic, two distances, four different statistics, no metro twice, answers in range", () => {
  const a = G.guessRounds(pool, G.dailySeed("2026-11-27"));
  assert.deepEqual(G.guessRounds(pool, G.dailySeed("2026-11-27")), a);
  for (let k = 0; k < 100; k++) {
    const rs = G.guessRounds(pool, `t${k}`);
    assert.deepEqual(rs.map((q, i) => (q.kind === "km" ? i : -1)).filter((i) => i >= 0), G.KM_ROUNDS);
    const stats = rs.filter((q) => q.kind === "stat").map((q) => q.stat);
    assert.equal(new Set(stats).size, stats.length);
    const ids = rs.flatMap((q) => (q.kind === "km" ? [q.a, q.b] : [q.city]));
    assert.equal(new Set(ids).size, ids.length);
    for (const q of rs) {
      const [lo, hi] = G.rangeFor(pool, q);
      assert.ok(q.answer >= lo && q.answer <= hi, `${q.kind} ${q.stat} ${q.answer}`);
      if (q.kind === "km") assert.ok(q.answer >= G.KM_PAIR[0] && q.answer <= G.KM_PAIR[1]);
    }
  }
});

test("points: exact 100, symmetric ratios, 0 at the tolerance, growth by points", () => {
  const q = { kind: "stat", stat: "median_income", answer: 80000 };
  assert.equal(G.points(q, 80000), 100);
  assert.equal(G.points(q, 88000), G.points(q, 80000 / 1.1));
  assert.equal(G.points(q, 80000 * G.TOL.median_income), 0);
  assert.equal(G.points(q, 1e9), 0);
  assert.equal(G.points({ kind: "km", answer: 1000 }, 1100), 86);
  const gq = { kind: "stat", stat: "growth", answer: 0.02 };
  assert.equal(G.points(gq, 0.02), 100);
  assert.equal(G.points(gq, 0.05), 50);
  assert.equal(G.points(gq, -0.05), 0);
  const rs = G.guessRounds(pool, "x");
  assert.equal(G.scoreGuesses(pool, rs, rs.map((r) => r.answer)).score, 600);
  assert.ok(G.scoreGuesses(pool, rs, rs.map(() => 1e12)).error, "out of range");
  assert.ok(G.scoreGuesses(pool, rs, rs.slice(0, 2).map((r) => r.answer)).error);
  assert.equal(G.scoreGuesses(pool, rs, rs.slice(0, 2).map((r) => r.answer), { partial: true }).score, 200);
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
  const day = G.guessRounds(pool, G.dailySeed(key));
  const guesses = day.map((q, i) => (i === 0 ? (q.kind === "stat" && q.stat === "growth" ? q.answer + 0.03 : q.answer * 1.1) : q.answer));
  const want = G.scoreGuesses(pool, day, guesses).score;
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  assert.deepEqual((await call("POST", "/api/guess/daily", { key, guesses }, ann.token)).data, { score: want, rank: 1, total: 1 });
  assert.equal((await call("POST", "/api/guess/daily", { key, guesses: day.map((q) => q.answer) }, ann.token)).data.stored, true);
  assert.equal((await call("GET", `/api/guess/daily/${key}`)).data.top[0].score, want);
  assert.deepEqual((await call("GET", "/api/today", undefined, ann.token)).data.games.guess.you, { value: want, rank: 1 });
  assert.equal((await call("GET", "/api/account/stats", undefined, ann.token)).data.bp.best, want);

  const env = { ASSETS: assets };
  const prs = G.guessRounds(pool, G.practiceSeed("abc123"));
  assert.deepEqual(await RACE_GAMES.guess.score(env, "abc123", { guesses: prs.slice(0, 3).map((q) => q.answer) }), { score: 300, round: 3 });
  assert.ok((await RACE_GAMES.guess.score(env, "abc123", { guesses: ["x"] })).error);
  assert.deepEqual(cleanRaceProgress("guess", { round: 6, score: 600 }), { round: 6, clues: 0, score: 600 });
  assert.equal(cleanRaceProgress("guess", { round: 6, score: 601 }), null);
});
