// Founders multiplayer: 2–4 nations settle one map at the same time. Pure and deterministic (no DOM, no clock), so
// the online room (worker/vs.js, game "founders"), hotseat and games against AI replay the same entry log to the
// same match.
//
//   m = { v, game: "founders", seed, turns, turn, over,
//         players: [{name, bot, start: {cell, label}, state}],   one ordinary Founders state each (state.js) plus
//                                                                 state.seat, state.nations and state.rivals
//         news: [{kind: "turnedBack"|"founded", seat, name, by?}],   what last turn's resolve did between nations
//         hist: [[prosperity score per player], …] }               one row per turn played
//
// Rules (docs/MULTIPLAYER.md, "Founders multiplayer"):
// * Each nation starts with a founding party in a different region: the seed shuffles the four regional starts
//   (startOptions) and seat k takes the k-th. Same money, same rules; each nation has its own random stream (town
//   names, events), seeded from the match seed and its seat.
// * Turns are simultaneous: every nation acts on its own state (the ordinary actions; never "start" or "end"). Rival
//   towns are known as they stood when the turn began.
// * Land: every nation's towns claim together, oldest first; towns founded in the same turn go in that turn's seat
//   order, which rotates every turn (state.js claimRank). Land a rival holds is not yours: no founding, working or
//   improving there. Parties and roads may cross it.
// * Founding conflicts: when the turn resolves, a town founded this turn within RULES.minTownDist of another
//   nation's town that ranks earlier is turned back: the town is removed and its party stands on the hex again (with
//   fresh moves next turn). Anything built for it that turn is lost.
// * Then every nation's turn ends (auto towns spend, production, growth, events) with the rivals' towns as they now
//   stand. The highest prosperity score after the last turn wins.
//
// Entry log: {p, a} = seat p applied action a; {r: 1} = the turn resolved. replay(env, init, entries) rebuilds it.
import { RULES, newGame, startOptions, clone, claimRank } from "./state.js";
import { apply } from "./actions.js";
import { botTurn } from "./advice.js";
import { prosperity } from "./score.js";
import { nationOutput } from "./state.js";
import { makeRng } from "../../shared/rng.js";
import { stateHash } from "../../mainline/sim/hash.js";

export const MATCH_VERSION = 1;
export const MATCH_MAX = 4;
export const MATCH_TURNS = [30, 60]; // 1790–1906 or the full 1790–2026
export const NATION_COLORS = ["#8ff3ec", "#f3d27a", "#ff8f8f", "#d9a6ff"]; // seat → border colour (0 = teal, as solo; render.js NATIONS)
export const BOT_NATIONS = ["Republic of Cascadia AI", "Lakes Confederacy AI", "Gulf Union AI"];
export const BLOCKED = new Set(["start", "end", "noop"]); // actions a nation may not send in a match

/** The seats' starts: the seed's shuffle of the four regional starts. */
export function matchStarts(env, seed, n) {
  const starts = startOptions(env, seed);
  const rng = makeRng(`founders-match:${seed}`);
  const order = starts.map((_, k) => k);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, n).map((k) => starts[k]);
}

const rivalView = (state) => ({ seat: state.seat, towns: state.towns.map((t) => ({ id: t.id, cell: t.cell, radius: t.radius, founded: t.founded, name: t.name })) });
/** Give every nation the others' towns as they stand now. */
function inform(players) {
  const views = players.map((pl) => rivalView(pl.state));
  return players.map((pl, p) => ({ ...pl, state: { ...pl.state, rivals: views.filter((_, k) => k !== p) } }));
}

/** A new match. players = [{name, bot?}] in seat order (2..MATCH_MAX); turns = one of MATCH_TURNS (clamped 5..60). */
export function newMatch(env, { seed = 1, players, turns = 30 } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > MATCH_MAX) throw new Error(`a match needs 2–${MATCH_MAX} nations`);
  const n = players.length;
  const max = Math.max(5, Math.min(RULES.maxTurns, Math.floor(turns) || 30));
  const starts = matchStarts(env, seed, n);
  if (starts.length < n) throw new Error("not enough starts on this map");
  const ps = players.map((pl, k) => {
    const s = newGame(env, seed, { start: starts[k].cell });
    // each nation its own random stream (town names, events); seat 0 keeps the solo one
    const rng = k ? makeRng(`founders:${seed}:seat${k}`).state : s.rng;
    return { name: String(pl.name || `Nation ${k + 1}`), bot: !!pl.bot, start: starts[k], state: { ...s, rng, maxTurns: max, seat: k, nations: n, rivals: [] } };
  });
  return { v: MATCH_VERSION, game: "founders", seed: String(seed), turns: max, turn: 1, over: false, players: inform(ps), news: [], hist: [] };
}

const withPlayer = (m, p, state) => ({ ...m, players: m.players.map((pl, k) => (k === p ? { ...pl, state } : pl)) });

/** Seat p applies an action. → {m, error, msg}; m is unchanged on an error. */
export function matchAct(env, m, p, action) {
  if (m.over) return { m, error: "The game is over" };
  const pl = m.players[p];
  if (!pl) return { m, error: "No such nation" };
  if (!action || typeof action.type !== "string") return { m, error: "No action" };
  if (BLOCKED.has(action.type)) return { m, error: action.type === "end" ? "The turn ends when every nation is ready" : "Not in a multiplayer game" };
  if (action.auto) return { m, error: "Not an order" };
  const r = apply(env, pl.state, action);
  if (!r.ok) return { m, error: r.error || "Not allowed" };
  return { m: withPlayer(m, p, r.state), error: null, msg: r.msg || null };
}

/** Towns founded this turn too close to an earlier-ranked rival town: [{p, town}] (the ones to turn back). */
export function conflicts(env, m) {
  const { map } = env;
  const all = [];
  m.players.forEach((pl, p) => pl.state.towns.forEach((t, k) => all.push({ p, t, k, rank: claimRank(pl.state, t.founded, p) })));
  all.sort((a, b) => a.rank - b.rank || a.p - b.p || a.k - b.k);
  const kept = [], out = [];
  for (const x of all) {
    const clash = x.t.founded === m.turn && kept.some((y) => y.p !== x.p && map.dist(y.t.cell, x.t.cell) < RULES.minTownDist);
    if (clash) out.push({ p: x.p, town: x.t, by: kept.find((y) => y.p !== x.p && map.dist(y.t.cell, x.t.cell) < RULES.minTownDist).p });
    else kept.push(x);
  }
  return out;
}

/** End the turn for every nation at once. */
export function resolve(env, m) {
  if (m.over) return m;
  const news = [];
  let players = m.players;
  // 1. founding conflicts
  for (const c of conflicts(env, m)) {
    const s = clone(players[c.p].state);
    s.towns = s.towns.filter((t) => t.id !== c.town.id);
    s.parties.push({ id: s.nextId++, cell: c.town.cell, moves: 0, target: null });
    s.stats.founded = Math.max(0, (s.stats.founded || 1) - 1);
    s.log.push({ turn: s.turn, kind: "event", bad: true, text: `${c.town.name} could not be founded: ${players[c.by].name} settled within ${RULES.minTownDist} hexes first. The party waits on the spot.` });
    players = players.map((pl, k) => (k === c.p ? { ...pl, state: s } : pl));
    news.push({ kind: "turnedBack", seat: c.p, name: c.town.name, by: c.by });
  }
  for (const [p, pl] of players.entries()) for (const t of pl.state.towns) if (t.founded === m.turn) news.push({ kind: "founded", seat: p, name: t.name });
  // 2. every nation's turn ends, with the rivals as they now stand; then they see each other's new borders
  players = inform(players).map((pl) => {
    const r = apply(env, pl.state, { type: "end" });
    return { ...pl, state: r.state };
  });
  players = inform(players);
  const over = players.every((pl) => pl.state.phase === "over");
  return {
    ...m, players, news, turn: m.turn + 1, over,
    hist: [...m.hist, players.map((pl) => prosperity(env, pl.state).score)],
  };
}

/** An AI nation's actions for this turn (advice.js botTurn, stopping before "end"). */
export function botActions(env, m, p) {
  const log = [];
  if (m.over || !m.players[p]) return log;
  botTurn(env, m.players[p].state, { log, end: false });
  return log.filter((a) => !BLOCKED.has(a.type));
}

/** Apply one log entry. → {m, error} */
export function applyEntry(env, m, e) {
  if (e && e.r === 1) return m.over ? { m, error: "The game is over" } : { m: resolve(env, m), error: null };
  if (!e || !Number.isInteger(e.p)) return { m, error: "Bad entry" };
  const r = matchAct(env, m, e.p, e.a);
  return { m: r.m, error: r.error };
}

/** Rebuild a match from newMatch's options and its entry log. → {m, error, at} */
export function replay(env, init, entries) {
  let m = newMatch(env, init);
  for (let i = 0; i < entries.length; i++) {
    const r = applyEntry(env, m, entries[i]);
    if (r.error) return { m, error: r.error, at: i };
    m = r.m;
  }
  return { m, error: null, at: entries.length };
}

/** Standings, best first: [{p, name, bot, score, towns, pop, rank}]. */
export function standings(env, m) {
  const rows = m.players.map((pl, p) => {
    const n = nationOutput(env, pl.state);
    return { p, name: pl.name, bot: pl.bot, score: prosperity(env, pl.state).score, towns: pl.state.towns.length, pop: n.pop, wealth: pl.state.wealth };
  });
  rows.sort((a, b) => b.score - a.score || b.pop - a.pop || a.p - b.p);
  rows.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

/** A fingerprint of the whole match, for desync checks. */
export function matchHash(m) {
  return stateHash({ t: m.turn, s: m.players.map((pl) => stateHash(pl.state)) });
}

// --- server-side shape check (before the rules see an action) ---------------------------------------------------
const SHAPES = {
  move: { party: "int", to: "cell" }, found: { party: "int" }, party: { town: "int" },
  improve: { cell: "cell", kind: "str" }, link: { a: "int", b: "int" }, focus: { town: "int", focus: "str" },
  pin: { town: "int", cell: "cell" }, project: { town: "int", project: "str" }, grow: { town: "int" },
  festival: { town: "int" }, auto: { town: "townOrAll", on: "bool" },
};
/** Why an action is malformed, or null. size = hex count of the map. */
export function matchShapeError(a, size) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "Not an action";
  const shape = Object.hasOwn(SHAPES, a.type) ? SHAPES[a.type] : null;
  if (!shape) return `Unknown action ${typeof a.type === "string" ? `"${a.type.slice(0, 32)}"` : ""}`.trim();
  for (const k of Object.keys(a)) if (k !== "type" && !Object.hasOwn(shape, k)) return `Unexpected field "${String(k).slice(0, 32)}"`;
  for (const [k, kind] of Object.entries(shape)) {
    const v = a[k];
    const ok = kind === "int" ? Number.isSafeInteger(v) && v >= 0
      : kind === "cell" ? Number.isInteger(v) && v >= 0 && v < size
      : kind === "str" ? typeof v === "string" && v.length > 0 && v.length <= 32
      : kind === "bool" ? typeof v === "boolean"
      : kind === "townOrAll" ? v === "all" || (Number.isSafeInteger(v) && v >= 0) : false;
    if (!ok) return `Bad "${k}"`;
  }
  return null;
}
