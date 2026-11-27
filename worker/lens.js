// Lens Detective daily: the server rebuilds the day's six rounds from lenses.json and the date
// (web/js/games/lens/sim/lens.js) and scores the picks. First finished game per player per day.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { lensPool, lensRounds, dailySeed, scoreLens } from "../web/js/games/lens/sim/lens.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
let poolPromise = null;
const pool = (env) => {
  poolPromise ||= loadMany(env, ASSET_BASE, ["lenses"]).then((d) => lensPool(d.lenses));
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
};
const rank = async (env, key, score) => {
  const r = await env.DB.prepare("SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM lens_daily WHERE key = ?1").bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/lens/daily {key, picks: [lensId × 6]} → {score, rank, total} (stored: true on a resubmission). */
export async function submitLensDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's game is closed");
  const prev = await env.DB.prepare("SELECT score FROM lens_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, ...(await rank(env, key, prev.score)), stored: true });
  await limitWrite(env, me.id);
  const r = scoreLens(lensRounds(await pool(env), dailySeed(key)), body.picks);
  if (r.error) throw new HttpError(400, r.error);
  await env.DB.prepare("INSERT OR IGNORE INTO lens_daily (player, key, score, picks_json, created) VALUES (?, ?, ?, ?, ?)")
    .bind(me.id, key, r.score, JSON.stringify(body.picks), Date.now()).run();
  const row = await env.DB.prepare("SELECT score FROM lens_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, ...(await rank(env, key, row.score)) });
}

/** GET /api/lens/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export async function lensDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score, (SELECT COUNT(*) FROM lens_daily x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
       FROM lens_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM lens_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score FROM lens_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { score: mine.score, rank: (await rank(env, key, mine.score)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
