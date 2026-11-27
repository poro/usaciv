// A verified daily board for a short game, from two pieces: how to rebuild the day's puzzle and how to score a
// submission. Used by the newer dailies (Metro Ranking, State Shapes); each has a table
//   <table> (player, key, score, <detail> TEXT, created, UNIQUE (player, key))
// The first finished game per player per day counts; a resubmission returns the stored score with stored: true.
//
//   const d = makeDaily({ table, detail, data: ["cities"], build(data) → pool, puzzle(pool, key), score(puzzle, body) → {score} | {error}, detailOf(body) })
//   d.submit(request, env)        POST  {key, …} → {score, rank, total}
//   d.board(request, env, key)    GET   ?limit= → {key, total, top: [{rank, name, score}], you}
//   d.pool(env)                   the built pool (cached per isolate), for race scorers
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { keyInWindow, utcToday } from "./rules.js";
import { isDateKey } from "../web/js/games/whichMetro/sim/puzzle.js";
import { loadMany } from "./data.js";

const ASSET_BASE = { url: "https://usaciv.internal/" };
const TABLE = /^[a-z_]+$/;

export function makeDaily({ table, detail, data, build, puzzle, score, detailOf = (body) => body }) {
  if (!TABLE.test(table) || !TABLE.test(detail)) throw new Error("makeDaily: bad table or column name");
  let poolPromise = null;
  const pool = (env) => {
    poolPromise ||= loadMany(env, ASSET_BASE, data).then(build);
    poolPromise.catch(() => { poolPromise = null; });
    return poolPromise;
  };
  const place = async (env, key, s) => {
    const r = await env.DB.prepare(`SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM ${table} WHERE key = ?1`).bind(key, s).first();
    return { rank: (r.above | 0) + 1, total: r.total | 0 };
  };
  const mine = (env, id, key) => env.DB.prepare(`SELECT score FROM ${table} WHERE player = ? AND key = ?`).bind(id, key).first();

  async function submit(request, env) {
    const me = await requirePlayer(env, request);
    const body = await readJson(request);
    const key = body?.key;
    if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's game is closed");
    const prev = await mine(env, me.id, key);
    if (prev) return json({ score: prev.score, ...(await place(env, key, prev.score)), stored: true });
    await limitWrite(env, me.id);
    const r = score(puzzle(await pool(env), key), body);
    if (r.error) throw new HttpError(400, r.error);
    await env.DB.prepare(`INSERT OR IGNORE INTO ${table} (player, key, score, ${detail}, created) VALUES (?, ?, ?, ?, ?)`)
      .bind(me.id, key, r.score, JSON.stringify(detailOf(body)), Date.now()).run();
    const row = await mine(env, me.id, key);
    return json({ score: row.score, ...(await place(env, key, row.score)) });
  }

  async function board(request, env, key) {
    if (!isDateKey(key)) return error(400, "Bad date key");
    const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
    const [me, top, tot] = await Promise.all([
      optionalPlayer(env, request),
      env.DB.prepare(
        `SELECT p.name, d.score, (SELECT COUNT(*) FROM ${table} x WHERE x.key = d.key AND x.score > d.score) + 1 AS rank
         FROM ${table} d JOIN players p ON p.id = d.player WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
      ).bind(key, limit).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`).bind(key).first(),
    ]);
    let you = null;
    if (me) {
      const m = await mine(env, me.id, key);
      if (m) you = { score: m.score, rank: (await place(env, key, m.score)).rank };
    }
    return json({ key, total: tot?.n | 0, top: top.results, you });
  }

  return { submit, board, pool };
}
