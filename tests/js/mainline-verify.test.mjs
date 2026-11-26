// Mainline run verification (sim/verify.js, used by the Worker) and the browser's action log (runlog.js).
// node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/mainline/sim/index.js";
import { verifyRun, REQUIRED_DATA, MAX_LOG, shapeError } from "../../web/js/games/mainline/sim/verify.js";
import { record, packSave, unpackSave } from "../../web/js/games/mainline/runlog.js";
import { boardHtml, boardsHtml, endHtml, pickerHtml } from "../../web/js/games/mainline/panel.js";

const R = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const data = Object.fromEntries(REQUIRED_DATA.map((n) => [n, R(n)]));
const envs = new Map();
const env = (id, home) => {
  const k = `${id}:${home || ""}`;
  if (!envs.has(k)) envs.set(k, S.makeEnv(data, id, { home }));
  return envs.get(k);
};
const botRun = (id, seed, home = null) => {
  const e = env(id, home);
  const log = [];
  let s = S.newGame(e, { seed });
  while (!s.over) s = S.greedyTurn(e, s, { log });
  return { e, s, log, run: { scenario: id, seed, home, log } };
};

test("REQUIRED_DATA is what index.js loads for makeEnv", () => {
  assert.deepEqual([...REQUIRED_DATA].sort(), ["cities", "disasters", "infrastructure", "trade", "world"]);
  const src = readFileSync(new URL("../../web/js/games/mainline/index.js", import.meta.url), "utf8");
  for (const n of REQUIRED_DATA) assert.match(src, new RegExp(`\\b${n}\\b`), `index.js passes ${n}`);
});

test("a bot run verifies with the uplift, hash and score the sim reports", () => {
  for (const [id, home] of [["texas"], ["sandbox", "38060"]]) {
    const { e, s, run } = botRun(id, 5, home);
    const sum = S.summary(e, s);
    const v = verifyRun(data, JSON.parse(JSON.stringify(run))); // JSON round trip, as it travels to the Worker
    assert.equal(v.ok, true, v.error);
    assert.equal(v.uplift, sum.uplift);
    assert.equal(v.beat, sum.beat);
    assert.equal(v.score, sum.score);
    assert.equal(v.year, 2050);
    assert.equal(v.hash, S.stateHash(s));
  }
});

test("verifyRun rejects tampered logs", () => {
  const { e, log, run } = botRun("rust", 9);
  const at = (l) => verifyRun(data, { ...run, log: l });
  // truncated: the game does not reach 2050
  const short = at(log.slice(0, -1));
  assert.equal(short.ok, false);
  assert.match(short.error, /not finished/);
  assert.equal(short.uplift, null);
  // an action the cash cannot pay for: a build on the first turn, with the price of the whole region
  const b = log.findIndex((a) => a.type === "build");
  const rich = log.slice();
  const s0 = S.newGame(e, { seed: 9 });
  const far = [...e.cities].sort((p, q) => e.km(e.home.cell, q.cell) - e.km(e.home.cell, p.cell))[0];
  const p = S.plan(e, s0, e.home.cell, far.cell);
  assert.ok(p.path && p.cost > s0.cash, "a route dearer than the start cash");
  rich.splice(b, 0, { type: "build", path: p.path });
  const poor = at(rich);
  assert.equal(poor.ok, false);
  assert.match(poor.error, /Not enough money/);
  assert.equal(poor.at, b);
  // unknown type, extra fields, bad shapes
  assert.match(at([{ type: "teleport" }, ...log]).error, /Unknown action "teleport"/);
  assert.match(at([{ type: "endTurn", cash: 1e9 }, ...log]).error, /Unexpected field "cash"/);
  assert.match(at([{ type: "build", path: [1, "2"] }, ...log]).error, /Bad path/);
  assert.match(at([{ type: "build", path: [-1, 5] }, ...log]).error, /Bad path/);
  assert.match(at([null, ...log]).error, /Not an action/);
  assert.match(at([{ type: "harden", key: "1-2", hz: "aliens" }, ...log]).error, /Bad hazard/);
  // an action after the end of the game
  assert.match(at([...log, { type: "endTurn" }]).error, /game is over/);
  // too long, wrong seed, wrong home, not a log
  assert.match(at(new Array(MAX_LOG + 1).fill({ type: "undo" })).error, /too long/);
  assert.equal(verifyRun(data, { ...run, seed: 10 }).ok, false, "the same moves on another seed");
  assert.match(verifyRun(data, { ...run, seed: -1 }).error, /Bad seed/);
  assert.match(verifyRun(data, { ...run, scenario: "mars" }).error, /Unknown scenario/);
  assert.match(verifyRun(data, { ...run, home: "19100" }).error, /fixed home/);
  assert.match(verifyRun(data, { ...run, log: "x" }).error, /No action log/);
  assert.match(verifyRun(data, { scenario: "sandbox", seed: 1, home: null, log: [] }).error, /home metro/);
  assert.match(verifyRun(data, { scenario: "sandbox", seed: 1, home: "00000", log: [] }).error, /Unknown home/);
  assert.match(verifyRun({ ...data, trade: null }, run).error, /missing trade/);
});

test("shapeError accepts every action the UI and the bot make", () => {
  const size = env("texas").hexmap.size;
  for (const a of [
    { type: "build", path: [1, 2] }, { type: "undo" }, { type: "repair", key: "10-11" }, { type: "repairAll" },
    { type: "harden", key: "10-11" }, { type: "harden", key: "10-11", hz: "flood" }, { type: "double", key: "10-11" },
    { type: "hub", city: "26420" }, { type: "express", id: "faf3" }, { type: "closeExpress", id: "m26420-19100" }, { type: "endTurn" },
  ]) assert.equal(shapeError(a, size), null, JSON.stringify(a));
});

test("the browser's action log replays to the same hash, undo included", () => {
  const e = env("texas");
  let s = S.newGame(e, { seed: 21 });
  const log = [];
  const act = (a) => {
    const r = record(e, s, log, a);
    s = r.state;
    return r.error;
  };
  const dallas = e.cityById.get("19100"), austin = e.cityById.get("12420");
  // a UI-like turn: build, build on, undo the second, an invalid build (not logged), harden, undo it, double, end
  const p1 = S.plan(e, s, e.home.cell, dallas.cell).path;
  assert.equal(act({ type: "build", path: p1 }), null);
  const end = p1[p1.length - 1];
  const stub = [end, e.hexmap.neighbours(end).find((n) => !s.links[e.hexmap.edgeKey(end, n)] && e.edgeCost(end, n) < s.cash)];
  assert.equal(act({ type: "build", path: stub }), null);
  assert.equal(act({ type: "undo" }), null);
  const far = S.plan(e, s, e.cityById.get("41700").cell, austin.cell).path;
  assert.match(act({ type: "build", path: far }), /Connect to your network/);
  // the cheapest link that has a disaster record (so it can be hardened)
  const key = Object.keys(s.links).filter((k) => S.hardenOptions(e, s.links[k]).length).sort((x, y) => s.links[x].cost - s.links[y].cost || (x < y ? -1 : 1))[0];
  assert.equal(act({ type: "harden", key }), null);
  assert.equal(act({ type: "undo" }), null);
  assert.equal(act({ type: "double", key }), null);
  assert.equal(act({ type: "endTurn" }), null);
  assert.equal(act({ type: "undo" }), "Nothing to undo this turn", "undo does not cross a turn");
  assert.deepEqual(log.map((a) => a.type), ["build", "build", "undo", "harden", "undo", "double", "endTurn"]);
  // the save round trip keeps the log; then play on with undo in later turns too
  const back = unpackSave(JSON.parse(JSON.stringify(packSave(s, log))));
  assert.equal(S.stateHash(back.state), S.stateHash(s));
  assert.deepEqual(back.log, log);
  s = back.state;
  const log2 = back.log;
  while (!s.over) {
    // the bot's turn, played through record() with its first action undone and redone
    const turn = [];
    S.greedyTurn(e, s, { log: turn });
    turn.forEach((a, k) => {
      s = record(e, s, log2, a).state;
      if (k === 0 && a.type !== "endTurn") {
        s = record(e, s, log2, { type: "undo" }).state;
        s = record(e, s, log2, a).state;
      }
    });
  }
  assert.ok(log2.filter((a) => a.type === "undo").length > 3);
  // a fresh replay reaches the same state, and the verifier accepts it
  let r = S.newGame(e, { seed: 21 });
  for (const a of JSON.parse(JSON.stringify(log2))) r = S.apply(e, r, a);
  assert.equal(S.stateHash(r), S.stateHash(s));
  const v = verifyRun(data, { scenario: "texas", seed: 21, home: null, log: log2 });
  assert.equal(v.ok, true, v.error);
  assert.equal(v.hash, S.stateHash(s));
  assert.equal(v.uplift, S.summary(e, s).uplift);
});

test("saves: old saves load without a log; new saves keep it", () => {
  const e = env("texas");
  const s = S.newGame(e, { seed: 3 });
  const old = unpackSave(JSON.parse(JSON.stringify(s)));
  assert.equal(old.log, null, "a save from before logs cannot be submitted");
  assert.equal(S.stateHash(old.state), S.stateHash(s));
  assert.ok(!("log" in old.state), "the log never enters the sim state");
  const v1 = unpackSave({ ...JSON.parse(JSON.stringify(s)), v: 1, log: [] });
  assert.equal(v1.log, null, "a migrated v1 save has no usable log");
  assert.equal(unpackSave(null), null);
  assert.equal(unpackSave({ v: 99, links: {}, cities: {}, base: {} }), null);
  // record() on an old save plays on and records nothing
  const r = record(e, s, null, { type: "endTurn" });
  assert.equal(r.error, null);
  assert.equal(r.state.year, s.year + 1);
});

test("board panels: submit form, result with your row, old-save note, leaderboards", () => {
  const { e, s } = botRun("northeast", 2);
  const sc = e.scenario;
  const m = { env: e, state: s, ev: S.evaluate(e, s), sum: S.summary(e, s), ui: {}, sel: {}, touch: false };
  assert.doesNotMatch(endHtml(m, null), /Online board/, "offline: the end screen is unchanged");
  const base = { scenario: sc, hasLog: true, player: null, nick: "", status: "idle", error: null, result: null, board: null };
  assert.match(boardHtml(base), /data-field="nick"[\s\S]*Submit to the Northeast Corridor board/);
  assert.match(endHtml(m, null, base), /Online board/);
  assert.doesNotMatch(boardHtml({ ...base, player: { name: "Ann" } }), /data-field="nick"/);
  assert.match(boardHtml({ ...base, player: { name: "<b>" } }), /&lt;b&gt;/);
  assert.match(boardHtml({ ...base, hasLog: false }), /can't be submitted/);
  assert.match(boardHtml({ ...base, error: "Name is taken <x>" }), /role="alert">Name is taken &lt;x&gt;/);
  const top = [
    { rank: 1, name: "Zed", uplift: 0.09, seed: 1, home: null, year: 2050 },
    { rank: 2, name: "Me", uplift: 0.07, seed: 2, home: null, year: 2050 },
  ];
  const done = boardHtml({ ...base, status: "done", result: { uplift: 0.07, beat: true, rank: 2, total: 40, best: 0.07 }, board: { top, you: { rank: 2, uplift: 0.07 } } });
  assert.match(done, /Rank <b>#2<\/b> of 40/);
  assert.match(done, /<tr class="ml-you"><td>2<\/td><td>Me/);
  assert.equal((done.match(/ml-you"/g) || []).length, 1);
  assert.match(pickerHtml({ save: null, saveEnv: null, cities: [], defaults: { scenario: "texas", home: "19100", seed: 1 } }), /data-act="boards" type="button" hidden/);
  assert.match(pickerHtml({ save: null, saveEnv: null, cities: [], defaults: { scenario: "texas", home: "19100", seed: 1 }, online: true }), /data-act="boards" type="button">/);
  const lb = boardsHtml({ boards: { texas: { top, total: 2 }, rust: { error: "Could not load: HTTP 500" }, northeast: { top: [], total: 0 }, sandbox: { top: [{ ...top[0], home: "19100" }], total: 9 } }, cityName: (id) => (id === "19100" ? "Dallas" : id) });
  assert.match(lb, /Texas Triangle[\s\S]*Zed[\s\S]*Could not load: HTTP 500[\s\S]*No runs yet[\s\S]*Dallas[\s\S]*9 runs in all/);
  assert.match(boardsHtml({ boards: null }), /Loading/);
});
