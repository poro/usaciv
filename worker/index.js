// usaciv Worker: answers /api/* (docs/MULTIPLAYER.md); everything else is the static site from env.ASSETS.
// wrangler.jsonc routes only /api/* here first (assets.run_worker_first), so the asset fallback below is a safety net.
import { json, error, readJson, requirePlayer, ipHash, rateLimit, limitWrite, sameOrigin, randomId, randomToken, sha256Hex, HttpError, LIMITS, VERSION } from "./http.js";
import { checkName } from "./rules.js";
import { submitDaily, dailyBoard, createRace, raceStatus, raceSocket } from "./wm.js";
import { submitRun, mlBoard } from "./ml.js";
import { createVs, vsStatus, vsSocket } from "./vs.js";

export { RaceRoom } from "./race.js";
export { VersusRoom } from "./vs.js";

async function createPlayer(request, env) {
  const ip = await ipHash(env, request);
  await rateLimit(env, `ip:${ip}`, ...LIMITS.newPlayer);
  const c = checkName((await readJson(request))?.name);
  if (c.error) throw new HttpError(400, c.error);
  const id = randomId(), token = randomToken();
  await env.DB.prepare("INSERT INTO players (id, token_hash, name, created, ip_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(token), c.name, Date.now(), ip).run();
  return json({ id, token, name: c.name }, 201);
}

async function renamePlayer(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const c = checkName((await readJson(request))?.name);
  if (c.error) throw new HttpError(400, c.error);
  await env.DB.prepare("UPDATE players SET name = ? WHERE id = ?").bind(c.name, me.id).run();
  return json({ id: me.id, name: c.name });
}

/** [method, pattern, handler(request, env, ...groups)] */
const ROUTES = [
  ["GET", /^\/api\/health$/, () => json({ ok: true, version: VERSION })],
  ["POST", /^\/api\/player$/, createPlayer],
  ["GET", /^\/api\/player$/, async (req, env) => json(await requirePlayer(env, req))],
  ["PATCH", /^\/api\/player$/, renamePlayer],
  ["POST", /^\/api\/wm\/daily$/, submitDaily],
  ["GET", /^\/api\/wm\/daily\/([0-9-]{10})$/, dailyBoard],
  ["POST", /^\/api\/wm\/race$/, createRace],
  ["GET", /^\/api\/wm\/race\/([A-Za-z0-9]{6})$/, (req, env, code) => raceStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/wm\/race\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => raceSocket(req, env, code.toUpperCase())],
  ["POST", /^\/api\/ml\/run$/, submitRun],
  ["GET", /^\/api\/ml\/board\/([a-z]{1,20})$/, mlBoard],
  ["POST", /^\/api\/ml\/vs$/, createVs],
  ["GET", /^\/api\/ml\/vs\/([A-Za-z0-9]{6})$/, (req, env, code) => vsStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/ml\/vs\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => vsSocket(req, env, code.toUpperCase())],
];

async function api(request, env) {
  const { pathname } = new URL(request.url);
  let pathMatched = false;
  for (const [method, re, handler] of ROUTES) {
    const m = re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    if (method !== "GET" && !sameOrigin(request)) return error(403, "Cross-site request refused");
    return handler(request, env, ...m.slice(1));
  }
  return pathMatched ? error(405, "Method not allowed") : error(404, "Not found");
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message, e.retry ? { "Retry-After": String(e.retry) } : undefined);
      console.error("api error", pathname, e?.stack || e);
      return error(500, "Server error");
    }
  },
};
