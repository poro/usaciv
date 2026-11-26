// Game state and the one reducer: apply(env, state, action) → state. Pure and deterministic: no DOM, no clock, no
// Math.random; the only randomness is the seeded rng whose state lives in state.rng. Replaying the same actions from
// newGame(env, {seed}) gives the same game (what multiplayer will rely on). An invalid action returns the state
// unchanged; check(env, state, action) says why.
//
// state = {
//   v, scenario, home, seed, year (the year being played), over, cash (cr),
//   links: {edgeKey: {a, b, cost, year, h (hardened 0|1), d (damaged 0|1)}}, nv (network version, bumps on change),
//   cities, base: {cityId: {gdp, pop}}   (your world and baseline America),
//   undo: [{cash, changes: [[key, previous link | null]]}]   (this turn only),
//   events: [...]   (last turn's disaster cards), last: {...} (last turn's report), hist: [...] (one row per turn),
//   totals: {revenue, potential, maint, built, repairs, hardening, hits, damaged}, rng (uint32)
// }
//
// endTurn order: disasters roll → freight revenue and upkeep on intact links → growth → next year.
// actions: {type: "build", path: [cell, …]} · {type: "undo"} · {type: "repair", key} · {type: "repairAll"} ·
//          {type: "harden", key} · {type: "endTurn"}
import { makeRng, seedFrom } from "../../shared/rng.js";
import { START_YEAR, END_YEAR } from "./scenarios.js";
import { networkGraph, serveContracts } from "./contracts.js";
import { accessShares, grow, PRODUCTIVITY, DEFAULT_POP_GROWTH } from "./growth.js";
import { rollDisasters } from "./events.js";
import { regionGdp } from "./score.js";

export const SAVE_VERSION = 1;
export const MAINT_RATE = 0.03; // of a link's build cost, every turn
export const REPAIR_RATE = 0.4;
export const HARDEN_RATE = 0.6;

const r1 = (x) => Math.round(x * 10) / 10;

export function newGame(env, { seed = 1 } = {}) {
  const cities = {};
  for (const c of env.cities) cities[c.id] = { gdp: c.gdp0, pop: c.pop0 };
  const rng = makeRng(seedFrom(`mainline:${env.scenario.id}:${env.home?.id}:${seed}`));
  return {
    v: SAVE_VERSION, scenario: env.scenario.id, home: env.home?.id ?? null, seed,
    year: START_YEAR, over: false, cash: env.scenario.cash,
    links: {}, nv: 0,
    cities, base: structuredCopy(cities),
    undo: [], events: [], last: null, hist: [],
    totals: { revenue: 0, potential: 0, maint: 0, built: 0, repairs: 0, hardening: 0, hits: 0, damaged: 0 },
    rng: rng.state,
  };
}

function structuredCopy(world) {
  const out = {};
  for (const k of Object.keys(world)) out[k] = { ...world[k] };
  return out;
}

export const repairCost = (env, l) => r1(Math.max(0.5, REPAIR_RATE * env.edgeCost(l.a, l.b)));
export const hardenCost = (env, l) => r1(Math.max(1, HARDEN_RATE * env.edgeCost(l.a, l.b)));
export const maintenance = (state) => r1(Object.values(state.links).reduce((s, l) => s + Math.max(0.05, MAINT_RATE * l.cost), 0));

/** Cells your network touches (any link end). */
export function networkCells(state) {
  const s = new Set();
  for (const l of Object.values(state.links)) { s.add(l.a); s.add(l.b); }
  return s;
}

/**
 * Cheapest route for new track from `from` to `to`: your built links are (almost) free, so routes reuse them.
 * → {path, cost (new links only), fresh (new link count), rail (new links upgrading real rail), rivers, km, error}
 */
export function plan(env, state, from, to) {
  const hm = env.hexmap;
  if (!env.inRegion(from) || !env.inRegion(to)) return { path: null, cost: Infinity, error: "Outside this scenario's region" };
  const built = state.links;
  const stepCost = (a, b) => {
    const l = built[hm.edgeKey(a, b)];
    return l ? 0.01 : env.edgeCost(a, b);
  };
  const r = hm.path(from, to, stepCost);
  if (!r) return { path: null, cost: Infinity, error: "No route: open water, foreign land or the region's edge is in the way" };
  return { ...describePath(env, state, r.path), path: r.path };
}

export function describePath(env, state, path) {
  const hm = env.hexmap;
  let cost = 0, fresh = 0, rail = 0, rivers = 0, km = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const key = hm.edgeKey(a, b);
    km += hm.km(a, b);
    if (state.links[key]) continue;
    cost += env.edgeCost(a, b);
    fresh++;
    if (env.rail.has(key)) rail++;
    if (env.rivers.has(key)) rivers++;
  }
  cost = r1(cost);
  const err = check(env, state, { type: "build", path });
  return { cost, fresh, rail, rivers, km: Math.round(km), error: err };
}

/** Why an action is not allowed right now, or null. */
export function check(env, state, action) {
  if (!action || typeof action.type !== "string") return "Unknown action";
  if (state.over) return "The game is over";
  const hm = env.hexmap;
  switch (action.type) {
    case "build": {
      const p = action.path;
      if (!Array.isArray(p) || p.length < 2) return "Pick two different hexes";
      let cost = 0, fresh = 0;
      for (let k = 1; k < p.length; k++) {
        if (hm.dist(p[k - 1], p[k]) !== 1) return "Track must run between neighbouring hexes";
        if (state.links[hm.edgeKey(p[k - 1], p[k])]) continue;
        const c = env.edgeCost(p[k - 1], p[k]);
        if (!(c < Infinity)) return "Can't build there (open ocean, foreign land or outside the region)";
        cost += c;
        fresh++;
      }
      if (!fresh) return "Already built";
      const net = networkCells(state);
      const touches = (c) => net.has(c) || env.homeCells.has(c);
      if (!touches(p[0]) && !touches(p[p.length - 1])) return `Connect to your network (or start in ${env.home?.name || "your home metro"})`;
      if (r1(cost) > state.cash + 1e-9) return `Not enough money: ${r1(cost)} cr needed, ${r1(state.cash)} cr in hand`;
      return null;
    }
    case "undo":
      return state.undo.length ? null : "Nothing to undo this turn";
    case "repair": case "harden": {
      const l = state.links[action.key];
      if (!l) return "No such link";
      if (action.type === "repair" && !l.d) return "That link is not damaged";
      if (action.type === "harden" && l.h) return "Already hardened";
      const c = action.type === "repair" ? repairCost(env, l) : hardenCost(env, l);
      return c > state.cash + 1e-9 ? `Not enough money: ${c} cr needed` : null;
    }
    case "repairAll": {
      const dmg = Object.values(state.links).filter((l) => l.d);
      if (!dmg.length) return "Nothing is damaged";
      return repairCost(env, dmg.reduce((a, b) => (repairCost(env, a) <= repairCost(env, b) ? a : b))) > state.cash + 1e-9 ? "Not enough money" : null;
    }
    case "endTurn":
      return null;
    default:
      return `Unknown action "${action.type}"`;
  }
}

/** The reducer. */
export function apply(env, state, action) {
  if (check(env, state, action)) return state;
  const hm = env.hexmap;
  switch (action.type) {
    case "build": {
      const links = { ...state.links };
      const changes = [];
      let cost = 0;
      const p = action.path;
      for (let k = 1; k < p.length; k++) {
        const a = Math.min(p[k - 1], p[k]), b = Math.max(p[k - 1], p[k]);
        const key = hm.edgeKey(a, b);
        if (links[key]) continue;
        const c = env.edgeCost(a, b);
        links[key] = { a, b, cost: c, year: state.year, h: 0, d: 0 };
        changes.push([key, null]);
        cost += c;
      }
      cost = r1(cost);
      return {
        ...state, links, nv: state.nv + 1, cash: r1(state.cash - cost),
        undo: [...state.undo, { cash: state.cash, changes, what: "build", totals: state.totals }],
        totals: { ...state.totals, built: r1(state.totals.built + cost) },
      };
    }
    case "repair": case "harden": {
      const l = state.links[action.key];
      const repair = action.type === "repair";
      const cost = repair ? repairCost(env, l) : hardenCost(env, l);
      const links = { ...state.links, [action.key]: repair ? { ...l, d: 0 } : { ...l, h: 1 } };
      const t = { ...state.totals };
      if (repair) t.repairs = r1(t.repairs + cost); else t.hardening = r1(t.hardening + cost);
      return {
        ...state, links, nv: state.nv + 1, cash: r1(state.cash - cost), totals: t,
        undo: [...state.undo, { cash: state.cash, changes: [[action.key, l]], what: action.type, totals: state.totals }],
      };
    }
    case "repairAll": {
      // cheapest first, as many as the money allows
      const dmg = Object.keys(state.links).filter((k) => state.links[k].d).sort((x, y) => repairCost(env, state.links[x]) - repairCost(env, state.links[y]) || (x < y ? -1 : 1));
      const links = { ...state.links };
      const changes = [];
      let cash = state.cash, spent = 0;
      for (const key of dmg) {
        const c = repairCost(env, links[key]);
        if (c > cash + 1e-9) break;
        changes.push([key, links[key]]);
        links[key] = { ...links[key], d: 0 };
        cash = r1(cash - c);
        spent += c;
      }
      return {
        ...state, links, nv: state.nv + 1, cash, totals: { ...state.totals, repairs: r1(state.totals.repairs + spent) },
        undo: [...state.undo, { cash: state.cash, changes, what: "repair", totals: state.totals }],
      };
    }
    case "undo": {
      const u = state.undo[state.undo.length - 1];
      const links = { ...state.links };
      for (const [key, prev] of u.changes) {
        if (prev) links[key] = prev;
        else delete links[key];
      }
      return { ...state, links, nv: state.nv + 1, cash: u.cash, undo: state.undo.slice(0, -1), totals: u.totals || state.totals };
    }
    case "endTurn":
      return endTurn(env, state);
  }
  return state;
}

/** GDP growth of a set of cities since the start (cities outside the region list follow the national trend). */
export function growthOf(env, state) {
  const t = state.year - START_YEAR;
  const trend = Math.pow(1 + PRODUCTIVITY + DEFAULT_POP_GROWTH, t);
  return (ids) => {
    let s = 0, n = 0;
    for (const id of ids) {
      const k = env.cityIdx.get(id);
      if (k == null) continue;
      s += state.cities[id].gdp / env.cities[k].gdp0;
      n++;
    }
    return n ? s / n : trend;
  };
}

/** What the network does right now (derived, not stored): served contracts, revenue, access. */
export function evaluate(env, state) {
  const graph = networkGraph(env, state.links, { intactOnly: true });
  const served = serveContracts(env, graph, growthOf(env, state));
  let revenue = 0;
  for (const s of served.values()) revenue += s.pay;
  const anyDamage = Object.values(state.links).some((l) => l.d);
  let potential = revenue;
  let potentialServed = served;
  if (anyDamage) {
    const full = networkGraph(env, state.links, { intactOnly: false });
    potentialServed = serveContracts(env, full, growthOf(env, state));
    potential = 0;
    for (const s of potentialServed.values()) potential += s.pay;
  }
  return { graph, served, revenue: r1(revenue), potential: r1(potential), potentialServed, maint: maintenance(state) };
}

function endTurn(env, state) {
  // 1. the year's disasters strike first, so a cut link costs this year's freight (hardening pays off)
  const rng = makeRng(state.rng);
  const roll = rollDisasters(env, state.links, rng, state.year);
  const hit = roll.links === state.links ? state : { ...state, links: roll.links };
  // 2. freight revenue and upkeep on what is left standing
  const ev = evaluate(env, hit);
  const revenue = ev.revenue, maint = ev.maint;
  const cash = r1(state.cash + revenue - maint);
  // 3. growth: baseline on trend, your metros with the access bonus of the intact network
  const access = accessShares(env, ev.graph);
  const cities = grow(env, state.cities, access);
  const base = grow(env, state.base, null);
  const damaged = roll.events.reduce((s, e) => s + e.damaged, 0);
  const you = regionGdp(env, cities), bl = regionGdp(env, base);
  const row = {
    year: state.year, revenue, potential: ev.potential, maint, served: ev.served.size, cash,
    uplift: bl > 0 ? you / bl - 1 : 0, links: Object.keys(state.links).length, hits: roll.events.length, damaged,
  };
  const t = state.totals;
  const year = state.year + 1;
  return {
    ...state,
    year, over: year > END_YEAR, cash, cities, base,
    links: roll.links, nv: roll.links === state.links ? state.nv : state.nv + 1,
    undo: [], events: roll.events, last: row, hist: [...state.hist, row],
    totals: {
      ...t, revenue: r1(t.revenue + revenue), potential: r1(t.potential + ev.potential), maint: r1(t.maint + maint),
      hits: t.hits + roll.events.length, damaged: t.damaged + damaged,
    },
    rng: rng.state,
  };
}
