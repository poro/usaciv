// Founders daily challenge: sim/daily.js (seed, turns, log cleaning, replay, verify) and the Worker's
// /api/fd/daily endpoints with node:sqlite as D1 and the real data files as assets. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as S from "../../web/js/games/founders/sim/index.js";
import * as Dl from "../../web/js/games/founders/sim/daily.js";
import { botTurn } from "../../web/js/games/founders/sim/advice.js";
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
const world = D("world");
const env = S.makeEnv({ world, resources: D("resources"), hazards: S.buildHazards(D("disasters"), world) });

function botGame(key) {
  let s = Dl.newDaily(env, key);
  const log = [];
  while (s.phase !== "over") s = botTurn(env, s, { log });
  return { s, log };
}

test("daily games: same seed and starts for everyone, 30 turns", () => {
  const a = Dl.newDaily(env, "2026-11-26"), b = Dl.newDaily(env, "2026-11-26"), c = Dl.newDaily(env, "2026-11-27");
  assert.equal(a.seed, "daily-2026-11-26");
  assert.equal(a.maxTurns, Dl.DAILY_TURNS);
  assert.deepEqual(a.starts, b.starts);
  assert.notDeepEqual(a.starts.map((x) => x.cell), c.starts.map((x) => x.cell));
  assert.equal(Dl.dailyKeyOf("daily-2026-11-26"), "2026-11-26");
  assert.equal(Dl.dailyKeyOf("abc123"), null);
});

test("cleanDailyLog bounds-checks actions", () => {
  assert.ok(Dl.cleanDailyLog([]).error);
  assert.ok(Dl.cleanDailyLog("x").error);
  assert.ok(Dl.cleanDailyLog([{ type: "boom" }]).error);
  assert.ok(Dl.cleanDailyLog([{ type: "move", party: -1, to: 3 }]).error);
  assert.ok(Dl.cleanDailyLog([{ type: "move", party: 1.5, to: 3 }]).error);
  assert.ok(Dl.cleanDailyLog([{ type: "focus", town: 1, focus: "x".repeat(21) }]).error);
  assert.ok(Dl.cleanDailyLog(new Array(Dl.DAILY_MAX_ACTIONS + 1).fill({ type: "end" })).error);
  assert.deepEqual(Dl.cleanDailyLog([{ type: "auto", town: "all", on: true, junk: 1 }]).log, [{ type: "auto", town: "all", on: true }]);
});

test("verifyDaily: a finished bot game verifies to its own score; tampering and unfinished games are refused", () => {
  const { s, log } = botGame("2026-11-26");
  const v = Dl.verifyDaily(env, "2026-11-26", JSON.parse(JSON.stringify(log)));
  assert.equal(v.ok, true, v.error);
  assert.equal(v.score, S.prosperity(env, s).score);
  assert.equal(v.towns, s.towns.length);
  assert.equal(Dl.verifyDaily(env, "2026-11-27", log).ok, false, "another day's map does not replay the same way");
  assert.match(Dl.verifyDaily(env, "2026-11-26", log.slice(0, -1)).error, /not finished/);
  const i = log.findIndex((a) => a.type === "found");
  const bad = log.map((a, k) => (k === i ? { ...a, party: 999 } : a));
  assert.match(Dl.verifyDaily(env, "2026-11-26", bad).error, /did not replay/);
});

test("Worker: submit a daily, first game counts, board ranks, merge on sign-in carries it", async () => {
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
  const ann = (await call("POST", "/api/player", { name: "Ann" })).data;
  const bob = (await call("POST", "/api/player", { name: "Bob" })).data;
  const { s, log } = botGame(key);
  const score = S.prosperity(env, s).score;

  assert.equal((await call("POST", "/api/fd/daily", { key: "2020-01-01", log }, ann.token)).status, 400, "closed day");
  assert.equal((await call("POST", "/api/fd/daily", { key, log: log.slice(0, 10) }, ann.token)).status, 422);
  const r = await call("POST", "/api/fd/daily", { key, log }, ann.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { score, towns: s.towns.length, rank: 1, total: 1 });
  // Bob's game is shorter: his first 10 turns, then he just ends turns.
  let b = Dl.newDaily(env, key);
  const blog = [];
  while (b.phase !== "over") {
    if (b.turn <= 10) b = botTurn(env, b, { log: blog });
    else { const x = S.apply(env, b, { type: "end" }); b = x.state; blog.push({ type: "end" }); }
  }
  const rb = await call("POST", "/api/fd/daily", { key, log: blog }, bob.token);
  assert.equal(rb.data.rank, score > S.prosperity(env, b).score ? 2 : 1);
  // A resubmission returns the stored game.
  assert.equal((await call("POST", "/api/fd/daily", { key, log: blog }, ann.token)).data.stored, true);
  const board = (await call("GET", `/api/fd/daily/${key}`, undefined, bob.token)).data;
  assert.equal(board.total, 2);
  assert.deepEqual(board.top.map((x) => x.name), score >= S.prosperity(env, b).score ? ["Ann", "Bob"] : ["Bob", "Ann"]);
  assert.equal(board.you.score, S.prosperity(env, b).score);
  // Bob links to Ann's account from his device: his daily moves only if Ann has none (she has one: hers wins).
  const code = (await call("POST", "/api/auth/link", {}, ann.token)).data.code;
  const m = (await call("POST", "/api/auth/link/redeem", { code }, bob.token)).data;
  assert.deepEqual(m.merged, { daily: 0, runs: 0 }, "today's daily is still open: it does not move (no retries on throwaway players)");
  const after = (await call("GET", `/api/fd/daily/${key}`)).data;
  assert.equal(after.total, 1);
  assert.equal(after.top[0].score, score);
});
