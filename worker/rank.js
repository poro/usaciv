// Metro Ranking daily: the server rebuilds the day's five rounds from the date (web/js/games/rank/sim/rank.js, over the
// same cities.json) and scores the orders. First finished game per player per day.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { rankPool, rankRounds, dailySeed, scoreRank } from "../web/js/games/rank/sim/rank.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
let poolPromise = null;
export const rankPoolFor = (env) => {
  poolPromise ||= loadMany(env, ASSET_BASE, ["cities"]).then((d) => rankPool(d.cities));
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
};
const place = async (env, key, score) => {
  const r = await env.DB.prepare("SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM rank_daily WHERE key = ?1").bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/rank/daily {key, orders: [[cityId × 5] × 5]} → {score, rank, total} (stored: true on a resubmission). */
export async function submitRankDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's game is closed");
  const prev = await env.DB.prepare("SELECT score FROM rank_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, ...(await place(env, key, prev.score)), stored: true });
  await limitWrite(env, me.id);
  const r = scoreRank(rankRounds(await rankPoolFor(env), dailySeed(key)), body.orders);
  if (r.error) throw new HttpError(400, r.error);
  await env.DB.prepare("INSERT OR IGNORE INTO rank_daily (player, key, score, orders_json, created) VALUES (?, ?, ?, ?, ?)")
    .bind(me.id, key, r.score, JSON.stringify(body.orders), Date.now()).run();
  const row = await env.DB.prepare("SELECT score FROM rank_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, ...(await place(env, key, row.score)) });
}

/** GET /api/rank/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export async function rankDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score, (SELECT COUNT(*) FROM rank_daily x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
       FROM rank_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM rank_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score FROM rank_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { score: mine.score, rank: (await place(env, key, mine.score)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
