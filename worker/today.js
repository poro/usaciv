// GET /api/today?local=YYYY-MM-DD: every daily board at a glance, for the Play menu. For each game: how many players
// posted today and, when signed in, your score and rank. Which Metro? keys its daily by the player's local date (the
// `local` query); the other dailies follow the UTC date.
import { json, optionalPlayer } from "./http.js";
import { utcToday, keyInWindow } from "./rules.js";

// game id → [table, score column, higher is better]
const BOARDS = {
  whichMetro: ["wm_daily", "score"],
  pinpoint: ["pp_daily", "score"],
  duel: ["duel_daily", "streak"],
  trip: ["trip_daily", "score"],
  lens: ["lens_daily", "score"],
  rank: ["rank_daily", "score"],
  shapes: ["shapes_daily", "score"],
  link: ["link_daily", "score"],
  founders: ["fd_daily", "score"],
  mainline: ["ml_daily", "uplift"],
};

export async function today(request, env) {
  const utc = utcToday();
  const q = new URL(request.url).searchParams.get("local");
  const local = keyInWindow(q, utc) ? q : utc;
  const me = await optionalPlayer(env, request);
  const games = {};
  await Promise.all(Object.entries(BOARDS).map(async ([id, [table, col]]) => {
    const key = id === "whichMetro" ? local : utc;
    const tot = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`).bind(key).first();
    const g = { key, total: tot?.n | 0, you: null };
    if (me) {
      const mine = await env.DB.prepare(`SELECT ${col} AS v FROM ${table} WHERE player = ? AND key = ?`).bind(me.id, key).first();
      if (mine) {
        const above = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key = ? AND ${col} > ?`).bind(key, mine.v).first();
        g.you = { value: mine.v, rank: (above?.n | 0) + 1 };
      }
    }
    games[id] = g;
  }));
  return json({ utc, local, games });
}
