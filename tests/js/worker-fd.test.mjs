// Founders multiplayer rooms (worker/vs.js with the Founders adapter in worker/games.js): body checks, seats, and
// VersusRoom driven through a short Founders game with a fake Durable Object context (node:sqlite for
// ctx.storage.sql, fake sockets). node --test tests/js/*.test.mjs, no Workers runtime needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import * as S from "../../web/js/games/founders/sim/index.js";

// worker/vs.js imports "cloudflare:workers" for DurableObject: stand in a minimal base class.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}", shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const V = await import("../../worker/vs.js");
const G = await import("../../worker/games.js");

const dataUrl = (n) => new URL(`../../web/data/${n}.json`, import.meta.url);
const D = (n) => JSON.parse(readFileSync(dataUrl(n)));
const world = D("world");
// the browser's env (web/js/games/founders/index.js)
const env = S.makeEnv({ world, resources: D("resources"), hazards: S.buildHazards(D("disasters"), world) });

const lobby = (over = {}) => ({ ...V.newRoom({ code: "FDFDFD", game: "founders", turns: 30, bots: 1, host: { id: "a", name: "Ann" } }, 1000), ...over });

test("founders body validation", () => {
  assert.deepEqual(V.cleanFdBody({ turns: 30, bots: 1, map: "near" }), { turns: 30, bots: 1, map: "near" });
  assert.deepEqual(V.cleanFdBody({ turns: 60, bots: 0, map: "far" }), { turns: 60, bots: 0, map: "far" });
  assert.deepEqual(V.cleanFdBody({ turns: 30, bots: 1 }), { turns: 30, bots: 1, map: "far" }, "a client from before the choice replays far starts");
  assert.match(V.cleanFdBody({ turns: 30, bots: 1, map: "close" }).error, /map must be near or far/);
  assert.deepEqual(V.cleanFdBody({ turns: 30, bots: 3, map: "near", scenario: "texas" }), { turns: 30, bots: 3, map: "near" }, "other fields are dropped");
  assert.match(V.cleanFdBody({ turns: 45, bots: 1 }).error, /turns must be 30 or 60/);
  assert.ok(V.cleanFdBody({ turns: "30", bots: 1 }).error);
  assert.ok(V.cleanFdBody({ bots: 1 }).error);
  assert.match(V.cleanFdBody({ turns: 30, bots: 4 }).error, /bots must be 0–3/);
  assert.ok(V.cleanFdBody({ turns: 30, bots: -1 }).error);
  assert.ok(V.cleanFdBody({ turns: 30, bots: 0.5 }).error);
  assert.ok(V.cleanFdBody({ turns: 30 }).error);
  assert.ok(V.cleanFdBody(null).error);
  assert.ok(V.cleanFdBody([]).error);
  assert.equal(G.gameOf({}), G.mainline, "a stored room without `game` is Mainline");
  assert.equal(G.gameOf({ game: "founders" }), G.founders);
});

test("founders seats, start rules, room and status views", () => {
  const r = lobby();
  assert.equal(r.game, "founders");
  assert.equal(r.turn, 1);
  assert.ok(!("year" in r) && !("scenario" in r));
  assert.deepEqual(V.statusView(r), { code: "FDFDFD", game: "founders", status: "lobby", turns: 30, map: "far", players: 1, seats: 3 });
  assert.match(V.startError(lobby({ bots: 0 }), "a"), /at least 2 nations: wait for someone or add an AI nation/);
  assert.equal(V.startError(r, "a"), null, "one person plus one AI nation");

  r.players.push({ id: "b", name: "Bo", bot: false });
  r.bots = 2;
  assert.match(V.joinCheck(r, "c").refusal, /full \(2 people\)/);
  r.players = V.seatPlayers(r);
  assert.deepEqual(r.players.map((p) => [p.id, p.name, p.bot]), [["a", "Ann", false], ["b", "Bo", false], [null, S.BOT_NATIONS[0], true], [null, S.BOT_NATIONS[1], true]]);
  r.status = "live";
  r.seed = "77";
  const v = V.roomView(r, new Set(["b"]));
  assert.deepEqual(Object.keys(v), ["code", "game", "status", "turns", "map", "bots", "seed", "host", "turn", "deadline", "players"]);
  assert.equal(v.seed, "77");
  assert.deepEqual(v.players.map((p) => [p.online, p.ready]), [[false, false], [true, false], [true, true], [true, true]]);
  assert.equal(G.founders.init(r).seed, "77");
  assert.equal(G.founders.init(r).map, "far", "a room stored before the choice keeps far starts");
  assert.equal(G.founders.init({ ...r, map: "near" }).map, "near");
  assert.equal(lobby({ map: "near" }).map, "near");
  assert.equal(V.newRoom({ code: "FDFDFD", game: "founders", turns: 30, bots: 1, map: "near", host: { id: "a", name: "Ann" } }, 1000).map, "near");
  assert.deepEqual(G.founders.init(r).players.map((p) => p.name), ["Ann", "Bo", S.BOT_NATIONS[0], S.BOT_NATIONS[1]]);

  assert.equal(typeof G.founders.newSeed(5), "string");
  assert.equal(G.founders.newSeed(5), String(V.newSeed(5)));
  assert.equal(G.founders.resolvesLeft({ turns: 30, turn: 1 }), 30);
  assert.equal(G.founders.resolvesLeft({ turns: 30, turn: 31 }), 0);
});

test("the Worker's Founders env equals the browser's (hazards included)", async () => {
  const e = await G.fdEnv(assets);
  assert.equal(await G.fdEnv(assets), e, "one env per isolate");
  assert.ok(e.hazards, "disasters.json gives hazards");
  const init = { seed: "424242", turns: 30, players: [{ name: "A", bot: true }, { name: "B", bot: true }] };
  let a = S.newMatch(env, init), b = S.newMatch(e, init);
  for (let t = 0; t < 8; t++) {
    a = V.resolveEntries(G.founders, env, a).g;
    b = V.resolveEntries(G.founders, e, b).g;
  }
  assert.equal(S.matchHash(b), S.matchHash(a));
});

// --- VersusRoom with a fake context ----------------------------------------------------------------------------

class FakeWs {
  constructor(id) { this.readyState = 1; this.sent = []; this.att = null; this.id = id; }
  send(m) { if (this.readyState !== 1) throw new Error("closed"); this.sent.push(JSON.parse(m)); }
  close(code) { this.readyState = 3; this.closeCode = code; }
  serializeAttachment(a) { this.att = a; }
  deserializeAttachment() { return this.att; }
  take(t) { const out = this.sent.filter((m) => m.t === t); this.sent = this.sent.filter((m) => m.t !== t); return out; }
}

function fakeCtx(db) {
  const sockets = [];
  const storage = {
    alarm: null,
    sql: {
      exec(q, ...binds) {
        const st = db.prepare(q);
        const rows = /^\s*SELECT/i.test(q) ? st.all(...binds) : (st.run(...binds), []);
        return { toArray: () => rows };
      },
    },
    async setAlarm(t) { storage.alarm = t; },
    async deleteAlarm() { storage.alarm = null; },
    async deleteAll() { db.exec("DROP TABLE IF EXISTS room; DROP TABLE IF EXISTS log"); },
  };
  return { storage, sockets, acceptWebSocket: (ws) => sockets.push(ws), getWebSockets: () => sockets.filter((w) => w.readyState !== 3) };
}
const assets = { ASSETS: { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) } };

async function join(room, ctx, id, name) {
  const ws = new FakeWs(id);
  ctx.acceptWebSocket(ws);
  ws.serializeAttachment({ id });
  await room.connect(ws, id, name);
  return ws;
}
const say = (room, ws, m) => room.webSocketMessage(ws, JSON.stringify(m));

test("VersusRoom hosts a Founders game: start, acts, rejects, resolve with the AI nation, replay, rehydration, done", async () => {
  const ctx = fakeCtx(new DatabaseSync(":memory:"));
  const room = new V.VersusRoom(ctx, assets);
  assert.equal(await room.init({ code: "FDFDFD", game: "founders", turns: 30, bots: 1, map: "near", host: { id: "a", name: "Ann" } }), true);
  assert.deepEqual(await room.status(), { code: "FDFDFD", game: "founders", status: "lobby", turns: 30, map: "near", players: 1, seats: 3 });

  const A = await join(room, ctx, "a", "Ann");
  const lob = A.take("room").at(-1).room;
  assert.equal(lob.game, "founders");
  assert.equal(lob.turn, 1);
  assert.equal(lob.seed, null);
  await say(room, A, { t: "start" });
  const r0 = A.take("room").at(-1).room;
  assert.equal(r0.status, "live");
  assert.equal(typeof r0.seed, "string");
  assert.match(r0.seed, /^\d+$/);
  assert.deepEqual(r0.players.map((p) => [p.name, p.bot]), [["Ann", false], [S.BOT_NATIONS[0], true]]);
  assert.deepEqual(A.take("log"), [{ t: "log", es: [] }]);

  // the "client": the same init the browser builds from the room
  assert.equal(r0.map, "near");
  const init = { seed: r0.seed, turns: r0.turns, map: r0.map, players: r0.players.map(({ name, bot }) => ({ name, bot })) };
  let mine = S.newMatch(env, init);
  const log = [];
  const found = { type: "found", party: mine.players[0].state.parties[0].id };
  await say(room, A, { t: "act", a: found });
  const [en] = A.take("entries");
  assert.deepEqual(en, { t: "entries", i: 0, es: [{ p: 0, a: found }] });
  log.push(...en.es);
  mine = S.applyEntry(env, mine, en.es[0]).m;
  await say(room, A, { t: "act", a: found });
  assert.equal(A.take("reject").length, 1, "the party is gone: founding again is refused");
  await say(room, A, { t: "act", a: { type: "end" } });
  assert.match(A.take("reject")[0].error, /Unknown action "end"/);
  await say(room, A, { t: "act", a: { type: "found", party: 1, extra: 2 } });
  assert.match(A.take("reject")[0].error, /Unexpected field/);
  await say(room, A, { t: "act", a: { type: "improve", cell: 10 ** 9, kind: "farm" } });
  assert.equal(A.take("reject")[0].error, 'Bad "cell"', "cells are checked against env.T.size");
  assert.equal(room.n, 1);

  // a few turns: A readies (alone online, so each ready resolves); the AI nation's entries come first, then {r: 1}
  for (let t = 1; t <= 4; t++) {
    await say(room, A, { t: "ready", on: true });
    const [res] = A.take("entries");
    assert.equal(res.i, log.length);
    assert.deepEqual(res.es.at(-1), { r: 1 });
    assert.ok(res.es.slice(0, -1).every((e) => e.p === 1), "bot entries are the AI seat's");
    if (t === 1) assert.ok(res.es.length > 1, "the AI nation acts in turn one");
    log.push(...res.es);
    for (const e of res.es) {
      const r = S.applyEntry(env, mine, JSON.parse(JSON.stringify(e)));
      assert.equal(r.error, null);
      mine = r.m;
    }
    const rv = A.take("room").at(-1).room;
    assert.equal(rv.turn, t + 1);
    assert.equal(rv.deadline, null);
  }
  const e = await room.envFor();
  assert.equal(S.matchHash(room.game(e)), S.matchHash(mine), "client and room agree");
  const rep = S.replay(env, init, JSON.parse(JSON.stringify(log)));
  assert.equal(rep.error, null);
  assert.equal(S.matchHash(rep.m), S.matchHash(mine));

  // a fresh object (after eviction) rebuilds the same match from storage
  const room2 = new V.VersusRoom(ctx, assets);
  assert.equal(room2.room.game, "founders");
  assert.equal(room2.n, log.length);
  assert.equal(S.matchHash(room2.game(await room2.envFor())), S.matchHash(mine));

  // play out
  while (room.room.status === "live") await say(room, A, { t: "ready", on: true });
  assert.equal(room.room.status, "done");
  assert.equal(room.room.turn, 31);
  await say(room, A, { t: "act", a: found });
  assert.equal(A.take("reject").at(-1).error, "The game is over");
  const full = room.sql.exec("SELECT e FROM log ORDER BY seq").toArray().map((x) => JSON.parse(x.e));
  const fin = S.replay(env, init, full);
  assert.equal(fin.error, null);
  assert.equal(fin.m.over, true);
  assert.equal(S.matchHash(fin.m), S.matchHash(room.game(e)));
});
