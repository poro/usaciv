// Mainline versus: 2–4 rail companies on one scenario map, bidding for the same freight contracts. Pure and
// deterministic (no DOM, no clock), so the room's Durable Object (worker/vs.js) and every browser replay the same
// entry log to the same game. Local games against AI rivals run the same code with no server.
//
//   vs = { v, scenario, home, seed, end (last year played), year, over,
//          players: [{name, bot, state}],         one ordinary Mainline state each (state.js), plus state.end and
//                                                 state.rivals (contracts the others hold, which that network never
//                                                 serves or earns from)
//          claims: {contractId: player index},    who holds each contract
//          news: [{id, to, from, why}],           last year's claim changes ("first", "contested", "lapsed")
//          hist: [[uplift per player], …] }       one row per year played
//
// Rules (docs/MULTIPLAYER.md, "Mainline versus"):
// * Everyone starts at the scenario's home metro with the same money and the same seed (so identical networks would
//   see identical disasters). Each company builds its own track; track is never shared.
// * During a year each company acts on its own state with the ordinary rules (build, upgrade, repair, undo…). End
//   turn is not an action: the room resolves the year for everyone at once (resolve()).
// * Claims are settled at the start of resolve(), on each company's intact network:
//   - a holder that still serves its contract keeps it;
//   - otherwise (never held, or the holder's route is cut or gone) the companies serving it compete and the shortest
//     network route wins; equal routes go to the lower player index. Nobody serving it: the claim stays where it is.
//   Then every company's year ends (disasters, revenue on the contracts it holds, growth) with rivals set from the
//   new claims. So a storm that cuts your line costs that year's pay, and the contract too if a rival serves it
//   before you repair.
// * The winner is the company with the highest GDP uplift over baseline America when the last year ends.
//
// Entry log (what the room stores and broadcasts): {p, a} = player p applied action a; {r: 1} = the year resolved.
// replay(env, init, entries) rebuilds the game from newVersus's arguments and the log.
import { newGame, check, applyValid, growthOf } from "./state.js";
import { networkGraph, serveContracts } from "./contracts.js";
import { summary } from "./score.js";
import { greedyTurn } from "./bot.js";
import { START_YEAR, END_YEAR } from "./scenarios.js";
import { stateHash } from "./hash.js";

export const VS_VERSION = 1;
export const VS_MAX = 4;
export const VS_YEARS = [10, 25]; // game lengths offered: 2026–2035 or the full 2026–2050
export const VS_COLORS = ["#f08a2c", "#4fb3ff", "#d27dff", "#5ee08a"]; // player index → track colour (0 = orange, as solo)
export const BOT_NAMES = ["Gulf & Plains AI", "Iron Horse AI", "Prairie Line AI"];

/**
 * A new game. players = [{name, bot?}] in seat order (2..VS_MAX). years = one of VS_YEARS (other values are clamped
 * into 1..25). env = makeEnv(data, scenario, {home}).
 */
export function newVersus(env, { seed = 1, players, years = 10 } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > VS_MAX) throw new Error(`versus needs 2–${VS_MAX} players`);
  const n = Math.max(1, Math.min(END_YEAR - START_YEAR + 1, Math.floor(years) || 10));
  const end = START_YEAR + n - 1;
  const base = newGame(env, { seed });
  return {
    v: VS_VERSION, scenario: env.scenario.id, home: env.home?.id ?? null, seed, end, year: START_YEAR, over: false,
    players: players.map((pl) => ({ name: String(pl.name || "Player"), bot: !!pl.bot, state: { ...base, end, rivals: {} } })),
    claims: {}, news: [], hist: [],
  };
}

const withPlayer = (vs, p, state) => ({ ...vs, players: vs.players.map((pl, k) => (k === p ? { ...pl, state } : pl)) });

/** Why player p may not do this now, or null. */
export function vsCheck(env, vs, p, action) {
  if (vs.over) return "The game is over";
  const pl = vs.players[p];
  if (!pl) return "No such player";
  if (action?.type === "endTurn") return "The year ends when every company is ready";
  if (action?.type === "line") return "Power and fibre are single-player only for now";
  return check(env, pl.state, action);
}

/** Player p applies an action. → {vs, error}; vs is unchanged on an error. */
export function vsAct(env, vs, p, action) {
  const error = vsCheck(env, vs, p, action);
  if (error) return { vs, error };
  return { vs: withPlayer(vs, p, applyValid(env, vs.players[p].state, action)), error: null };
}

/** What each company's intact network could serve now, ignoring claims: [Map<id, served>] by player. */
function reach(env, vs) {
  return vs.players.map((pl) => serveContracts(env, networkGraph(env, pl.state.links, { intactOnly: true }), growthOf(env, pl.state), pl.state.hubs));
}

/** The claim settlement at the start of resolve(). → {claims, news} */
export function settle(env, vs) {
  const can = reach(env, vs);
  const claims = { ...vs.claims };
  const news = [];
  for (const c of env.contracts) {
    const holder = claims[c.id];
    if (holder != null && can[holder]?.has(c.id)) continue;
    let best = -1, bestKm = Infinity, rivals = 0;
    for (let p = 0; p < can.length; p++) {
      const s = can[p].get(c.id);
      if (!s) continue;
      rivals++;
      if (s.km < bestKm - 1e-9) { best = p; bestKm = s.km; }
    }
    if (best < 0 || best === holder) continue;
    claims[c.id] = best;
    news.push({ id: c.id, to: best, from: holder ?? null, why: holder != null ? "lapsed" : rivals > 1 ? "contested" : "first" });
  }
  return { claims, news };
}

const rivalsOf = (claims, p) => {
  const out = {};
  for (const [id, h] of Object.entries(claims)) if (h !== p) out[id] = 1;
  return out;
};

/** End the year for every company at once. */
export function resolve(env, vs) {
  if (vs.over) return vs;
  const { claims, news } = settle(env, vs);
  const players = vs.players.map((pl, p) => ({ ...pl, state: applyValid(env, { ...pl.state, rivals: rivalsOf(claims, p) }, { type: "endTurn" }) }));
  const year = vs.year + 1;
  return {
    ...vs, players, claims, news, year, over: year > vs.end,
    hist: [...vs.hist, players.map((pl) => pl.state.last?.uplift ?? 0)],
  };
}

/**
 * An AI company's actions for this year: the greedy bot (bot.js), stopping before End turn. It plays when the year
 * resolves, after the people, and stays out of races it would only lose money on: contracts any rival already
 * serves (or holds) count as taken while it plans. Those extra skips only make its checks stricter, so every action
 * it picks is valid on its real state too.
 */
export function botActions(env, vs, p) {
  const log = [];
  if (vs.over || !vs.players[p]) return log;
  const can = reach(env, vs);
  const taken = { ...vs.players[p].state.rivals };
  can.forEach((m, k) => { if (k !== p) for (const id of m.keys()) if (vs.claims[id] !== p) taken[id] = 1; });
  greedyTurn(env, { ...vs.players[p].state, rivals: taken }, { log, endTurn: false });
  return log;
}

/** Apply one log entry. → {vs, error} */
export function applyEntry(env, vs, e) {
  if (e && e.r === 1) return vs.over ? { vs, error: "The game is over" } : { vs: resolve(env, vs), error: null };
  if (!e || !Number.isInteger(e.p)) return { vs, error: "Bad entry" };
  return vsAct(env, vs, e.p, e.a);
}

/** Rebuild a game from newVersus's options and its entry log. → {vs, error, at} (stops at the first bad entry). */
export function replay(env, init, entries) {
  let vs = newVersus(env, init);
  for (let i = 0; i < entries.length; i++) {
    const r = applyEntry(env, vs, entries[i]);
    if (r.error) return { vs, error: r.error, at: i };
    vs = r.vs;
  }
  return { vs, error: null, at: entries.length };
}

/** Standings, best first: [{p, name, bot, uplift, cash, held (contracts), revenue (last year), rank}]. */
export function standings(env, vs) {
  const held = vs.players.map(() => 0);
  for (const h of Object.values(vs.claims)) if (held[h] != null) held[h]++;
  const rows = vs.players.map((pl, p) => {
    const sum = summary(env, pl.state);
    return { p, name: pl.name, bot: pl.bot, uplift: sum.uplift, cash: pl.state.cash, held: held[p], revenue: pl.state.last?.revenue ?? 0, links: Object.keys(pl.state.links).length };
  });
  rows.sort((a, b) => b.uplift - a.uplift || b.held - a.held || a.p - b.p);
  rows.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

/** A fingerprint of the whole game (every company's state and the claims), for desync checks. */
export function vsHash(vs) {
  return stateHash({ y: vs.year, c: vs.claims, s: vs.players.map((pl) => stateHash(pl.state)) });
}
