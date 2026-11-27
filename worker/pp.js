// Pinpoint daily: the server rebuilds the day's rounds from the date (web/js/games/pinpoint/sim/rounds.js, the same
// data files the browser uses) and scores the eight guessed hexes itself. First finished game per player per day.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { buildPool, dailyRounds, scoreGame } from "../web/js/games/pinpoint/sim/rounds.js";
import { makeHexMap } from "../web/js/games/shared/hexmap.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
let poolPromise = null; // {grid, pool}, once per isolate
function ppPool(env) {
  poolPromise ||= loadMany(env, ASSET_BASE, ["world", "cities", "resources", "wonders", "infrastructure"]).then((d) => {
    const grid = makeHexMap(d.world).grid;
    return { grid, pool: buildPool(d, grid) };
  });
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
}

const rank = async (env, key, score) => {
  const r = await env.DB.prepare("SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM pp_daily WHERE key = ?1").bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/pp/daily {key, guesses: [cell × 8]} → {score, rank, total} (stored: true on a resubmission). */
export async function submitPpDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's game is closed");
  const prev = await env.DB.prepare("SELECT score FROM pp_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, ...(await rank(env, key, prev.score)), stored: true });
  await limitWrite(env, me.id);
  const { grid, pool } = await ppPool(env);
  const r = scoreGame(grid, dailyRounds(pool, key), body.guesses);
  if (r.error) throw new HttpError(400, r.error);
  await env.DB.prepare("INSERT OR IGNORE INTO pp_daily (player, key, score, guesses_json, created) VALUES (?, ?, ?, ?, ?)")
    .bind(me.id, key, r.total, JSON.stringify(body.guesses), Date.now()).run();
  const row = await env.DB.prepare("SELECT score FROM pp_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, ...(await rank(env, key, row.score)) });
}

/** GET /api/pp/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export async function ppDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score, (SELECT COUNT(*) FROM pp_daily x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
       FROM pp_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM pp_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score FROM pp_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { score: mine.score, rank: (await rank(env, key, mine.score)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
