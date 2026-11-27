// Road Trip daily: the server rebuilds the day's trip from the date (web/js/games/trip/sim/trip.js over cities.json)
// and scores the order itself. First finished route per player per day.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { tripPool, tripFor, dailySeed, scoreTrip } from "../web/js/games/trip/sim/trip.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
let poolPromise = null;
export const tripPoolFor = (env) => pool(env);
const pool = (env) => {
  poolPromise ||= loadMany(env, ASSET_BASE, ["cities"]).then((d) => tripPool(d.cities));
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
};
const rank = async (env, key, score) => {
  const r = await env.DB.prepare("SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM trip_daily WHERE key = ?1").bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/trip/daily {key, order: [six metro ids]} → {score, km, best, rank, total} (stored: true on a resubmission). */
export async function submitTripDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's trip is closed");
  const prev = await env.DB.prepare("SELECT score, km FROM trip_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, km: prev.km, ...(await rank(env, key, prev.score)), stored: true });
  await limitWrite(env, me.id);
  const r = scoreTrip(tripFor(await pool(env), dailySeed(key)), body.order);
  if (r.error) throw new HttpError(400, r.error);
  await env.DB.prepare("INSERT OR IGNORE INTO trip_daily (player, key, score, km, order_json, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(me.id, key, r.points, r.km, JSON.stringify(body.order), Date.now()).run();
  const row = await env.DB.prepare("SELECT score, km FROM trip_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, km: row.km, best: r.best, ...(await rank(env, key, row.score)) });
}

/** GET /api/trip/daily/:key?limit=20 → {key, total, top: [{rank, name, score, km}], you} */
export async function tripDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score, d.km, (SELECT COUNT(*) FROM trip_daily x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
       FROM trip_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM trip_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score, km FROM trip_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { score: mine.score, km: mine.km, rank: (await rank(env, key, mine.score)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
