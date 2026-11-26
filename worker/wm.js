// Which Metro?: verified daily submissions and boards, race room create/status/socket (docs/MULTIPLAYER.md).
import { dailyAnswers, isDateKey, puzzleNumber, newPracticeSeed } from "../web/js/games/whichMetro/sim/puzzle.js";
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, playerForToken, sameOrigin, HttpError } from "./http.js";
import { wmPool } from "./data.js";
import { cleanRounds, replayRounds, keyInWindow, utcToday, histogram, isRoomCode, newRoomCode } from "./rules.js";

const rank = async (env, key, score) => {
  const r = await env.DB.prepare(
    "SELECT SUM(score > ?2) AS above, COUNT(*) AS total FROM wm_daily WHERE key = ?1",
  ).bind(key, score).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/wm/daily {key, rounds: [{steps}]} → {score, rank, total} */
export async function submitDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That puzzle is not open for submissions");

  const prev = await env.DB.prepare("SELECT score FROM wm_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ score: prev.score, ...(await rank(env, key, prev.score)), stored: true });

  await limitWrite(env, me.id);
  const c = cleanRounds(body.rounds);
  if (c.error) throw new HttpError(400, c.error);
  const answers = dailyAnswers(await wmPool(env, request), key);
  const r = replayRounds(answers, c.rounds, { complete: true });
  if (r.error) throw new HttpError(422, r.error);

  await env.DB.prepare(
    "INSERT OR IGNORE INTO wm_daily (player, key, score, rounds_json, created) VALUES (?, ?, ?, ?, ?)",
  ).bind(me.id, key, r.score, JSON.stringify(r.rounds), Date.now()).run();
  // A concurrent first submission may have won; the stored row is the truth.
  const row = await env.DB.prepare("SELECT score FROM wm_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ score: row.score, ...(await rank(env, key, row.score)) });
}

/** GET /api/wm/daily/:key?limit=20 → {key, number, total, top, you, histogram} */
export async function dailyBoard(request, env, key) {
  if (!isDateKey(key)) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, hist] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, d.score FROM wm_daily d JOIN players p ON p.id = d.player
       WHERE d.key = ? ORDER BY d.score DESC, d.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT score, COUNT(*) AS n FROM wm_daily WHERE key = ? GROUP BY score").bind(key).all(),
  ]);
  const histo = histogram(hist.results);
  const total = histo.reduce((a, n) => a + n, 0);
  // Competition ranking: 1 + number of strictly better scores.
  const above = (score) => histo.slice(score + 1).reduce((a, n) => a + n, 0);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT score FROM wm_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { rank: above(mine.score) + 1, score: mine.score };
  }
  return json({
    key, number: puzzleNumber(key), total,
    top: top.results.map((r) => ({ rank: above(r.score) + 1, name: r.name, score: r.score })),
    you, histogram: histo,
  });
}

const randomByte = () => crypto.getRandomValues(new Uint8Array(1))[0];
const random01 = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const roomStub = (env, code) => env.RACE.get(env.RACE.idFromName(code));

/** POST /api/wm/race {} → {code} */
export async function createRace(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  for (let tries = 0; tries < 5; tries++) {
    const code = newRoomCode(randomByte);
    const ok = await roomStub(env, code).init({ code, seed: newPracticeSeed(random01), host: { id: me.id, name: me.name } });
    if (ok) return json({ code });
  }
  return error(503, "Could not make a room, try again");
}

/** GET /api/wm/race/:code → {code, status, players} */
export async function raceStatus(request, env, code) {
  if (!isRoomCode(code)) return error(404, "No such room");
  const s = await roomStub(env, code).status();
  return s ? json(s) : error(404, "No such room");
}

/** GET /api/wm/race/:code/ws?token=… → WebSocket, handed to the room with the verified player in headers. */
export async function raceSocket(request, env, code) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "Expected a WebSocket upgrade");
  if (!sameOrigin(request)) return error(403, "Cross-site socket refused");
  if (!isRoomCode(code)) return error(404, "No such room");
  const me = await playerForToken(env, new URL(request.url).searchParams.get("token"));
  if (!me) return error(401, "Sign-in token missing or unknown");
  // A fresh request: nothing the client sent (other than the upgrade) reaches the room.
  const headers = new Headers({ Upgrade: "websocket", "X-Player-Id": me.id, "X-Player-Name": encodeURIComponent(me.name) });
  return roomStub(env, code).fetch(new Request(`https://room/${code}/ws`, { headers }));
}
