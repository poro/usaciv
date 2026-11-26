// RaceRoom: one Which Metro? race per Durable Object (SQLite-backed, WebSocket Hibernation API).
// The Worker verifies the player's token and passes the id and name in X-Player-Id / X-Player-Name, so the room
// never sees tokens. State is one JSON row in the object's SQLite; online flags come from the live sockets.
// An alarm closes the race 30 minutes after start and forgets the room 2 hours after its last activity.
import { DurableObject } from "cloudflare:workers";
import { practiceAnswers } from "../web/js/games/whichMetro/sim/puzzle.js";
import { wmPool } from "./data.js";
import { cleanRounds, replayRounds, cleanProgress, placePlayers, MAX_PLAYERS, RACE_MINUTES, FORGET_HOURS } from "./rules.js";

const CLOSE_MS = RACE_MINUTES * 60_000;
const FORGET_MS = FORGET_HOURS * 3600_000;
const MAX_MSG = 32 * 1024;
const PROGRESS_GAP_MS = 250;
// wmPool() wants a request for the asset URL; any origin works for the ASSETS binding.
const ASSET_BASE = { url: "https://usaciv.internal/" };

export class RaceRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureTable();
    const row = this.sql.exec("SELECT v FROM room WHERE k = 'room'").toArray()[0];
    this.room = row ? JSON.parse(row.v) : null;
    this.lastProgress = new Map(); // player id → ms (in memory only; lost on hibernation, which is fine)
  }

  ensureTable() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS room (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  // --- RPC from the Worker -------------------------------------------------------------------------------------

  /** Make the room; false when this code is already taken. */
  async init({ code, seed, host }) {
    if (this.room) return false;
    this.ensureTable();
    const now = Date.now();
    this.room = {
      code, seed, status: "lobby", host: host.id, createdAt: now, startedAt: null, lastActivity: now,
      players: [newPlayer(host, now)],
    };
    await this.save();
    return true;
  }

  /** {code, status, players: n}, or null for an unknown room. */
  async status() {
    const r = this.room;
    return r ? { code: r.code, status: r.status, players: r.players.length } : null;
  }

  // --- sockets -------------------------------------------------------------------------------------------------

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (!this.room) return Response.json({ error: "No such room" }, { status: 404 });
    const id = request.headers.get("X-Player-Id");
    const name = decodeURIComponent(request.headers.get("X-Player-Name") || "");
    if (!id || !name) return new Response("Missing player", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const r = this.room;
    let p = r.players.find((x) => x.id === id);
    let refusal = null;
    if (!p) {
      if (r.status !== "lobby") refusal = "This race has already started";
      else if (r.players.length >= MAX_PLAYERS) refusal = `This room is full (${MAX_PLAYERS} players)`;
      else r.players.push((p = newPlayer({ id, name }, Date.now())));
    }
    if (refusal) {
      // refuse on a plain (non-hibernating) socket: a hibernated one sent the error but never delivered the close
      server.accept();
      send(server, { t: "error", error: refusal });
      server.close(4001, refusal);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id });
    p.name = name; // follows renames
    await this.touchAndBroadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const r = this.room;
    if (!r) { ws.close(4004, "Room closed"); return; }
    if (typeof message !== "string" || message.length > MAX_MSG) return send(ws, { t: "error", error: "Message too large" });
    let m;
    try { m = JSON.parse(message); } catch { return send(ws, { t: "error", error: "Bad message" }); }
    const { id } = ws.deserializeAttachment() || {};
    const p = r.players.find((x) => x.id === id);
    if (!p) return send(ws, { t: "error", error: "You are not in this room" });

    switch (m?.t) {
      case "start": {
        if (id !== r.host) return send(ws, { t: "error", error: "Only the host can start" });
        if (r.status !== "lobby") return send(ws, { t: "error", error: "Already started" });
        r.status = "live";
        r.startedAt = Date.now();
        return this.touchAndBroadcast();
      }
      case "progress": {
        if (r.status !== "live" || p.finishedAt != null) return;
        const now = Date.now();
        if (now - (this.lastProgress.get(id) || 0) < PROGRESS_GAP_MS) return;
        this.lastProgress.set(id, now);
        const pr = cleanProgress(m);
        if (!pr) return;
        Object.assign(p, pr);
        return this.touchAndBroadcast();
      }
      case "finish": {
        if (r.status === "lobby") return send(ws, { t: "error", error: "The race has not started" });
        if (r.status === "done") return send(ws, { t: "error", error: "The race is over" });
        if (p.finishedAt != null) return send(ws, { t: "error", error: "You already finished" });
        const c = cleanRounds(m.rounds);
        if (c.error) return send(ws, { t: "error", error: c.error });
        const answers = practiceAnswers(await wmPool(this.env, ASSET_BASE), r.seed);
        const v = replayRounds(answers, c.rounds, { complete: false });
        if (v.error) return send(ws, { t: "error", error: v.error });
        p.score = v.score;
        p.round = v.rounds.length;
        p.clues = 0;
        p.finishedAt = Date.now();
        p.done = true;
        const allDone = r.players.every((x) => x.finishedAt != null);
        if (allDone) r.status = "done";
        placePlayers(r.players, allDone);
        return this.touchAndBroadcast();
      }
      default:
        return send(ws, { t: "error", error: "Unknown message" });
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
    if (this.room) await this.touchAndBroadcast(ws);
  }

  async webSocketError(ws) {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
    if (this.room) await this.touchAndBroadcast(ws);
  }

  // --- alarm ---------------------------------------------------------------------------------------------------

  async alarm() {
    const r = this.room;
    if (!r) return;
    const now = Date.now();
    if (now - r.lastActivity >= FORGET_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4004, "Room closed"); } catch { /* ignore */ } }
      this.room = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (r.status === "live" && now >= r.startedAt + CLOSE_MS) {
      r.status = "done";
      placePlayers(r.players, true);
      this.broadcast();
    }
    await this.save(); // also schedules the next alarm
  }

  // --- helpers -------------------------------------------------------------------------------------------------

  async touchAndBroadcast(closing = null) {
    this.room.lastActivity = Date.now();
    await this.save();
    this.broadcast(closing);
  }

  async save() {
    const r = this.room;
    this.sql.exec("INSERT OR REPLACE INTO room (k, v) VALUES ('room', ?)", JSON.stringify(r));
    let next = r.lastActivity + FORGET_MS;
    if (r.status === "live") next = Math.min(next, r.startedAt + CLOSE_MS);
    await this.ctx.storage.setAlarm(next);
  }

  /** The public room, with online flags from the open sockets (minus one that is closing). */
  view(closing = null) {
    const r = this.room;
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing || ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment();
      if (a?.id) online.add(a.id);
    }
    return {
      code: r.code, status: r.status, seed: r.status === "lobby" ? null : r.seed, host: r.host, startedAt: r.startedAt,
      players: r.players.map((p) => ({
        id: p.id, name: p.name, round: p.round, clues: p.clues, score: p.score, done: p.done, place: p.place, online: online.has(p.id),
      })),
    };
  }

  broadcast(closing = null) {
    const msg = JSON.stringify({ t: "room", room: this.view(closing) });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      try { ws.send(msg); } catch { /* closing */ }
    }
  }
}

const newPlayer = ({ id, name }, now) => ({ id, name, joinedAt: now, round: 0, clues: 0, score: 0, done: false, place: null, finishedAt: null });

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
}
