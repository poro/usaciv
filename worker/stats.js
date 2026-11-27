// GET /api/account/stats: the signed-in player's record across the games (docs/MULTIPLAYER.md "Login").
import { json, requirePlayer } from "./http.js";
import { utcToday } from "./rules.js";


/** Days in a row, ending today or yesterday (UTC), among date keys. */
export function streak(keys, today) {
  const set = new Set(keys);
  let d = set.has(today) ? today : null;
  if (!d) {
    const y = new Date(`${today}T00:00:00Z`);
    y.setUTCDate(y.getUTCDate() - 1);
    d = y.toISOString().slice(0, 10);
    if (!set.has(d)) return 0;
  }
  let n = 0;
  const cur = new Date(`${d}T00:00:00Z`);
  while (set.has(cur.toISOString().slice(0, 10))) { n++; cur.setUTCDate(cur.getUTCDate() - 1); }
  return n;
}

export async function accountStats(request, env) {
  const me = await requirePlayer(env, request);
  const [wm, fd, md, pp, dl, tr, ld, rk, sh, lk, bp, st, ml] = await Promise.all([
    env.DB.prepare("SELECT key, score FROM wm_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score, towns FROM fd_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, ROUND(uplift * 10000) AS score, scenario FROM ml_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM pp_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, streak AS score FROM duel_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM trip_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM lens_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM rank_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM shapes_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM link_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM guess_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare("SELECT key, score FROM settle_daily WHERE player = ? ORDER BY key DESC LIMIT 400").bind(me.id).all(),
    env.DB.prepare(
      `SELECT r.scenario, r.uplift, r.year, r.seed,
         (SELECT COUNT(*) FROM ml_runs x WHERE x.scenario = r.scenario AND x.uplift > r.uplift) + 1 AS rank,
         (SELECT COUNT(*) FROM ml_runs x WHERE x.scenario = r.scenario) AS total
       FROM ml_runs r WHERE r.player = ? ORDER BY r.scenario`,
    ).bind(me.id).all(),
  ]);
  const today = utcToday();
  const sum = (rows) => {
    const scores = rows.map((r) => r.score);
    return {
      played: rows.length,
      best: scores.length ? Math.max(...scores) : null,
      avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      streak: streak(rows.map((r) => r.key), today),
      recent: rows.slice(0, 7),
    };
  };

  return json({ wm: sum(wm.results || []), fd: sum(fd.results || []), md: sum(md.results || []), pp: sum(pp.results || []), dl: sum(dl.results || []), tr: sum(tr.results || []), ld: sum(ld.results || []), rk: sum(rk.results || []), sh: sum(sh.results || []), lk: sum(lk.results || []), bp: sum(bp.results || []), st: sum(st.results || []), ml: ml.results || [] });
}
