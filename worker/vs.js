// Mainline versus (docs/MULTIPLAYER.md, "Mainline versus (real time)"): room create/status/socket for the Worker, and
// VersusRoom, one live game per Durable Object (SQLite-backed, WebSocket Hibernation API).
//
// The rules engine is web/js/games/mainline/sim/versus.js, shared with the browsers. The room keeps:
//   * the room meta as one JSON row (table `room`, like RaceRoom);
//   * the authoritative entry log, one row per entry (table `log`, seq = 0-based index, e = entry JSON);
//   * the live game object in memory only. After hibernation or eviction it is rebuilt lazily with
//     replay(env, init, entries), init = {seed, years, players: room.players.map(({name, bot}) => ({name, bot}))}.
// One alarm slot: the earliest of the year's deadline (if still ahead) and "forget the room" (2 h after activity).
// Decisions live in the pure exported helpers below (tests/js/worker-vs.test.mjs); the class only wires them up.
import { DurableObject } from "cloudflare:workers";
import { newVersus, vsAct, applyEntry, botActions, replay, VS_MAX, VS_YEARS, BOT_NAMES } from "../web/js/games/mainline/sim/versus.js";
import { shapeError, REQUIRED_DATA } from "../web/js/games/mainline/sim/verify.js";
import { makeEnv } from "../web/js/games/mainline/sim/env.js";
import { scenarioById, START_YEAR } from "../web/js/games/mainline/sim/scenarios.js";
import { json, error, readJson, requirePlayer, limitWrite, playerForToken, sameOrigin, HttpError } from "./http.js";
import { loadMany } from "./data.js";
import { isRoomCode, newRoomCode, FORGET_HOURS } from "./rules.js";

export const VS_DEADLINE_MS = 90_000;
export const VS_MAX_ENTRIES = 20_000;
export const VS_ACTS_PER_SEC = 30;
export const VS_FORGET_MS = FORGET_HOURS * 3600_000;
const MAX_MSG = 32 * 1024;
// loadMany() wants a request for the asset URL; any origin works for the ASSETS binding.
const ASSET_BASE = { url: "https://usaciv.internal/" };

// --- pure helpers ----------------------------------------------------------------------------------------------

/** Shape check of POST /api/ml/vs → {scenario, home, years, bots} or {error}. Sandbox homes are checked later. */
export function cleanVsBody(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be an object" };
  const sc = typeof b.scenario === "string" ? scenarioById(b.scenario) : null;
  if (!sc) return { error: "unknown scenario" };
  let home = null;
  if (sc.home) {
    if (b.home != null && b.home !== sc.home) return { error: "this scenario has a fixed home" };
  } else {
    if (typeof b.home !== "string" || !/^\d{5}$/.test(b.home)) return { error: "sandbox games need a 5-digit home" };
    home = b.home;
  }
  if (!VS_YEARS.includes(b.years)) return { error: `years must be ${VS_YEARS.join(" or ")}` };
  if (!Number.isInteger(b.bots) || b.bots < 0 || b.bots > VS_MAX - 1) return { error: `bots must be 0–${VS_MAX - 1}` };
  return { scenario: sc.id, home, years: b.years, bots: b.bots };
}

export const humanCount = (room) => room.players.filter((p) => !p.bot).length;
export const humanSeats = (room) => VS_MAX - room.bots;

/** A socket for player `id` arrives. → {seat: player} (already seated), {join: true} or {refusal}. */
export function joinCheck(room, id) {
  const p = room.players.find((x) => !x.bot && x.id === id);
  if (p) return { seat: p };
  if (room.status !== "lobby") return { refusal: "This game has already started" };
  if (humanCount(room) >= humanSeats(room)) return { refusal: `This room is full (${humanSeats(room)} people)` };
  return { join: true };
}

/** Why `id` may not start now, or null. */
export function startError(room, id) {
  if (id !== room.host) return "Only the host can start";
  if (room.status !== "lobby") return "Already started";
  const n = humanCount(room) + room.bots;
  if (n < 2) return "A game needs at least 2 companies: wait for someone or add an AI company";
  if (n > VS_MAX) return `At most ${VS_MAX} companies`;
  return null;
}

/** The seats at the start: the people in join order, then the bots (id null, named BOT_NAMES). */
export function seatPlayers(players, bots) {
  const people = players.filter((p) => !p.bot).map((p) => ({ ...p, ready: false }));
  const ais = Array.from({ length: bots }, (_, k) => ({ id: null, name: BOT_NAMES[k], bot: true, ready: false }));
  return [...people, ...ais];
}

/** A game seed from a random uint32: 1..2^31-1. */
export const newSeed = (u32) => 1 + (u32 % 0x7ffffffe);

/** The seat index (player p in the entry log) of person `id`, or -1. */
export const seatOf = (room, id) => room.players.findIndex((x) => !x.bot && x.id === id);

/** How many more entries may be added now, keeping one slot for every resolve still to come (this year's too). */
export function entryRoom(n, year, years) {
  const resolvesLeft = Math.max(0, START_YEAR + years - year);
  return VS_MAX_ENTRIES - n - resolvesLeft;
}

/**
 * Whether the year resolves now: the game is live, at least one person is online, and every online person is ready
 * or the deadline has passed. Offline people count as ready; with everyone offline nothing resolves.
 */
export function shouldResolve(room, online, now) {
  if (room.status !== "live") return false;
  const people = room.players.filter((p) => !p.bot);
  const on = people.filter((p) => online.has(p.id));
  if (!on.length) return false;
  if (room.deadline != null && now >= room.deadline) return true;
  return on.every((p) => p.ready);
}

/** Person `p` sets ready to `on`; the first ready of a year starts the deadline. Mutates room and p. */
export function setReady(room, p, on, now) {
  p.ready = !!on;
  if (p.ready && room.deadline == null) room.deadline = now + VS_DEADLINE_MS;
}

/** When the single alarm should next fire: the earliest of the deadline (if still ahead) and the forget time. */
export function nextAlarm(room, now) {
  let t = room.lastActivity + VS_FORGET_MS;
  if (room.status === "live" && room.deadline != null && room.deadline > now) t = Math.min(t, room.deadline);
  return t;
}

/**
 * Resolve the year: each bot seat in order appends its botActions (at most `maxBot` entries in all), then {r: 1}.
 * → {vs, es}
 */
export function resolveEntries(env, vs, maxBot = Infinity) {
  const es = [];
  let bot = 0;
  for (let p = 0; p < vs.players.length; p++) {
    if (!vs.players[p].bot) continue;
    for (const a of botActions(env, vs, p)) {
      if (bot >= maxBot) break;
      const r = vsAct(env, vs, p, a);
      if (r.error) break; // cannot happen (botActions only picks valid actions); stop this bot rather than desync
      vs = r.vs;
      es.push({ p, a });
      bot++;
    }
  }
  const r = applyEntry(env, vs, { r: 1 });
  if (!r.error) { vs = r.vs; es.push({ r: 1 }); }
  return { vs, es };
}

/** Year after the log: START_YEAR plus the resolves so far. */
export const yearOf = (entries) => START_YEAR + entries.filter((e) => e && e.r === 1).length;

/** The replay init for a room (newVersus's options). */
export const vsInit = (room) => ({ seed: room.seed, years: room.years, players: room.players.map(({ name, bot }) => ({ name, bot })) });

/** Fixed one-second window: → true if this act is allowed. Mutates `bucket` ({t, n}). */
export function allowAct(bucket, now) {
  if (now - bucket.t >= 1000) { bucket.t = now; bucket.n = 0; }
  if (bucket.n >= VS_ACTS_PER_SEC) return false;
  bucket.n++;
  return true;
}

/** The public room. `online` = Set of person ids with an open socket. Bots are always online and ready. */
export function roomView(room, online) {
  return {
    code: room.code, status: room.status, scenario: room.scenario, home: room.home, years: room.years, bots: room.bots,
    seed: room.status === "lobby" ? null : room.seed, host: room.host, year: room.year, deadline: room.deadline,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, bot: !!p.bot, online: p.bot ? true : online.has(p.id), ready: p.bot ? true : !!p.ready,
    })),
  };
}

/** GET /api/ml/vs/:code body. players = people seated; seats = the most people the room takes. */
export const statusView = (room) => ({
  code: room.code, status: room.status, scenario: room.scenario, home: room.home, years: room.years,
  players: humanCount(room), seats: humanSeats(room),
});

export function newRoom({ code, scenario, home, years, bots, host }, now) {
  return {
    code, status: "lobby", scenario, home, years, bots, seed: null, host: host.id, year: START_YEAR, deadline: null,
    createdAt: now, startedAt: null, lastActivity: now,
    players: [{ id: host.id, name: host.name, bot: false, ready: false }],
  };
}

// --- Mainline envs, once per isolate per scenario:home ---------------------------------------------------------

const envCache = new Map(); // "scenario:home" → Promise<env>, most recently used last
const ENV_CACHE_MAX = 6;

/** makeEnv(data, scenario, {home}) with the REQUIRED_DATA files from env.ASSETS, cached. */
export function vsEnv(env, scenario, home) {
  const key = `${scenario}:${home ?? ""}`;
  let p = envCache.get(key);
  if (p) {
    envCache.delete(key);
  } else {
    p = loadMany(env, ASSET_BASE, REQUIRED_DATA).then((data) => makeEnv(data, scenario, { home }));
    p.catch(() => envCache.delete(key));
  }
  envCache.set(key, p);
  while (envCache.size > ENV_CACHE_MAX) envCache.delete(envCache.keys().next().value);
  return p;
}
const dropEnv = (scenario, home) => envCache.delete(`${scenario}:${home ?? ""}`);

// --- Worker handlers -------------------------------------------------------------------------------------------

const randomByte = () => crypto.getRandomValues(new Uint8Array(1))[0];
const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const roomStub = (env, code) => env.VS.get(env.VS.idFromName(code));

/** POST /api/ml/vs {scenario, home?, years, bots} → {code} (201) */
export async function createVs(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const b = cleanVsBody(await readJson(request));
  if (b.error) throw new HttpError(400, b.error);
  if (b.home) {
    let e = null;
    try { e = await vsEnv(env, b.scenario, b.home); } catch { /* below */ }
    if (e?.home?.id !== b.home) {
      dropEnv(b.scenario, b.home);
      throw new HttpError(400, "Unknown home metro");
    }
  }
  for (let tries = 0; tries < 5; tries++) {
    const code = newRoomCode(randomByte);
    const ok = await roomStub(env, code).init({ code, ...b, host: { id: me.id, name: me.name } });
    if (ok) return json({ code }, 201);
  }
  return error(503, "Could not make a room, try again");
}

/** GET /api/ml/vs/:code → {code, status, scenario, home, years, players, seats} */
export async function vsStatus(request, env, code) {
  if (!isRoomCode(code)) return error(404, "No such room");
  const s = await roomStub(env, code).status();
  return s ? json(s) : error(404, "No such room");
}

/** GET /api/ml/vs/:code/ws?token=… → WebSocket, handed to the room with the verified player in headers. */
export async function vsSocket(request, env, code) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "Expected a WebSocket upgrade");
  if (!sameOrigin(request)) return error(403, "Cross-site socket refused");
  if (!isRoomCode(code)) return error(404, "No such room");
  const me = await playerForToken(env, new URL(request.url).searchParams.get("token"));
  if (!me) return error(401, "Sign-in token missing or unknown");
  const headers = new Headers({ Upgrade: "websocket", "X-Player-Id": me.id, "X-Player-Name": encodeURIComponent(me.name) });
  return roomStub(env, code).fetch(new Request(`https://room/${code}/ws`, { headers }));
}

// --- the Durable Object ----------------------------------------------------------------------------------------

export class VersusRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureTables();
    const row = this.sql.exec("SELECT v FROM room WHERE k = 'room'").toArray()[0];
    this.room = row ? JSON.parse(row.v) : null;
    this.n = Number(this.sql.exec("SELECT COUNT(*) AS n FROM log").toArray()[0].n); // entries in the log
    this.vs = null; // the game after the first vsN entries (memory only)
    this.vsN = -1;
    this.buckets = new WeakMap(); // socket → act rate window (memory only; reset on hibernation, which is fine)
    this.savedAt = 0;
  }

  ensureTables() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS room (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, e TEXT NOT NULL)");
  }

  // --- RPC from the Worker -------------------------------------------------------------------------------------

  /** Make the room; false when this code is already taken. */
  async init(opts) {
    if (this.room) return false;
    this.ensureTables();
    this.room = newRoom(opts, Date.now());
    this.n = 0;
    await this.save();
    return true;
  }

  async status() {
    return this.room ? statusView(this.room) : null;
  }

  // --- game state ----------------------------------------------------------------------------------------------

  envFor() {
    return vsEnv(this.env, this.room.scenario, this.room.home);
  }

  /** The live game, rebuilt from the log when memory lost it. Synchronous: call after `await this.envFor()`. */
  game(e) {
    if (this.vs && this.vsN === this.n) return this.vs;
    const entries = this.sql.exec("SELECT e FROM log ORDER BY seq").toArray().map((r) => JSON.parse(r.e));
    const res = replay(e, vsInit(this.room), entries);
    if (res.error) console.error("versus replay failed", this.room.code, res.at, res.error);
    this.vs = res.vs;
    this.vsN = this.n;
    return this.vs;
  }

  /** Append entries to the log and broadcast them in one `entries` message. */
  append(es, vs) {
    const i = this.n;
    for (const e of es) this.sql.exec("INSERT INTO log (seq, e) VALUES (?, ?)", this.n++, JSON.stringify(e));
    this.vs = vs;
    this.vsN = this.n;
    this.sendAll(JSON.stringify({ t: "entries", i, es }));
  }

  logMessage() {
    const rows = this.sql.exec("SELECT e FROM log ORDER BY seq").toArray();
    return `{"t":"log","es":[${rows.map((r) => r.e).join(",")}]}`;
  }

  /** Resolve the year if the rules say so now. → true if it resolved. */
  async maybeResolve(closing = null) {
    if (!shouldResolve(this.room, this.onlineIds(closing), Date.now())) return false;
    const e = await this.envFor();
    const r = this.room;
    if (!shouldResolve(r, this.onlineIds(closing), Date.now())) return false; // changed while the env loaded
    const vs = this.game(e);
    const res = resolveEntries(e, vs, Math.max(0, entryRoom(this.n, r.year, r.years)));
    this.append(res.es, res.vs);
    r.year = res.vs.year;
    r.deadline = null;
    for (const p of r.players) p.ready = false;
    if (res.vs.over) r.status = "done";
    return true;
  }

  // --- sockets -------------------------------------------------------------------------------------------------

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (!this.room) return Response.json({ error: "No such room" }, { status: 404 });
    const id = request.headers.get("X-Player-Id");
    const name = decodeURIComponent(request.headers.get("X-Player-Name") || "");
    if (!id || !name) return new Response("Missing player", { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    const j = joinCheck(this.room, id);
    if (j.refusal) {
      // Not a hibernatable socket: say why, close it and forget it.
      server.accept();
      send(server, { t: "error", error: j.refusal });
      server.close(4001, j.refusal);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id });
    await this.connect(server, id, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A newly accepted socket for player id. */
  async connect(ws, id, name) {
    const r = this.room;
    const j = joinCheck(r, id);
    if (j.refusal) { // fetch() refuses before accepting; this covers direct callers (tests)
      send(ws, { t: "error", error: j.refusal });
      ws.close(4001, j.refusal);
      return;
    }
    if (j.join) r.players.push({ id, name, bot: false, ready: false });
    else if (r.status === "lobby") j.seat.name = name; // follows renames until the start (names are part of the init)
    await this.touchAndBroadcast();
    if (r.status !== "lobby") ws.send(this.logMessage());
    if (await this.maybeResolve()) await this.touchAndBroadcast(); // a deadline that passed while everyone was away
  }

  async webSocketMessage(ws, message) {
    const r = this.room;
    if (!r) { ws.close(4004, "Room closed"); return; }
    if (typeof message !== "string" || message.length > MAX_MSG) return send(ws, { t: "error", error: "Message too large" });
    let m;
    try { m = JSON.parse(message); } catch { return send(ws, { t: "error", error: "Bad message" }); }
    const { id } = ws.deserializeAttachment() || {};
    const p = r.players.find((x) => !x.bot && x.id === id);
    if (!p) return send(ws, { t: "error", error: "You are not in this room" });

    switch (m?.t) {
      case "start": {
        const err = startError(r, id);
        if (err) return send(ws, { t: "error", error: err });
        r.players = seatPlayers(r.players, r.bots);
        r.seed = newSeed(randomU32());
        r.status = "live";
        r.startedAt = Date.now();
        r.year = START_YEAR;
        r.deadline = null;
        this.sql.exec("DELETE FROM log");
        this.n = 0;
        this.vs = null;
        this.vsN = -1;
        await this.touchAndBroadcast();
        this.sendAll(this.logMessage());
        return;
      }
      case "act": {
        const reject = (error) => send(ws, { t: "reject", error, i: this.n });
        if (r.status !== "live") return reject(r.status === "done" ? "The game is over" : "The game has not started");
        let b = this.buckets.get(ws);
        if (!b) this.buckets.set(ws, (b = { t: 0, n: 0 }));
        if (!allowAct(b, Date.now())) return reject("Too many actions, slow down");
        const e = await this.envFor();
        if (r.status !== "live") return reject("The game is over");
        const bad = shapeError(m.a, e.hexmap.size);
        if (bad) return reject(bad);
        if (entryRoom(this.n, r.year, r.years) <= 0) return reject("This game's log is full");
        const seat = seatOf(r, id);
        const res = vsAct(e, this.game(e), seat, m.a);
        if (res.error) return reject(res.error);
        this.append([{ p: seat, a: m.a }], res.vs);
        r.lastActivity = Date.now();
        if (r.lastActivity - this.savedAt > 60_000) await this.save(); // lastActivity only feeds the 2 h forget
        return;
      }
      case "ready": {
        if (r.status !== "live") return send(ws, { t: "error", error: r.status === "done" ? "The game is over" : "The game has not started" });
        setReady(r, p, m.on !== false, Date.now());
        await this.maybeResolve();
        return this.touchAndBroadcast();
      }
      case "sync":
        if (r.status !== "lobby") ws.send(this.logMessage());
        return;
      default:
        return send(ws, { t: "error", error: "Unknown message" });
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
    await this.left(ws);
  }

  async webSocketError(ws) {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
    await this.left(ws);
  }

  async left(ws) {
    const r = this.room;
    if (!r) return;
    const { id } = ws.deserializeAttachment() || {};
    // In the lobby a person who leaves gives the seat back (the host keeps the room and can return).
    if (r.status === "lobby" && id && id !== r.host && !this.onlineIds(ws).has(id)) {
      r.players = r.players.filter((p) => p.bot || p.id !== id);
    }
    await this.maybeResolve(ws); // the last person not ready may just have left
    await this.touchAndBroadcast(ws);
  }

  // --- alarm ---------------------------------------------------------------------------------------------------

  async alarm() {
    const r = this.room;
    if (!r) return;
    const now = Date.now();
    if (now - r.lastActivity >= VS_FORGET_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4004, "Room closed"); } catch { /* ignore */ } }
      this.room = null;
      this.vs = null;
      this.n = 0;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (await this.maybeResolve()) return this.touchAndBroadcast();
    await this.save(); // schedules the next alarm
  }

  // --- helpers -------------------------------------------------------------------------------------------------

  async touchAndBroadcast(closing = null) {
    this.room.lastActivity = Date.now();
    await this.save();
    this.sendAll(JSON.stringify({ t: "room", room: roomView(this.room, this.onlineIds(closing)) }), closing);
  }

  async save() {
    const r = this.room;
    this.sql.exec("INSERT OR REPLACE INTO room (k, v) VALUES ('room', ?)", JSON.stringify(r));
    this.savedAt = Date.now();
    await this.ctx.storage.setAlarm(nextAlarm(r, this.savedAt));
  }

  /** Ids of people with an open socket (minus one that is closing). */
  onlineIds(closing = null) {
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing || ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment();
      if (a?.id) online.add(a.id);
    }
    return online;
  }

  sendAll(msg, closing = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      try { ws.send(msg); } catch { /* closing */ }
    }
  }
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
}
