// Mainline versus room (worker/vs.js with the Mainline adapter in worker/games.js): the pure helpers, plus VersusRoom driven with a fake Durable Object context
// (node:sqlite for ctx.storage.sql, fake sockets). node --test tests/js/*.test.mjs, no Workers runtime needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { makeEnv } from "../../web/js/games/mainline/sim/env.js";
import { plan } from "../../web/js/games/mainline/sim/state.js";
import { newVersus, replay, vsHash, BOT_NAMES } from "../../web/js/games/mainline/sim/versus.js";
import { REQUIRED_DATA } from "../../web/js/games/mainline/sim/verify.js";

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
const data = Object.fromEntries(REQUIRED_DATA.map((n) => [n, JSON.parse(readFileSync(dataUrl(n)))]));
const texas = makeEnv(data, "texas");

const lobby = (over = {}) => ({ ...V.newRoom({ code: "ABCDEF", scenario: "texas", home: null, years: 10, bots: 1, host: { id: "a", name: "Ann" } }, 1000), ...over });

/** A valid first build for a player state: home → the cheapest affordable contract end. */
function firstBuild(env, state) {
  let best = null;
  for (const c of env.contracts) {
    for (const end of [c.a, c.b]) {
      if (env.homeCells.has(end.cell)) continue;
      const r = plan(env, state, env.home.cell, end.cell, { maxCost: state.cash });
      if (r.path && !r.error && (!best || r.cost < best.cost)) best = r;
    }
  }
  return { type: "build", path: best.path };
}

test("body validation", () => {
  assert.deepEqual(V.cleanVsBody({ scenario: "texas", years: 10, bots: 1 }), { scenario: "texas", home: null, years: 10, bots: 1 });
  assert.deepEqual(V.cleanVsBody({ scenario: "texas", home: "26420", years: 25, bots: 0 }), { scenario: "texas", home: null, years: 25, bots: 0 });
  assert.ok(V.cleanVsBody({ scenario: "texas", home: "16980", years: 10, bots: 0 }).error, "a fixed home cannot be changed");
  assert.deepEqual(V.cleanVsBody({ scenario: "sandbox", home: "38060", years: 10, bots: 3 }), { scenario: "sandbox", home: "38060", years: 10, bots: 3 });
  assert.ok(V.cleanVsBody({ scenario: "sandbox", years: 10, bots: 0 }).error, "sandbox needs a home");
  assert.ok(V.cleanVsBody({ scenario: "sandbox", home: 38060, years: 10, bots: 0 }).error);
  assert.ok(V.cleanVsBody({ scenario: "mars", years: 10, bots: 0 }).error);
  assert.ok(V.cleanVsBody({ scenario: "texas", years: 12, bots: 0 }).error);
  assert.ok(V.cleanVsBody({ scenario: "texas", years: 10, bots: 4 }).error);
  assert.ok(V.cleanVsBody({ scenario: "texas", years: 10, bots: 1.5 }).error);
  assert.ok(V.cleanVsBody({ scenario: "texas", years: 10 }).error);
  assert.ok(V.cleanVsBody(null).error);
  assert.ok(V.cleanVsBody([]).error);
});

test("joining, seats and starting", () => {
  const r = lobby();
  assert.deepEqual(V.joinCheck(r, "a"), { seat: r.players[0] });
  assert.deepEqual(V.joinCheck(r, "b"), { join: true });
  r.players.push({ id: "b", name: "Bo", bot: false }, { id: "c", name: "Cy", bot: false });
  assert.match(V.joinCheck(r, "d").refusal, /full \(3 people\)/, "4 − bots seats for people");
  assert.equal(V.statusView(r).players, 3);
  assert.equal(V.statusView(r).seats, 3);
  assert.equal(V.startError(r, "b"), "Only the host can start");
  assert.equal(V.startError(r, "a"), null);
  r.players = V.seatPlayers(r);
  assert.deepEqual(r.players.map((p) => [p.id, p.name, !!p.bot]), [["a", "Ann", false], ["b", "Bo", false], ["c", "Cy", false], [null, BOT_NAMES[0], true]]);
  r.status = "live";
  assert.equal(V.seatOf(r, "c"), 2);
  assert.equal(V.seatOf(r, "zz"), -1);
  assert.match(V.joinCheck(r, "d").refusal, /already started/);
  assert.ok(V.joinCheck(r, "b").seat, "seated players reconnect");
  assert.equal(V.startError(r, "a"), "Already started");

  assert.equal(V.startError(lobby({ bots: 0 }), "a").startsWith("A game needs at least 2"), true, "one person alone cannot start");
  assert.equal(V.startError(lobby({ bots: 1 }), "a"), null, "one person plus one bot is fine");
});

test("seeds, entry room and the act rate window", () => {
  for (const u of [0, 1, 0x7ffffffd, 0x7ffffffe, 0xffffffff]) {
    const s = V.newSeed(u);
    assert.ok(Number.isInteger(s) && s >= 1 && s <= 0x7fffffff, `${u} → ${s}`);
  }
  const left = (year, years) => G.mainline.resolvesLeft({ year, years });
  assert.equal(V.entryRoom(0, left(2026, 10)), V.VS_MAX_ENTRIES - 10, "one slot kept per resolve to come");
  assert.equal(V.entryRoom(100, left(2035, 10)), V.VS_MAX_ENTRIES - 101);
  assert.equal(V.entryRoom(V.VS_MAX_ENTRIES - 1, left(2035, 10)), 0, "the last resolve still fits");
  assert.equal(V.entryRoom(V.VS_MAX_ENTRIES, left(2036, 10)), 0, "after the game nothing is reserved");

  const b = { t: 0, n: 0 };
  let ok = 0;
  for (let k = 0; k < 40; k++) ok += V.allowAct(b, 5000 + k) ? 1 : 0;
  assert.equal(ok, V.VS_ACTS_PER_SEC);
  assert.equal(V.allowAct(b, 6000), true, "a new second, a new window");
});

test("ready, deadline and when a year resolves", () => {
  const r = lobby({ status: "live" });
  r.players = V.seatPlayers({ ...r, players: [...r.players, { id: "b", name: "Bo" }], bots: 1 });
  const [a, b] = r.players;
  const both = new Set(["a", "b"]);
  assert.equal(V.shouldResolve(r, both, 0), false);
  V.setReady(r, a, true, 10_000);
  assert.equal(r.deadline, 10_000 + V.VS_DEADLINE_MS, "the first ready starts the clock");
  V.setReady(r, a, false, 20_000);
  V.setReady(r, a, true, 30_000);
  assert.equal(r.deadline, 10_000 + V.VS_DEADLINE_MS, "the clock is not restarted");
  assert.equal(V.shouldResolve(r, both, 50_000), false, "b is online and not ready");
  assert.equal(V.shouldResolve(r, new Set(["a"]), 50_000), true, "offline people count as ready");
  assert.equal(V.shouldResolve(r, new Set(), 50_000), false, "nobody online: nothing resolves");
  assert.equal(V.shouldResolve(r, new Set(), r.deadline + 1), false, "not even at the deadline");
  assert.equal(V.shouldResolve(r, both, r.deadline), true, "the deadline resolves");
  V.setReady(r, b, true, 60_000);
  assert.equal(V.shouldResolve(r, both, 60_000), true, "everyone ready");
  assert.equal(V.shouldResolve({ ...r, status: "done" }, both, 60_000), false);
  assert.equal(V.shouldResolve({ ...r, status: "lobby" }, both, 60_000), false);
});

test("one alarm slot: the earliest of a deadline still ahead and the forget time", () => {
  const r = lobby({ status: "live", lastActivity: 1000 });
  assert.equal(V.nextAlarm(r, 2000), 1000 + V.VS_FORGET_MS);
  r.deadline = 5000;
  assert.equal(V.nextAlarm(r, 2000), 5000);
  assert.equal(V.nextAlarm(r, 6000), 1000 + V.VS_FORGET_MS, "a passed deadline (everyone away) does not loop the alarm");
  assert.equal(V.nextAlarm({ ...r, status: "done" }, 2000), 1000 + V.VS_FORGET_MS);
});

test("room view: seed hidden in the lobby, bots always online and ready", () => {
  const r = lobby({ seed: 77 });
  assert.equal(V.roomView(r, new Set(["a"])).seed, null);
  r.status = "live";
  r.players = V.seatPlayers(r);
  const v = V.roomView(r, new Set());
  assert.equal(v.seed, 77);
  assert.deepEqual(v.players, [
    { id: "a", name: "Ann", bot: false, online: false, ready: false },
    { id: null, name: BOT_NAMES[0], bot: true, online: true, ready: true },
  ]);
  assert.equal(v.game, "mainline");
  for (const k of ["code", "game", "status", "scenario", "home", "years", "bots", "seed", "host", "year", "deadline", "players"]) assert.ok(k in v, k);
});

test("resolveEntries: bot actions in seat order, then {r: 1}; the entries replay to the same game", () => {
  const init = { seed: 9, years: 10, players: [{ name: "Ann", bot: false }, { name: BOT_NAMES[0], bot: true }, { name: BOT_NAMES[1], bot: true }] };
  const vs0 = newVersus(texas, init);
  const { g: vs, es } = V.resolveEntries(G.mainline, texas, vs0);
  assert.deepEqual(es.at(-1), { r: 1 });
  assert.equal(vs.year, 2027);
  const seats = es.slice(0, -1).map((e) => e.p);
  assert.ok(seats.length > 0, "the bots build something in year one");
  assert.ok(seats.every((p) => p === 1 || p === 2));
  assert.deepEqual(seats, [...seats].sort(), "seat order");
  const rep = replay(texas, init, JSON.parse(JSON.stringify(es)));
  assert.equal(rep.error, null);
  assert.equal(vsHash(rep.vs), vsHash(vs));
  // with no room for bot entries only the resolve is logged
  const tight = V.resolveEntries(G.mainline, texas, vs0, 0);
  assert.deepEqual(tight.es, [{ r: 1 }]);
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

test("VersusRoom: lobby → live → resolve, rejects, late joiners, rehydration after eviction, deadline, done", async () => {
  const db = new DatabaseSync(":memory:");
  const ctx = fakeCtx(db);
  const room = new V.VersusRoom(ctx, assets);
  assert.equal(await room.init({ code: "ABCDEF", scenario: "texas", home: null, years: 10, bots: 1, host: { id: "a", name: "Ann" } }), true);
  assert.equal(await room.init({ code: "ABCDEF", scenario: "texas", home: null, years: 10, bots: 1, host: { id: "x", name: "X" } }), false);
  assert.deepEqual(await room.status(), { code: "ABCDEF", game: "mainline", status: "lobby", scenario: "texas", home: null, years: 10, players: 1, seats: 3 });

  const A = await join(room, ctx, "a", "Ann");
  const B = await join(room, ctx, "b", "Bo");
  assert.deepEqual(A.take("room").at(-1).room.players.map((p) => [p.id, p.online]), [["a", true], ["b", true]]);
  await say(room, B, { t: "start" });
  assert.equal(B.take("error")[0].error, "Only the host can start");
  await say(room, A, { t: "start" });
  const r0 = A.take("room").at(-1).room;
  assert.equal(r0.status, "live");
  assert.ok(Number.isInteger(r0.seed) && r0.seed > 0);
  assert.deepEqual(r0.players.map((p) => p.name), ["Ann", "Bo", BOT_NAMES[0]]);
  assert.deepEqual(B.take("log"), [{ t: "log", es: [] }]);

  const C = await join(room, ctx, "c", "Cy");
  assert.equal(C.closeCode, 4001);
  assert.match(C.take("error")[0].error, /already started/);

  // valid builds from both people
  const init = { seed: r0.seed, years: 10, players: r0.players.map(({ name, bot }) => ({ name, bot })) };
  const mine = newVersus(texas, init);
  const buildA = firstBuild(texas, mine.players[0].state);
  await say(room, A, { t: "act", a: buildA });
  assert.deepEqual(B.take("entries"), [{ t: "entries", i: 0, es: [{ p: 0, a: buildA }] }]);
  assert.equal(A.take("entries").length, 1, "the sender gets its own entry too");
  await say(room, B, { t: "act", a: buildA }); // B's own network is empty, so the same path is valid for B
  assert.deepEqual(A.take("entries"), [{ t: "entries", i: 1, es: [{ p: 1, a: buildA }] }]);
  B.take("entries");
  await say(room, A, { t: "act", a: buildA });
  assert.deepEqual(A.take("reject"), [{ t: "reject", error: "Already built", i: 2 }]);
  assert.deepEqual(B.take("reject"), [], "a reject goes to the sender only");
  await say(room, A, { t: "act", a: { type: "build", path: [-1, 3] } });
  assert.equal(A.take("reject")[0].error, "Bad path");
  await say(room, A, { t: "act", a: { type: "endTurn" } });
  assert.match(A.take("reject")[0].error, /every company is ready/);

  // ready: the first one starts the deadline; the second resolves
  await say(room, A, { t: "ready", on: true });
  const rr = A.take("room").at(-1).room;
  assert.ok(rr.deadline > Date.now());
  assert.equal(ctx.storage.alarm, rr.deadline, "the alarm is the deadline");
  assert.equal(A.take("entries").length, 0);
  await say(room, B, { t: "ready", on: true });
  const [res] = B.take("entries");
  assert.equal(res.i, 2);
  assert.deepEqual(res.es.at(-1), { r: 1 });
  assert.ok(res.es.slice(0, -1).every((e) => e.p === 2), "bot entries are the bot seat's");
  const r1 = B.take("room").at(-1).room;
  assert.equal(r1.year, 2027);
  assert.equal(r1.deadline, null);
  assert.ok(r1.players.filter((p) => !p.bot).every((p) => !p.ready));

  // the clients' replay matches the room's game, and a fresh object (after eviction) rebuilds the same game
  const log = [{ p: 0, a: buildA }, { p: 1, a: buildA }, ...res.es];
  const local = replay(texas, init, log);
  assert.equal(local.error, null);
  const e = await room.envFor();
  assert.equal(vsHash(room.game(e)), vsHash(local.vs));
  const room2 = new V.VersusRoom(ctx, assets);
  assert.equal(room2.n, log.length);
  assert.equal(vsHash(room2.game(e)), vsHash(local.vs));

  // sync returns the full log
  await say(room, A, { t: "sync" });
  assert.deepEqual(A.take("log").at(-1).es, JSON.parse(JSON.stringify(log)));

  // rate limit: 30 acts a second per socket
  const before = room.n;
  for (let k = 0; k < 35; k++) await say(room, B, { t: "act", a: { type: "repair", key: "1-2" } });
  const rej = B.take("reject");
  assert.equal(rej.length, 35);
  assert.ok(rej.slice(V.VS_ACTS_PER_SEC).every((m) => m.error === "Too many actions, slow down"));
  assert.equal(room.n, before);

  // deadline: only A readies, the alarm fires after the deadline
  await say(room, A, { t: "ready", on: true });
  room.room.deadline = Date.now() - 1;
  await room.alarm();
  assert.deepEqual(A.take("entries")[0].es.at(-1), { r: 1 });
  assert.equal(room.room.year, 2028);

  // everyone away: a passed deadline waits until someone comes back
  await say(room, A, { t: "ready", on: true });
  for (const ws of [A, B]) { ws.close(1000); await room.webSocketClose(ws, 1000, ""); }
  room.room.deadline = Date.now() - 1;
  await room.alarm();
  assert.equal(room.room.year, 2028, "nothing resolves with everyone offline");
  assert.equal(ctx.storage.alarm, room.room.lastActivity + V.VS_FORGET_MS);
  const A2 = await join(room, ctx, "a", "Ann");
  assert.equal(A2.take("log").length, 1, "the full log on reconnect");
  assert.equal(room.room.year, 2029, "the overdue year resolves when someone returns");

  // play out: A alone online, so every ready resolves
  while (room.room.status === "live") await say(room, A2, { t: "ready", on: true });
  assert.equal(room.room.status, "done");
  assert.equal(room.room.year, 2036);
  await say(room, A2, { t: "act", a: buildA });
  assert.equal(A2.take("reject").at(-1).error, "The game is over");
  const full = room.sql.exec("SELECT e FROM log ORDER BY seq").toArray().map((x) => JSON.parse(x.e));
  const fin = replay(texas, init, full);
  assert.equal(fin.error, null);
  assert.equal(fin.vs.over, true);

  // forget after 2 hours of no activity
  room.room.lastActivity = Date.now() - V.VS_FORGET_MS - 1;
  await room.alarm();
  assert.equal(room.room, null);
  assert.equal(await room.status(), null);
  assert.equal(A2.closeCode, 4004);
});

test("VersusRoom lobby: leavers give their seat back, the host keeps the room, the room fills up", async () => {
  const ctx = fakeCtx(new DatabaseSync(":memory:"));
  const room = new V.VersusRoom(ctx, assets);
  await room.init({ code: "ABCDEF", scenario: "texas", home: null, years: 10, bots: 2, host: { id: "a", name: "Ann" } });
  const A = await join(room, ctx, "a", "Ann");
  const B = await join(room, ctx, "b", "Bo");
  const C = await join(room, ctx, "c", "Cy");
  assert.equal(C.closeCode, 4001, "two people + two bots fill the room");
  B.close(1000);
  await room.webSocketClose(B, 1000, "");
  assert.deepEqual(room.room.players.map((p) => p.id), ["a"]);
  A.close(1000);
  await room.webSocketClose(A, 1000, "");
  assert.deepEqual(room.room.players.map((p) => p.id), ["a"], "the host keeps the seat");
  const C2 = await join(room, ctx, "c", "Cy");
  assert.equal(C2.closeCode, undefined);
  await say(room, C2, { t: "start" });
  assert.equal(C2.take("error")[0].error, "Only the host can start");
});
