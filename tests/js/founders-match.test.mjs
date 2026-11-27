// Founders multiplayer (sim/match.js): starts, land between nations, founding conflicts, resolve, replay, bots, panels.
// node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/founders/sim/index.js";
import { mpSetupHtml, mpStandingsHtml, mpEndHtml, mpHandoffHtml, mpLobbyHtml, mpEndButton, mpShareText } from "../../web/js/games/founders/mppanel.js";

const D = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const world = D("world");
const env = S.makeEnv({ world, resources: D("resources"), hazards: S.buildHazards(D("disasters"), world) });
const two = () => S.newMatch(env, { seed: "m1", turns: 30, players: [{ name: "A" }, { name: "B" }] });
const act = (m, p, a) => {
  const r = S.matchAct(env, m, p, a);
  assert.equal(r.error, null, r.error);
  return r.m;
};
/** Edit one seat's state in place of a real sequence of moves (test setup only). */
const edit = (m, p, fn) => ({ ...m, players: m.players.map((pl, k) => (k === p ? { ...pl, state: fn(S.clone(pl.state)) } : pl)) });
/** A land cell `d` hexes from `c` (walking one direction), not on a peak. */
function cellAt(c, d) {
  for (let dir = 0; dir < 6; dir++) {
    let x = c;
    for (let k = 0; k < d && x >= 0; k++) x = env.map.grid.neighbour(x, dir);
    if (x >= 0 && env.T.land[x] && env.T.relief[x] < 3 && env.map.dist(c, x) === d) return x;
  }
  return -1;
}

test("newMatch: distinct regional starts, seats, rivals, turns; own random streams", () => {
  const m = S.newMatch(env, { seed: "m1", turns: 30, players: [{ name: "A" }, { name: "B" }, { name: "C", bot: true }, { name: "D", bot: true }] });
  assert.equal(new Set(m.players.map((p) => p.start.cell)).size, 4);
  m.players.forEach((pl, k) => {
    assert.equal(pl.state.seat, k);
    assert.equal(pl.state.nations, 4);
    assert.equal(pl.state.maxTurns, 30);
    assert.equal(pl.state.rivals.length, 3);
    assert.equal(pl.state.phase, "play");
  });
  assert.notEqual(m.players[0].state.rng, m.players[1].state.rng);
  assert.deepEqual(S.matchStarts(env, "m1", 4), m.players.map((p) => p.start), "same seed, same starts");
  assert.throws(() => S.newMatch(env, { players: [{ name: "solo" }] }));
});

test("matchAct: no start or end; ordinary actions otherwise", () => {
  let m = two();
  assert.match(S.matchAct(env, m, 0, { type: "end" }).error, /ready/);
  assert.ok(S.matchAct(env, m, 0, { type: "start", cell: 5 }).error);
  assert.equal(S.matchAct(env, m, 9, { type: "found", party: 1 }).error, "No such nation");
  m = act(m, 0, { type: "found", party: m.players[0].state.parties[0].id });
  assert.equal(m.players[0].state.towns.length, 1);
  assert.equal(m.players[1].state.towns.length, 0);
});

test("land: the older town holds shared hexes; no founding on or near rival land", () => {
  let m = two();
  m = act(m, 0, { type: "found", party: m.players[0].state.parties[0].id });
  m = S.resolve(env, m);
  const a = m.players[0].state.towns[0];
  // B's party walks (by edit) to 4 hexes from A's town and founds there a turn later
  const near = cellAt(a.cell, 4);
  assert.ok(near >= 0);
  m = edit(m, 1, (s) => { s.parties[0].cell = near; return s; });
  m = act(m, 1, { type: "found", party: m.players[1].state.parties[0].id });
  m = S.resolve(env, m);
  // both borders grow to radius 3: the hexes within 3 of both belong to A (founded first)
  for (const p of [0, 1]) m = edit(m, p, (s) => { s.towns[0].radius = 3; return s; });
  m = S.resolve(env, m); // resolve informs everyone of the new radii
  const b = m.players[1].state.towns[0];
  const shared = env.map.within(a.cell, 3).filter((c) => env.T.land[c] && env.map.dist(c, b.cell) <= 3 && c !== b.cell);
  assert.ok(shared.length > 0);
  const fB = S.foreignOwners(env, m.players[1].state), ownB = S.owners(env, m.players[1].state);
  const ownA = S.owners(env, m.players[0].state);
  for (const c of shared) {
    assert.equal(fB[c], 1, `hex ${c} is A's (seat 0 + 1) in B's view`);
    assert.equal(ownB[c], 0);
    assert.equal(ownA[c], a.id);
  }
  assert.equal(ownB[b.cell], b.id, "a town always holds its own hex");
  // founding next to (or on) a rival's land is refused with a reason
  const nearA = env.map.within(a.cell, 2).find((c) => env.T.land[c] && env.T.relief[c] < 3 && env.map.dist(c, a.cell) === 2 && env.map.dist(c, b.cell) >= 3);
  assert.match(S.foundBlocker(env, m.players[1].state, nearA), /rival/i);
  // improving a rival-held hex is refused (it is not inside any of B's borders)
  assert.ok(S.improveBlocker(env, { ...m.players[1].state, materials: 999 }, shared[0], "farmstead"));
});

test("same-turn founding conflict: the nation with that turn's priority keeps its town", () => {
  let m = two();
  const a = m.players[0].state.parties[0].cell;
  const close = cellAt(a, 2);
  m = edit(m, 1, (s) => { s.parties[0].cell = close; return s; });
  m = act(m, 0, { type: "found", party: m.players[0].state.parties[0].id });
  m = act(m, 1, { type: "found", party: m.players[1].state.parties[0].id });
  assert.equal(S.conflicts(env, m).length, 1);
  // turn 1 with two nations: seat 1 goes first ((seat − turn) mod 2 = 0)
  const r = S.resolve(env, m);
  assert.equal(r.players[1].state.towns.length, 1);
  assert.equal(r.players[0].state.towns.length, 0);
  assert.equal(r.players[0].state.parties.length, 1, "the party is back");
  assert.equal(r.players[0].state.parties[0].cell, a);
  assert.ok(r.news.some((n) => n.kind === "turnedBack" && n.seat === 0 && n.by === 1));
});

test("replay rebuilds the same match; bots play valid moves; the game ends", () => {
  const init = { seed: "rp", turns: 30, players: [{ name: "A" }, { name: "B", bot: true }, { name: "C", bot: true }] };
  let m = S.newMatch(env, init);
  const log = [];
  const a = { type: "found", party: m.players[0].state.parties[0].id };
  m = act(m, 0, a);
  log.push({ p: 0, a });
  for (let t = 0; t < 8; t++) {
    for (const p of [1, 2]) for (const b of S.botActions(env, m, p)) { m = act(m, p, b); log.push({ p, a: b }); }
    m = S.resolve(env, m);
    log.push({ r: 1 });
  }
  assert.equal(m.turn, 9);
  assert.equal(m.hist.length, 8);
  const r = S.replay(env, init, log);
  assert.equal(r.error, null);
  assert.equal(S.matchHash(r.m), S.matchHash(m));
  const bad = S.replay(env, init, [...log.slice(0, 2), { p: 0, a: { type: "end" } }]);
  assert.equal(bad.at, 2);
  // names are unique across the map
  const names = m.players.flatMap((pl) => pl.state.towns.map((t) => t.name));
  assert.equal(new Set(names).size, names.length);
  // run out the clock
  let e = S.newMatch(env, { seed: "short", turns: 5, players: [{ name: "A" }, { name: "B" }] });
  while (!e.over) e = S.resolve(env, e);
  assert.equal(e.turn, 6);
  assert.ok(e.players.every((pl) => pl.state.phase === "over"));
  assert.equal(S.applyEntry(env, e, { r: 1 }).error, "The game is over");
});

test("matchShapeError", () => {
  const size = env.T.size;
  assert.equal(S.matchShapeError({ type: "found", party: 3 }, size), null);
  assert.equal(S.matchShapeError({ type: "auto", town: "all", on: true }, size), null);
  assert.match(S.matchShapeError({ type: "end" }, size), /Unknown/);
  assert.match(S.matchShapeError({ type: "move", party: 1, to: size }, size), /to/);
  assert.match(S.matchShapeError({ type: "found", party: 1, extra: 1 }, size), /Unexpected/);
  assert.match(S.matchShapeError({ type: "improve", cell: 4, kind: "x".repeat(40) }, size), /kind/);
});

test("solo games are unchanged: no multiplayer fields, solo claims", () => {
  const s = S.newGame(env, "solo", { start: S.startOptions(env, "solo")[0].cell });
  assert.ok(!("rivals" in s) && !("seat" in s));
  assert.equal(S.foreignOwners(env, s).some((x) => x), false);
});

test("multiplayer panels render and escape names", () => {
  let m = S.newMatch(env, { seed: "ui", turns: 30, players: [{ name: "Me <b>" }, { name: "Gulf Union AI", bot: true }] });
  m = act(m, 0, { type: "found", party: m.players[0].state.parties[0].id });
  m = S.resolve(env, m);
  const mp = { mode: "online", m, me: 0, room: { players: [{ ready: true, online: true }, { bot: true }] }, ready: false, waiting: [], deadline: 20_000, now: 0, done: [] };
  const st = mpStandingsHtml(env, mp);
  assert.match(st, /Me &lt;b&gt;/);
  assert.doesNotMatch(st, /Me <b>/);
  assert.match(mpEndButton(mp), /Ready.*20s/);
  assert.match(mpEndButton({ ...mp, ready: true, waiting: ["Bob"] }), /Waiting for Bob/);
  assert.match(mpEndButton({ ...mp, mode: "hot", m: { ...m, players: [{}, { bot: false }] } }), /next player/);
  assert.match(mpHandoffHtml({ ...mp, mode: "hot" }), /Me &lt;b&gt;'s turn/);
  let done = m;
  while (!done.over) done = S.resolve(env, done);
  assert.match(mpEndHtml(env, { ...mp, m: done }), /wins/);
  assert.match(mpShareText(env, { ...mp, m: done }), /Founders multiplayer/);
  assert.match(mpSetupHtml({ online: true, player: null }), /Online room/);
  assert.doesNotMatch(mpSetupHtml({ online: false, player: null }), /Online room/);
  const room = { code: "ABCDEF", status: "lobby", turns: 30, bots: 1, host: "p1", players: [{ id: "p1", name: "Host", online: true }] };
  assert.match(mpLobbyHtml({ code: "ABCDEF", room, player: { id: "p1" } }), /data-act="mpStart"/);
});
