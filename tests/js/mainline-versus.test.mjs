// Mainline versus (sim/versus.js): claims, rivals, resolve, replay, bots, and the versus panels.
// node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { REQUIRED_DATA } from "../../web/js/games/mainline/sim/verify.js";
import { gameHtml } from "../../web/js/games/mainline/panel.js";
import { vsEndHtml, vsLobbyHtml, vsPickerHtml, vsShareText } from "../../web/js/games/mainline/vspanel.js";

const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const data = Object.fromEntries(REQUIRED_DATA.map((n) => [n, R(n)]));
const env = S.makeEnv(data, "texas");
const city = (prefix) => env.cities.find((c) => c.name.startsWith(prefix));
const two = (opts = {}) => S.newVersus(env, { seed: 3, years: 10, players: [{ name: "A" }, { name: "B" }], ...opts });
const route = (vs, p, from, to) => S.plan(env, vs.players[p].state, from, to).path;
const act = (vs, p, a) => {
  const r = S.vsAct(env, vs, p, a);
  assert.equal(r.error, null, r.error);
  return r.vs;
};
const DAL = "m19100-26420"; // Dallas ↔ Houston (model contract)

test("newVersus: seats, same start, end year, empty claims", () => {
  const vs = two();
  assert.equal(vs.players.length, 2);
  assert.equal(vs.end, 2035);
  assert.equal(vs.players[0].state.cash, vs.players[1].state.cash);
  assert.deepEqual(vs.claims, {});
  assert.throws(() => S.newVersus(env, { players: [{ name: "solo" }] }));
  assert.throws(() => S.newVersus(env, { players: Array.from({ length: 5 }, () => ({ name: "x" })) }));
  assert.equal(S.newVersus(env, { players: [{ name: "a" }, { name: "b" }], years: 25 }).end, 2050);
});

test("vsCheck: no End turn as an action; ordinary rules otherwise", () => {
  const vs = two();
  assert.match(S.vsCheck(env, vs, 0, { type: "endTurn" }), /ready/);
  assert.equal(S.vsCheck(env, vs, 5, { type: "undo" }), "No such player");
  assert.match(S.vsCheck(env, vs, 0, { type: "undo" }), /Nothing to undo/);
});

test("first to serve takes the contract; a rival-held contract pays the holder only", () => {
  let vs = two();
  vs = act(vs, 0, { type: "build", path: route(vs, 0, env.home.cell, city("Dallas").cell) });
  vs = S.vsResolve(env, vs);
  assert.equal(vs.claims[DAL], 0);
  assert.ok(vs.news.some((n) => n.id === DAL && n.to === 0 && n.why === "first"));
  // B now builds the same corridor: it is held, so B's network does not serve it or earn from it
  vs = act(vs, 1, { type: "build", path: route(vs, 1, env.home.cell, city("Dallas").cell) });
  assert.equal(vs.players[1].state.rivals[DAL], 1);
  assert.ok(!S.evaluate(env, vs.players[1].state).served.has(DAL));
  assert.ok(S.evaluate(env, vs.players[0].state).served.has(DAL));
  vs = S.vsResolve(env, vs);
  assert.equal(vs.claims[DAL], 0, "a holder that still serves keeps it");
});

test("contested in the same year: the shorter route wins; a tie goes to the lower seat", () => {
  let vs = two();
  const H = env.home.cell, D = city("Dallas").cell;
  const direct = route(vs, 1, H, D);
  const hm = env.hexmap;
  const mid = direct[Math.floor(direct.length / 2)];
  const X = hm.grid.neighbour(hm.grid.neighbour(hm.grid.neighbour(mid, 5), 5), 5); // three hexes off the direct line (346 km vs 303)
  vs = act(vs, 1, { type: "build", path: direct }); // B direct
  vs = act(vs, 0, { type: "build", path: route(vs, 0, H, X) }); // A with a detour: longer
  vs = act(vs, 0, { type: "build", path: route(vs, 0, X, D) });
  const r = S.vsResolve(env, vs);
  assert.equal(r.claims[DAL], 1);
  assert.equal(r.news.find((n) => n.id === DAL).why, "contested");
  // identical routes: seat 0 wins
  let t = two();
  t = act(t, 0, { type: "build", path: route(t, 0, H, D) });
  t = act(t, 1, { type: "build", path: route(t, 1, H, D) });
  assert.equal(S.vsResolve(env, t).claims[DAL], 0);
});

test("a cut route loses the contract to a rival that serves it; with no rival the claim stays", () => {
  const H = env.home.cell, D = city("Dallas").cell;
  let vs = two();
  vs = act(vs, 0, { type: "build", path: route(vs, 0, H, D) });
  vs = S.vsResolve(env, vs);
  const cut = (v) => {
    const s = v.players[0].state;
    const links = Object.fromEntries(Object.entries(s.links).map(([k, l]) => [k, { ...l, d: 1 }]));
    return { ...v, players: v.players.map((pl, k) => (k === 0 ? { ...pl, state: { ...s, links } } : pl)) };
  };
  // nobody else serves it: A keeps the (dormant) claim
  assert.equal(S.settle(env, cut(vs)).claims[DAL], 0);
  // B serves it while A's line is down: B takes it
  let v2 = act(vs, 1, { type: "build", path: route(vs, 1, H, D) });
  const st = S.settle(env, cut(v2));
  assert.equal(st.claims[DAL], 1);
  assert.equal(st.news.find((n) => n.id === DAL).why, "lapsed");
});

test("replay rebuilds the same game; the game ends after the last year", () => {
  const init = { seed: 9, years: 10, players: [{ name: "A" }, { name: "B", bot: true }, { name: "C", bot: true }] };
  let vs = S.newVersus(env, init);
  const log = [];
  const H = env.home.cell;
  const a = { type: "build", path: route(vs, 0, H, city("Dallas").cell) };
  vs = act(vs, 0, a);
  log.push({ p: 0, a });
  while (!vs.over) {
    for (const p of [1, 2]) for (const b of S.botActions(env, vs, p)) { vs = act(vs, p, b); log.push({ p, a: b }); }
    vs = S.vsResolve(env, vs);
    log.push({ r: 1 });
  }
  assert.equal(vs.year, 2036);
  assert.ok(vs.players.every((pl) => pl.state.over));
  assert.equal(vs.hist.length, 10);
  const r = S.vsReplay(env, init, log);
  assert.equal(r.error, null);
  assert.equal(S.vsHash(r.vs), S.vsHash(vs));
  assert.match(S.vsCheck(env, vs, 0, { type: "undo" }), /over/);
  assert.equal(S.applyEntry(env, vs, { r: 1 }).error, "The game is over");
  // a bad entry stops the replay where it is
  const bad = S.vsReplay(env, init, [...log.slice(0, 3), { p: 0, a: { type: "endTurn" } }]);
  assert.equal(bad.at, 3);
  // bots spread out instead of racing for the same contracts
  const rows = S.standings(env, vs);
  assert.ok(rows.filter((x) => x.held > 0).length >= 2, JSON.stringify(rows));
  assert.deepEqual(rows.map((x) => x.rank), [1, 2, 3]);
});

test("solo states carry no versus fields (saves and replay hashes unchanged)", () => {
  const s = S.newGame(env, { seed: 1 });
  assert.ok(!("rivals" in s) && !("end" in s));
  const e = S.greedyTurn(env, s);
  assert.ok(!("rivals" in e) && !("end" in e));
});

test("versus panels render", () => {
  let vs = two({ players: [{ name: "Me <b>" }, { name: "Gulf & Plains AI", bot: true }] });
  vs = act(vs, 0, { type: "build", path: route(vs, 0, env.home.cell, city("Dallas").cell) });
  vs = S.vsResolve(env, vs);
  const state = vs.players[0].state;
  const m = {
    env, state, ev: S.evaluate(env, state), sum: S.summary(env, state), sel: { start: null, end: null, plan: null }, touch: false,
    ui: { tab: "open", showDemand: true, trains: true, sound: false, motion: true, coach: null, help: false, link: null, highlight: null },
    vs: { mode: "ai", vs, me: 0, room: null, ready: false, waiting: [], deadline: null, now: 0 }, cityName: (id) => id,
  };
  const html = gameHtml(m);
  assert.match(html, /turn 2 of 10/);
  assert.match(html, /Me &lt;b&gt;/);
  assert.match(html, /You took Dallas ↔ Houston/);
  assert.match(html, /data-act="vsLeave"/);
  assert.doesNotMatch(html, /Me <b>/);
  m.vs.mode = "online";
  m.vs.ready = true;
  m.vs.waiting = ["Bob"];
  m.vs.deadline = 30_000;
  assert.match(gameHtml(m), /Waiting for Bob \(30s\)/);
  let done = vs;
  while (!done.over) done = S.vsResolve(env, done);
  const end = vsEndHtml({ ...m, vs: { ...m.vs, vs: done, mode: "ai" } });
  assert.match(end, /wins/);
  assert.match(end, /<polyline/);
  assert.match(vsShareText({ env, vs: { vs: done, me: 0 } }), /Mainline versus: Texas Triangle/);
  assert.match(vsPickerHtml({ online: true, player: null }), /Online room/);
  assert.doesNotMatch(vsPickerHtml({ online: false, player: null }), /Online room/);
  const room = { code: "ABCDEF", status: "lobby", scenario: "texas", home: null, years: 10, bots: 1, host: "p1", players: [{ id: "p1", name: "Host", online: true }] };
  const lobby = vsLobbyHtml({ vs: { mode: "online", code: "ABCDEF", room, player: { id: "p1" } }, cityName: (id) => id });
  assert.match(lobby, /data-act="vsStart"/);
  assert.match(lobby, /vs-ABCDEF/);
});
