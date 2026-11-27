// Metro Duel daily: the server rebuilds the day's 30 duels from the date (web/js/games/duel/sim/duel.js, over the same
// cities.json) and counts the streak the answers earn. First finished run per player per day.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { duelPool, duelSequence, dailySeed, streakOf, DAILY_DUELS } from "../web/js/games/duel/sim/duel.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
let poolPromise = null;
const pool = (env) => {
  poolPromise ||= loadMany(env, ASSET_BASE, ["cities"]).then((d) => duelPool(d.cities));
  poolPromise.catch(() => { poolPromise = null; });
  return poolPromise;
};
const rank = async (env, key, streak) => {
  const r = await env.DB.prepare("SELECT SUM(streak > ?2) AS above, COUNT(*) AS total FROM duel_daily WHERE key = ?1").bind(key, streak).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/duel/daily {key, answers: [bool]} (a finished run: it ends on a wrong answer or after all 30) → {streak, rank, total}. */
export async function submitDuelDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's run is closed");
  const prev = await env.DB.prepare("SELECT streak FROM duel_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ streak: prev.streak, ...(await rank(env, key, prev.streak)), stored: true });
  await limitWrite(env, me.id);
  const r = streakOf(duelSequence(await pool(env), dailySeed(key), DAILY_DUELS), body.answers);
  if (r.error) throw new HttpError(400, r.error);
  if (!r.over || r.answered !== body.answers.length) throw new HttpError(422, "The run is not finished");
  await env.DB.prepare("INSERT OR IGNORE INTO duel_daily (player, key, streak, answers_json, created) VALUES (?, ?, ?, ?, ?)")
    .bind(me.id, key, r.streak, JSON.stringify(body.answers), Date.now()).run();
  const row = await env.DB.prepare("SELECT streak FROM duel_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ streak: row.streak, ...(await rank(env, key, row.streak)) });
}

/** GET /api/duel/daily/:key?limit=20 → {key, total, top: [{rank, name, streak}], you} */
export async function duelDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.streak, (SELECT COUNT(*) FROM duel_daily x WHERE x.key = d.key AND x.streak > d.streak) + 1 AS rank
       FROM duel_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.streak DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM duel_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT streak FROM duel_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { streak: mine.streak, rank: (await rank(env, key, mine.streak)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
