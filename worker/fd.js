// Founders daily challenge: verified submissions and the day's board (docs/MULTIPLAYER.md "Founders daily").
// The server replays the action log with web/js/games/founders/sim/daily.js and keeps the first finished game per
// player per day (like Which Metro?: no retries for the board).
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { verifyDaily } from "../web/js/games/founders/sim/daily.js";
import { fdEnv } from "./games.js";

const rank = async (env, key, score) => {
  const r = await env.DB.prepare("SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM fd_daily WHERE key = ?1").bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/fd/daily {key, log} → {score, towns, rank, total} (stored: true when a game was already in). */
export async function submitFdDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request, 256 * 1024);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's challenge is closed");
  const prev = await env.DB.prepare("SELECT score, towns FROM fd_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, towns: prev.towns, ...(await rank(env, key, prev.score)), stored: true });

  await limitWrite(env, me.id);
  const fe = await fdEnv(env);
  if (fe.degraded) throw new HttpError(503, "The daily board is not ready, try again in a minute");
  const v = verifyDaily(fe, key, body.log);
  if (!v.ok) throw new HttpError(422, v.error);
  await env.DB.prepare("INSERT OR IGNORE INTO fd_daily (player, key, score, towns, log_json, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(me.id, key, v.score, v.towns, JSON.stringify(v.log), Date.now()).run();
  const row = await env.DB.prepare("SELECT score, towns FROM fd_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, towns: row.towns, ...(await rank(env, key, row.score)) });
}

/** GET /api/fd/daily/:key?limit=20 → {key, total, top: [{rank, name, score, towns}], you} */
export async function fdDailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score, d.towns, (SELECT COUNT(*) FROM fd_daily x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
       FROM fd_daily d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM fd_daily WHERE key = ?").bind(key).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score, towns FROM fd_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { score: mine.score, towns: mine.towns, rank: (await rank(env, key, mine.score)).rank };
  }
  return json({ key, total: tot?.n | 0, top: top.results, you });
}
