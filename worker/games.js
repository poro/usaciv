// Per-game adapters for VersusRoom (worker/vs.js): everything that differs between the games a room can host.
// docs/MULTIPLAYER.md, "Mainline versus (real time)" and "Founders multiplayer (real time)".
//
// The room itself (seats, ready/deadline, the entry log, sockets, alarms) is game-agnostic; it reaches the rules
// only through one of these objects, picked by room.game ("mainline" when a stored room has no `game`).
//
//   adapter = {
//     id                         "mainline" | "founders" (room.game)
//     title                      the game's name in messages
//     max                        most seats in all (people + AI)
//     botNames                   AI seat names, in seat order after the people
//     unit, units                "company"/"companies", "nation"/"nations" (refusal messages)
//     periodKey                  the room field that counts resolves: "year" | "turn"
//     firstPeriod                its value at the start (START_YEAR | 1)
//     cleanBody(b)               POST body → {…game fields stored in the room} | {error}
//     async checkBody(env, b)    extra checks that need data (→ error string | null); env = the Worker env
//     newSeed(u32)               the replay seed from a random uint32
//     resolvesLeft(room)         resolves still to come, the current one included (entry-cap reserve)
//     init(room)                 the replay init (newVersus / newMatch options)
//     env(workerEnv, room)       → Promise<sim env>, cached per isolate
//     shapeError(env, a)         why an incoming action is malformed, or null (before the rules see it)
//     act(env, g, p, a)          → {g, error}   seat p applies a; g unchanged on an error
//     botActions(env, g, p)      → [action]     AI seat p's actions for this period
//     applyEntry(env, g, e)      → {g, error}   one log entry ({p, a} or {r: 1})
//     replay(env, init, es)      → {g, error, at}
//     period(g)                  g's current year / turn
//     over(g)                    whether the game has ended
//     fields(room)               the game's own settings in the room view and GET …/:code (after `status`)
//   }
import * as ML from "../web/js/games/mainline/sim/versus.js";
import { shapeError as mlShapeError, REQUIRED_DATA } from "../web/js/games/mainline/sim/verify.js";
import { makeEnv as mlMakeEnv } from "../web/js/games/mainline/sim/env.js";
import { scenarioById, START_YEAR } from "../web/js/games/mainline/sim/scenarios.js";
import * as FD from "../web/js/games/founders/sim/match.js";
import { makeEnv as fdMakeEnv } from "../web/js/games/founders/sim/state.js";
import { buildHazards } from "../web/js/games/founders/sim/events.js";
import { loadMany, loadData } from "./data.js";

// loadMany() wants a request for the asset URL; any origin works for the ASSETS binding.
const ASSET_BASE = { url: "https://usaciv.internal/" };

/** A game seed from a random uint32: 1..2^31-1. */
export const newSeed = (u32) => 1 + (u32 % 0x7ffffffe);

const isObject = (b) => !!b && typeof b === "object" && !Array.isArray(b);
const botsError = (b, max) => (!Number.isInteger(b.bots) || b.bots < 0 || b.bots > max - 1 ? `bots must be 0–${max - 1}` : null);

// --- Mainline versus -------------------------------------------------------------------------------------------

/** Shape check of POST /api/ml/vs → {scenario, home, years, bots} or {error}. Sandbox homes are checked later. */
export function cleanVsBody(b) {
  if (!isObject(b)) return { error: "body must be an object" };
  const sc = typeof b.scenario === "string" ? scenarioById(b.scenario) : null;
  if (!sc) return { error: "unknown scenario" };
  let home = null;
  if (sc.home) {
    if (b.home != null && b.home !== sc.home) return { error: "this scenario has a fixed home" };
  } else {
    if (typeof b.home !== "string" || !/^\d{5}$/.test(b.home)) return { error: "sandbox games need a 5-digit home" };
    home = b.home;
  }
  if (!ML.VS_YEARS.includes(b.years)) return { error: `years must be ${ML.VS_YEARS.join(" or ")}` };
  const be = botsError(b, ML.VS_MAX);
  if (be) return { error: be };
  return { scenario: sc.id, home, years: b.years, bots: b.bots };
}

const mlEnvCache = new Map(); // "scenario:home" → Promise<env>, most recently used last
const ML_ENV_CACHE_MAX = 6;

/** makeEnv(data, scenario, {home}) with the REQUIRED_DATA files from env.ASSETS, cached. */
export function vsEnv(env, scenario, home) {
  const key = `${scenario}:${home ?? ""}`;
  let p = mlEnvCache.get(key);
  if (p) {
    mlEnvCache.delete(key);
  } else {
    p = loadMany(env, ASSET_BASE, REQUIRED_DATA).then((data) => mlMakeEnv(data, scenario, { home }));
    p.catch(() => mlEnvCache.delete(key));
  }
  mlEnvCache.set(key, p);
  while (mlEnvCache.size > ML_ENV_CACHE_MAX) mlEnvCache.delete(mlEnvCache.keys().next().value);
  return p;
}

export const mainline = {
  id: "mainline",
  title: "Mainline versus",
  max: ML.VS_MAX,
  botNames: ML.BOT_NAMES,
  unit: "company",
  units: "companies",
  periodKey: "year",
  firstPeriod: START_YEAR,
  cleanBody: cleanVsBody,
  async checkBody(env, b) {
    if (!b.home) return null;
    let e = null;
    try { e = await vsEnv(env, b.scenario, b.home); } catch { /* below */ }
    if (e?.home?.id === b.home) return null;
    mlEnvCache.delete(`${b.scenario}:${b.home}`);
    return "Unknown home metro";
  },
  newSeed,
  resolvesLeft: (room) => Math.max(0, START_YEAR + room.years - room.year),
  init: (room) => ({ seed: room.seed, years: room.years, players: room.players.map(({ name, bot }) => ({ name, bot })) }),
  env: (env, room) => vsEnv(env, room.scenario, room.home),
  shapeError: (env, a) => mlShapeError(a, env.hexmap.size),
  act: (env, g, p, a) => { const r = ML.vsAct(env, g, p, a); return { g: r.vs, error: r.error }; },
  botActions: ML.botActions,
  applyEntry: (env, g, e) => { const r = ML.applyEntry(env, g, e); return { g: r.vs, error: r.error }; },
  replay: (env, init, es) => { const r = ML.replay(env, init, es); return { g: r.vs, error: r.error, at: r.at }; },
  period: (g) => g.year,
  over: (g) => !!g.over,
  fields: (room) => ({ scenario: room.scenario, home: room.home, years: room.years }),
};

// --- Founders multiplayer --------------------------------------------------------------------------------------

/**
 * Shape check of POST /api/fd/match → {turns, bots, map} or {error}. map is optional: a body without it (a client from
 * before "near" starts) gets "far", the layout that client will replay.
 */
export function cleanFdBody(b) {
  if (!isObject(b)) return { error: "body must be an object" };
  if (!FD.MATCH_TURNS.includes(b.turns)) return { error: `turns must be ${FD.MATCH_TURNS.join(" or ")}` };
  const be = botsError(b, FD.MATCH_MAX);
  if (be) return { error: be };
  if (b.map !== undefined && !FD.MATCH_MAPS.includes(b.map)) return { error: `map must be ${FD.MATCH_MAPS.join(" or ")}` };
  return { turns: b.turns, bots: b.bots, map: b.map ?? "far" };
}
/** A room's start layout (rooms made before the choice existed are "far"). */
const fdMap = (room) => (room.map === "near" ? "near" : "far");

let fdEnvPromise = null; // one Founders env per isolate serves every room

/**
 * The Founders env exactly as the browser builds it (web/js/games/founders/index.js):
 * makeEnv({world, resources, hazards: buildHazards(disasters, world)}). Like the browser, a disasters file that
 * fails to load gives buildHazards(null, world). That degraded env is not cached, so the next call tries again.
 */
export function fdEnv(env) {
  if (fdEnvPromise) return fdEnvPromise;
  let full = true;
  const p = Promise.all([
    loadMany(env, ASSET_BASE, ["world", "resources"]),
    loadData(env, ASSET_BASE, "disasters").catch((e) => {
      full = false;
      console.error("founders env: disasters.json did not load; hazards fall back to terrain", e?.message || e);
      return null;
    }),
  ]).then(([{ world, resources }, disasters]) => {
    const e = fdMakeEnv({ world, resources, hazards: buildHazards(disasters, world) });
    if (!full && fdEnvPromise === p) fdEnvPromise = null;
    return e;
  });
  p.catch(() => { if (fdEnvPromise === p) fdEnvPromise = null; });
  fdEnvPromise = p;
  return p;
}

export const founders = {
  id: "founders",
  title: "Founders",
  max: FD.MATCH_MAX,
  botNames: FD.BOT_NATIONS,
  unit: "nation",
  units: "nations",
  periodKey: "turn",
  firstPeriod: 1,
  cleanBody: cleanFdBody,
  checkBody: async () => null,
  newSeed: (u32) => String(newSeed(u32)),
  resolvesLeft: (room) => Math.max(0, room.turns + 1 - room.turn),
  init: (room) => ({ seed: room.seed, turns: room.turns, map: fdMap(room), players: room.players.map(({ name, bot }) => ({ name, bot })) }),
  env: (env) => fdEnv(env),
  shapeError: (env, a) => FD.matchShapeError(a, env.T.size),
  act: (env, g, p, a) => { const r = FD.matchAct(env, g, p, a); return { g: r.m, error: r.error }; },
  botActions: FD.botActions,
  applyEntry: (env, g, e) => { const r = FD.applyEntry(env, g, e); return { g: r.m, error: r.error }; },
  replay: (env, init, es) => { const r = FD.replay(env, init, es); return { g: r.m, error: r.error, at: r.at }; },
  period: (g) => g.turn,
  over: (g) => !!g.over,
  fields: (room) => ({ turns: room.turns, map: fdMap(room) }),
};

export const GAMES = { mainline, founders };

/** The adapter for a room (rooms stored before Founders existed have no `game`: Mainline). */
export const gameOf = (room) => GAMES[room?.game || "mainline"];
