// Races for Pinpoint, Metro Duel and Road Trip: RaceRoom (worker/race.js) with the game scorers in
// worker/racegames.js, driven with a fake Durable Object context and fake sockets. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import * as P from "../../web/js/games/pinpoint/sim/rounds.js";
import * as D from "../../web/js/games/duel/sim/duel.js";
import * as T from "../../web/js/games/trip/sim/trip.js";
import { makeHexMap } from "../../web/js/games/shared/hexmap.js";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}", shortCircuit: true };
    return next(spec, ctx);
  },
});
const { RaceRoom } = await import("../../worker/race.js");
const { cleanRaceProgress } = await import("../../worker/racegames.js");

const dataUrl = (n) => new URL(`../../web/data/${n}.json`, import.meta.url);
const Dt = (n) => JSON.parse(readFileSync(dataUrl(n)));
const env = { ASSETS: { fetch: async (req) => new Response(readFileSync(dataUrl(new URL(req.url).pathname.match(/\/data\/(\w+)\.json/)[1]))) } };

class FakeWs {
  constructor() { this.readyState = 1; this.sent = []; this.att = null; }
  send(m) { this.sent.push(JSON.parse(m)); }
  close(code) { this.readyState = 3; this.closeCode = code; }
  serializeAttachment(a) { this.att = a; }
  deserializeAttachment() { return this.att; }
  last() { return [...this.sent].reverse().find((m) => m.t === "room")?.room; }
  errors() { return this.sent.filter((m) => m.t === "error").map((m) => m.error); }
}
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const sockets = [];
  const storage = {
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows }; } },
    async setAlarm() {}, async deleteAlarm() {}, async deleteAll() {},
  };
  return { storage, acceptWebSocket: (ws) => sockets.push(ws), getWebSockets: () => sockets.filter((w) => w.readyState !== 3) };
}
async function room(game) {
  const ctx = fakeCtx();
  const r = new RaceRoom(ctx, env);
  assert.equal(await r.init({ code: "RACE22", seed: "abc123", host: { id: "a", name: "Ann" }, game }), true);
  const sock = (id, name) => {
    if (!r.room.players.some((p) => p.id === id)) r.room.players.push({ id, name, joinedAt: Date.now(), round: 0, clues: 0, score: 0, done: false, place: null, finishedAt: null });
    const ws = new FakeWs();
    ws.serializeAttachment({ id });
    ctx.acceptWebSocket(ws);
    return ws;
  };
  const say = (ws, m) => r.webSocketMessage(ws, JSON.stringify(m));
  return { r, sock, say };
}

test("status and view carry the game", async () => {
  const { r } = await room("duel");
  assert.equal((await r.status()).game, "duel");
  assert.equal(r.view().game, "duel");
  assert.equal(r.view().seed, null, "no seed in the lobby");
});

test("Pinpoint race: the room scores the guesses, partial finishes count, places by score", async () => {
  const { r, sock, say } = await room("pinpoint");
  const A = sock("a", "Ann"), B = sock("b", "Bob");
  await say(A, { t: "start" });
  assert.equal(r.room.status, "live");
  const grid = makeHexMap(Dt("world")).grid;
  const pool = P.buildPool({ cities: Dt("cities"), resources: Dt("resources"), wonders: Dt("wonders"), infrastructure: Dt("infrastructure") }, grid);
  const rounds = P.roundsFor(pool, "pinpoint-practice:abc123");
  await say(B, { t: "progress", round: 3, score: 2500 });
  assert.equal(r.room.players[1].score, 2500);
  await say(B, { t: "progress", round: 99, score: 1 }); // out of bounds: ignored
  await say(A, { t: "finish", guesses: rounds.map((p) => p.cell) });
  assert.equal(r.room.players[0].score, 8000);
  assert.equal(r.room.players[0].place, 1);
  await say(B, { t: "finish", guesses: rounds.slice(0, 4).map((p) => p.cell) });
  assert.equal(r.room.players[1].score, 4000);
  assert.equal(r.room.status, "done");
  assert.deepEqual(A.last().players.map((p) => [p.name, p.score, p.place]), [["Ann", 8000, 1], ["Bob", 4000, 2]]);
  await say(A, { t: "finish", guesses: [1] });
  assert.match(A.errors().at(-1), /over|already/);
});

test("Duel and Road Trip races score streaks and routes", async () => {
  {
    const { r, sock, say } = await room("duel");
    const A = sock("a", "Ann");
    await say(A, { t: "start" });
    const seq = D.duelSequence(D.duelPool(Dt("cities")), "duel-practice:abc123", 400);
    await say(A, { t: "finish", answers: [...seq.slice(0, 9).map((d) => d.higher), !seq[9].higher] });
    assert.equal(r.room.players[0].score, 9);
    assert.equal(r.room.status, "done");
  }
  {
    const { r, sock, say } = await room("trip");
    const A = sock("a", "Ann"), B = sock("b", "Bob");
    await say(A, { t: "start" });
    const trip = T.tripFor(T.tripPool(Dt("cities")), "trip-practice:abc123");
    await say(A, { t: "finish", order: ["nope"] });
    assert.equal(r.room.players[0].score, 0, "an unfinished route scores 0");
    await say(B, { t: "finish", order: trip.best.order });
    assert.equal(r.room.players[1].score, 1000);
    assert.equal(r.room.players[1].place, 1);
  }
  assert.deepEqual(cleanRaceProgress("trip", { round: 3, score: 0 }), { round: 3, clues: 0, score: 0 });
  assert.equal(cleanRaceProgress("trip", { round: 7, score: 0 }), null);
  assert.equal(cleanRaceProgress("whichMetro", { round: 1, score: 1 }), null);
});
