// Real-time rooms (docs/MULTIPLAYER.md, "Mainline versus (real time)" and "Founders multiplayer (real time)"): room
// create/status/socket for the Worker, and VersusRoom, one live game per Durable Object (SQLite-backed, WebSocket
// Hibernation API).
//
// A room hosts one game, room.game ("mainline", the default for rooms stored without it, or "founders"). Everything
// game-specific goes through that game's adapter in worker/games.js; the rules engines are the browsers' own pure
// sim modules. The room keeps:
//   * the room meta as one JSON row (table `room`, like RaceRoom);
//   * the authoritative entry log, one row per entry (table `log`, seq = 0-based index, e = entry JSON);
//   * the live game object in memory only. After hibernation or eviction it is rebuilt lazily with
//     adapter.replay(env, adapter.init(room), entries).
// One alarm slot: the earliest of the period's deadline (if still ahead) and "forget the room" (2 h after activity).
// Decisions live in the pure exported helpers below (tests/js/worker-vs.test.mjs, worker-fd.test.mjs); the class
// only wires them up.
import { DurableObject } from "cloudflare:workers";
import { json, error, readJson, requirePlayer, limitWrite, playerForToken, sameOrigin, HttpError } from "./http.js";
import { isRoomCode, newRoomCode, FORGET_HOURS } from "./rules.js";
import { GAMES, gameOf } from "./games.js";

export { cleanVsBody, cleanFdBody, newSeed } from "./games.js";

export const VS_DEADLINE_MS = 90_000;
export const VS_MAX_ENTRIES = 20_000;
export const VS_ACTS_PER_SEC = 30;
export const VS_FORGET_MS = FORGET_HOURS * 3600_000;
const MAX_MSG = 32 * 1024;

// --- pure helpers ----------------------------------------------------------------------------------------------

export const humanCount = (room) => room.players.filter((p) => !p.bot).length;
export const humanSeats = (room) => gameOf(room).max - room.bots;

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
  const g = gameOf(room);
  if (id !== room.host) return "Only the host can start";
  if (room.status !== "lobby") return "Already started";
  const n = humanCount(room) + room.bots;
  if (n < 2) return `A game needs at least 2 ${g.units}: wait for someone or add an AI ${g.unit}`;
  if (n > g.max) return `At most ${g.max} ${g.units}`;
  return null;
}

/** The seats at the start: the people in join order, then the bots (id null, named by the game's botNames). */
export function seatPlayers(room) {
  const names = gameOf(room).botNames;
  const people = room.players.filter((p) => !p.bot).map((p) => ({ ...p, ready: false }));
  const ais = Array.from({ length: room.bots }, (_, k) => ({ id: null, name: names[k], bot: true, ready: false }));
  return [...people, ...ais];
}

/** The seat index (player p in the entry log) of person `id`, or -1. */
export const seatOf = (room, id) => room.players.findIndex((x) => !x.bot && x.id === id);

/** How many more entries may be added to a log of n, keeping one slot for each of `resolvesLeft` resolves to come. */
export const entryRoom = (n, resolvesLeft) => VS_MAX_ENTRIES - n - resolvesLeft;

/**
 * Whether the period resolves now: the game is live, at least one person is online, and every online person is
 * ready or the deadline has passed. Offline people count as ready; with everyone offline nothing resolves.
 */
export function shouldResolve(room, online, now) {
  if (room.status !== "live") return false;
  const people = room.players.filter((p) => !p.bot);
  const on = people.filter((p) => online.has(p.id));
  if (!on.length) return false;
  if (room.deadline != null && now >= room.deadline) return true;
  return on.every((p) => p.ready);
}

/** Person `p` sets ready to `on`; the first ready of a period starts the deadline. Mutates room and p. */
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
 * Resolve the period: each bot seat in order appends its botActions (at most `maxBot` entries in all), then {r: 1}.
 * `ad` is the game's adapter. → {g, es}
 */
export function resolveEntries(ad, env, g, maxBot = Infinity) {
  const es = [];
  let bot = 0;
  for (let p = 0; p < g.players.length; p++) {
    if (!g.players[p].bot) continue;
    for (const a of ad.botActions(env, g, p)) {
      if (bot >= maxBot) break;
      const r = ad.act(env, g, p, a);
      if (r.error) break; // cannot happen (botActions only picks valid actions); stop this bot rather than desync
      g = r.g;
      es.push({ p, a });
      bot++;
    }
  }
  const r = ad.applyEntry(env, g, { r: 1 });
  if (!r.error) { g = r.g; es.push({ r: 1 }); }
  return { g, es };
}

/** Fixed one-second window: → true if this act is allowed. Mutates `bucket` ({t, n}). */
export function allowAct(bucket, now) {
  if (now - bucket.t >= 1000) { bucket.t = now; bucket.n = 0; }
  if (bucket.n >= VS_ACTS_PER_SEC) return false;
  bucket.n++;
  return true;
}

/**
 * The public room. `online` = Set of person ids with an open socket. Bots are always online and ready.
 * Mainline: {code, game, status, scenario, home, years, bots, seed, host, year, deadline, players};
 * Founders: {code, game, status, turns, bots, seed, host, turn, deadline, players}.
 */
export function roomView(room, online) {
  const g = gameOf(room);
  return {
    code: room.code, game: g.id, status: room.status, ...g.fields(room), bots: room.bots,
    seed: room.status === "lobby" ? null : room.seed, host: room.host, [g.periodKey]: room[g.periodKey], deadline: room.deadline,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, bot: !!p.bot, online: p.bot ? true : online.has(p.id), ready: p.bot ? true : !!p.ready,
    })),
  };
}

/** GET /api/{ml/vs,fd/match}/:code body, in the room's own game. players = people seated; seats = the most people. */
export function statusView(room) {
  const g = gameOf(room);
  return { code: room.code, game: g.id, status: room.status, ...g.fields(room), players: humanCount(room), seats: humanSeats(room) };
}

/** A new lobby. opts = {code, game?, host, bots, …the game's cleanBody fields}; game defaults to "mainline". */
export function newRoom({ code, game = "mainline", host, ...settings }, now) {
  const g = GAMES[game];
  return {
    code, game: g.id, status: "lobby", ...g.fields(settings), bots: settings.bots, seed: null, host: host.id,
    [g.periodKey]: g.firstPeriod, deadline: null, createdAt: now, startedAt: null, lastActivity: now,
    players: [{ id: host.id, name: host.name, bot: false, ready: false }],
  };
}

// --- Worker handlers -------------------------------------------------------------------------------------------

const randomByte = () => crypto.getRandomValues(new Uint8Array(1))[0];
const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const roomStub = (env, code) => env.VS.get(env.VS.idFromName(code));

/** POST /api/ml/vs {scenario, home?, years, bots} or POST /api/fd/match {turns, bots} → {code} (201) */
export async function createRoom(request, env, game) {
  const ad = GAMES[game];
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const b = ad.cleanBody(await readJson(request));
  if (b.error) throw new HttpError(400, b.error);
  const bad = await ad.checkBody(env, b);
  if (bad) throw new HttpError(400, bad);
  for (let tries = 0; tries < 5; tries++) {
    const code = newRoomCode(randomByte);
    const ok = await roomStub(env, code).init({ code, game, ...b, host: { id: me.id, name: me.name } });
    if (ok) return json({ code }, 201);
  }
  return error(503, "Could not make a room, try again");
}
export const createVs = (request, env) => createRoom(request, env, "mainline");
export const createFd = (request, env) => createRoom(request, env, "founders");

/** GET /api/{ml/vs,fd/match}/:code → statusView (in the room's own game: codes are shared across games) */
export async function vsStatus(request, env, code) {
  if (!isRoomCode(code)) return error(404, "No such room");
  const s = await roomStub(env, code).status();
  return s ? json(s) : error(404, "No such room");
}

/**
 * GET /api/{ml/vs,fd/match}/:code/ws?token=… → WebSocket, handed to the room with the verified player (and the game
 * the path is for) in headers.
 */
export async function vsSocket(request, env, code, game = "mainline") {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "Expected a WebSocket upgrade");
  if (!sameOrigin(request)) return error(403, "Cross-site socket refused");
  if (!isRoomCode(code)) return error(404, "No such room");
  const me = await playerForToken(env, new URL(request.url).searchParams.get("token"));
  if (!me) return error(401, "Sign-in token missing or unknown");
  const headers = new Headers({ Upgrade: "websocket", "X-Player-Id": me.id, "X-Player-Name": encodeURIComponent(me.name), "X-Game": game });
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
    this.g = null; // the game after the first gN entries (memory only)
    this.gN = -1;
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

  /** This room's game adapter (worker/games.js). */
  get ad() {
    return gameOf(this.room);
  }

  envFor() {
    return this.ad.env(this.env, this.room);
  }

  /** The live game, rebuilt from the log when memory lost it. Synchronous: call after `await this.envFor()`. */
  game(e) {
    if (this.g && this.gN === this.n) return this.g;
    const entries = this.sql.exec("SELECT e FROM log ORDER BY seq").toArray().map((r) => JSON.parse(r.e));
    const res = this.ad.replay(e, this.ad.init(this.room), entries);
    if (res.error) console.error("room replay failed", this.ad.id, this.room.code, res.at, res.error);
    this.g = res.g;
    this.gN = this.n;
    return this.g;
  }

  /** Append entries to the log and broadcast them in one `entries` message. */
  append(es, g) {
    const i = this.n;
    for (const e of es) this.sql.exec("INSERT INTO log (seq, e) VALUES (?, ?)", this.n++, JSON.stringify(e));
    this.g = g;
    this.gN = this.n;
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
    const ad = this.ad;
    const res = resolveEntries(ad, e, this.game(e), Math.max(0, entryRoom(this.n, ad.resolvesLeft(r))));
    this.append(res.es, res.g);
    r[ad.periodKey] = ad.period(res.g);
    r.deadline = null;
    for (const p of r.players) p.ready = false;
    if (ad.over(res.g)) r.status = "done";
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
    // A socket opened on the other game's path (codes are shared across games) is refused like a full room.
    const want = request.headers.get("X-Game");
    const j = want && want !== this.ad.id ? { refusal: `Room ${this.room.code} is a ${this.ad.title} game` } : joinCheck(this.room, id);
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
        r.players = seatPlayers(r);
        r.seed = this.ad.newSeed(randomU32());
        r.status = "live";
        r.startedAt = Date.now();
        r[this.ad.periodKey] = this.ad.firstPeriod;
        r.deadline = null;
        this.sql.exec("DELETE FROM log");
        this.n = 0;
        this.g = null;
        this.gN = -1;
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
        const ad = this.ad;
        const bad = ad.shapeError(e, m.a);
        if (bad) return reject(bad);
        if (entryRoom(this.n, ad.resolvesLeft(r)) <= 0) return reject("This game's log is full");
        const seat = seatOf(r, id);
        const res = ad.act(e, this.game(e), seat, m.a);
        if (res.error) return reject(res.error);
        this.append([{ p: seat, a: m.a }], res.g);
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
      this.g = null;
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
