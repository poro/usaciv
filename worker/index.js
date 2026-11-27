// usaciv Worker: answers /api/* (docs/MULTIPLAYER.md); everything else is the static site from env.ASSETS.
// wrangler.jsonc routes only /api/* here first (assets.run_worker_first), so the asset fallback below is a safety net.
import { json, error, readJson, requirePlayer, ipHash, rateLimit, limitWrite, sameOrigin, randomId, randomToken, sha256Hex, HttpError, LIMITS, VERSION } from "./http.js";
import { checkName } from "./rules.js";
import { submitDaily, dailyBoard, createRace, createGameRace, raceStatus, raceSocket } from "./wm.js";
import { submitRun, mlBoard, submitMlDaily, mlDailyBoard } from "./ml.js";
import { createVs, createFd, vsStatus, vsSocket } from "./vs.js";
import * as auth from "./auth.js";
import { submitFdDaily, fdDailyBoard } from "./fd.js";
import { accountStats } from "./stats.js";
import { submitPpDaily, ppDailyBoard } from "./pp.js";
import { submitDuelDaily, duelDailyBoard } from "./duel.js";
import { today } from "./today.js";
import { submitTripDaily, tripDailyBoard } from "./trip.js";

export { RaceRoom } from "./race.js";
export { VersusRoom } from "./vs.js"; // Mainline versus and Founders multiplayer rooms

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
  ["GET", /^\/api\/today$/, today],
  ["POST", /^\/api\/player$/, createPlayer],
  ["GET", /^\/api\/player$/, async (req, env) => { const p = await requirePlayer(env, req); return json({ id: p.id, name: p.name }); }],
  ["PATCH", /^\/api\/player$/, renamePlayer],
  // Login (worker/auth.js)
  ["GET", /^\/api\/auth\/config$/, auth.authConfig],
  ["GET", /^\/api\/account$/, auth.account],
  ["GET", /^\/api\/account\/stats$/, accountStats],
  ["DELETE", /^\/api\/account$/, auth.deleteAccount],
  ["POST", /^\/api\/auth\/signout$/, auth.signOut],
  ["POST", /^\/api\/auth\/signout-others$/, auth.signOutOthers],
  ["POST", /^\/api\/auth\/passkey\/register\/options$/, auth.passkeyRegisterOptions],
  ["POST", /^\/api\/auth\/passkey\/register$/, auth.passkeyRegister],
  ["POST", /^\/api\/auth\/passkey\/login\/options$/, auth.passkeyLoginOptions],
  ["POST", /^\/api\/auth\/passkey\/login$/, auth.passkeyLogin],
  ["PATCH", /^\/api\/auth\/passkey\/([A-Za-z0-9_-]{16,1400})$/, auth.passkeyRename],
  ["DELETE", /^\/api\/auth\/passkey\/([A-Za-z0-9_-]{16,1400})$/, auth.passkeyDelete],
  ["POST", /^\/api\/auth\/link$/, auth.linkCreate],
  ["POST", /^\/api\/auth\/link\/redeem$/, auth.linkRedeem],
  ["POST", /^\/api\/auth\/google\/start$/, auth.googleStart],
  ["GET", /^\/api\/auth\/google\/callback$/, auth.googleCallback],
  ["POST", /^\/api\/auth\/handoff$/, auth.handoff],
  ["DELETE", /^\/api\/auth\/identity\/(google|apple)$/, auth.identityDelete],
  ["POST", /^\/api\/wm\/daily$/, submitDaily],
  ["GET", /^\/api\/wm\/daily\/([0-9-]{10})$/, dailyBoard],
  ["POST", /^\/api\/wm\/race$/, createRace],
  ["POST", /^\/api\/race$/, createGameRace],
  ["GET", /^\/api\/race\/([A-Za-z0-9]{6})$/, (req, env, code) => raceStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/race\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => raceSocket(req, env, code.toUpperCase())],
  ["GET", /^\/api\/wm\/race\/([A-Za-z0-9]{6})$/, (req, env, code) => raceStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/wm\/race\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => raceSocket(req, env, code.toUpperCase())],
  ["POST", /^\/api\/ml\/run$/, submitRun],
  ["GET", /^\/api\/ml\/board\/([a-z]{1,20})$/, mlBoard],
  ["POST", /^\/api\/ml\/daily$/, submitMlDaily],
  ["GET", /^\/api\/ml\/daily\/([0-9-]{10})$/, mlDailyBoard],
  ["POST", /^\/api\/ml\/vs$/, createVs],
  ["GET", /^\/api\/ml\/vs\/([A-Za-z0-9]{6})$/, (req, env, code) => vsStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/ml\/vs\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => vsSocket(req, env, code.toUpperCase(), "mainline")],
  ["POST", /^\/api\/trip\/daily$/, submitTripDaily],
  ["GET", /^\/api\/trip\/daily\/([0-9-]{10})$/, tripDailyBoard],
  ["POST", /^\/api\/duel\/daily$/, submitDuelDaily],
  ["GET", /^\/api\/duel\/daily\/([0-9-]{10})$/, duelDailyBoard],
  ["POST", /^\/api\/pp\/daily$/, submitPpDaily],
  ["GET", /^\/api\/pp\/daily\/([0-9-]{10})$/, ppDailyBoard],
  ["POST", /^\/api\/fd\/daily$/, submitFdDaily],
  ["GET", /^\/api\/fd\/daily\/([0-9-]{10})$/, fdDailyBoard],
  ["POST", /^\/api\/fd\/match$/, createFd],
  ["GET", /^\/api\/fd\/match\/([A-Za-z0-9]{6})$/, (req, env, code) => vsStatus(req, env, code.toUpperCase())],
  ["GET", /^\/api\/fd\/match\/([A-Za-z0-9]{6})\/ws$/, (req, env, code) => vsSocket(req, env, code.toUpperCase(), "founders")],
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
