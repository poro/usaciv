// Game state and the one reducer: apply(env, state, action) → state. Pure and deterministic: no DOM, no clock, no
// Math.random; the only randomness is the seeded rng whose state lives in state.rng. Replaying the same actions from
// newGame(env, {seed}) gives the same game (what multiplayer will rely on). An invalid action returns the state
// unchanged; check(env, state, action) says why.
//
// state = {
//   v, scenario, home, seed, year (the year being played), over, cash (cr),
//   links: {edgeKey: {a, b, cost, year, h (hardened: bitmask over events.HZ_TYPES), d (damaged 0|1),
//          dt (double track 0|1)}}, nv (network version, bumps on change),
//   hubs: {cityId: terminal level 1..HUB_MAX}, express: {contractId: year launched} (express services, express.js),
//   cities, base: {cityId: {gdp, pop}}   (your world and baseline America),
//   undo: [{cash, changes: [[key, previous link | null]], hubs?, express?}]   (this turn only),
//   events: [...]   (last turn's disaster cards), last: {...} (last turn's report), hist: [...] (one row per turn),
//   totals: {revenue, potential, maint, built, repairs, hardening, upgrades, express, hits, damaged}, rng (uint32)
// }
//
// endTurn order: disasters roll → freight revenue and upkeep on intact links → growth → next year.
// actions: {type: "build", path: [cell, …]} · {type: "undo"} · {type: "repair", key} · {type: "repairAll"} ·
//          {type: "harden", key, hz?} (one hazard type, or every one the link is exposed to) ·
//          {type: "double", key} (double-track a link) · {type: "hub", city} (build or raise a terminal) ·
//          {type: "express", id} (launch an express service on a served contract) · {type: "closeExpress", id} ·
//          {type: "endTurn"}
//
// Upgrades are the late-game money sinks, and each answers a different question:
//   double track   +DOUBLE_BONUS pay on the share of each route that runs on it, at 1.5× the link's upkeep
//   terminals      +5/7/10% pay per level on contracts touching the metro (rail terminal / air cargo / port), and
//                  +HUB_GROWTH GDP growth per level × the metro's network access; upkeep HUB_MAINT of the investment
//   hardening      per hazard type, priced by that hazard's real FEMA rate in the link's counties
//   express        passenger and express trains between two metros on an all-double-track route: a launch price and
//                  a yearly operating cost buy GDP growth at both ends (a game model; see express.js). The late game's
//                  project: it turns surplus cash into growth, and its upkeep keeps the cash honest.
//
// Determinism: every number that reaches cash, a comparison or a roll is either exact (+ − × ÷ sqrt on doubles) or
// rounded to fixed decimals first (r1, fix), so engines that differ in the last digit of exp / log / pow agree.
import { makeRng, seedFrom } from "../../shared/rng.js";
import { START_YEAR, END_YEAR } from "./scenarios.js";
import { networkGraph, serveContracts } from "./contracts.js";
import { accessShares, grow, PRODUCTIVITY, DEFAULT_POP_GROWTH } from "./growth.js";
import { rollDisasters, linkHazards, HZ_BIT, HZ_ALL, fix } from "./events.js";
import { HUB_MAX } from "./env.js";
import { regionGdp } from "./score.js";
import { expressCost, expressUpkeep, corridorStatus, expressBonus } from "./express.js";

export const SAVE_VERSION = 2;
export const MAINT_RATE = 0.03; // of a link's build cost, every turn
export const REPAIR_RATE = 0.4;
export const HARDEN_FLOOR = 0.12; // hardening against one hazard: link cost × (floor + K × its yearly rate)
export const HARDEN_K = 5;
export const DOUBLE_RATE = 0.6; // double track: of the link's build cost
export const DOUBLE_MAINT = 1.5; // upkeep multiplier on a double-tracked link
export const HUB_MAINT = 0.03; // of what a terminal cost, every turn
// Repairs may run the cash negative (an emergency credit line), so one early storm cannot strand a network with no
// income forever. Debt pays DEBT_RATE interest a turn; nothing else can be bought until cash is positive again.
export const DEBT_RATE = 0.08;
export const creditLine = (state) => r1(Math.max(30, 0.25 * (state.totals?.built || 0)));

const r1 = (x) => Math.round(x * 10) / 10;

export function newGame(env, { seed = 1 } = {}) {
  const cities = {};
  for (const c of env.cities) cities[c.id] = { gdp: c.gdp0, pop: c.pop0 };
  const rng = makeRng(seedFrom(`mainline:${env.scenario.id}:${env.home?.id}:${seed}`));
  return {
    v: SAVE_VERSION, scenario: env.scenario.id, home: env.home?.id ?? null, seed,
    year: START_YEAR, over: false, cash: env.startCash ?? env.scenario.cash,
    links: {}, nv: 0, hubs: {}, express: {},
    cities, base: structuredCopy(cities),
    undo: [], events: [], last: null, hist: [],
    totals: { revenue: 0, potential: 0, maint: 0, built: 0, repairs: 0, hardening: 0, upgrades: 0, express: 0, hits: 0, damaged: 0 },
    rng: rng.state,
  };
}

function structuredCopy(world) {
  const out = {};
  for (const k of Object.keys(world)) out[k] = { ...world[k] };
  return out;
}

/** A save from an older version, brought up to date (or null if it cannot be). v1 hardening covered every hazard. */
export function migrate(s) {
  if (!s || typeof s !== "object" || !s.links || !s.cities || !s.base) return null;
  if (s.v === SAVE_VERSION) return s.express ? s : { ...s, express: {} }; // saves from before express services
  if (s.v !== 1) return null;
  const links = {};
  for (const [k, l] of Object.entries(s.links)) links[k] = { ...l, h: l.h ? HZ_ALL : 0, dt: 0 };
  return { ...s, v: SAVE_VERSION, links, hubs: {}, express: {}, totals: { upgrades: 0, ...s.totals } };
}

export const repairCost = (env, l) => r1(Math.max(0.5, REPAIR_RATE * env.edgeCost(l.a, l.b)));
export const doubleCost = (env, l) => r1(Math.max(1, DOUBLE_RATE * env.edgeCost(l.a, l.b)));
/** Hardening options for a link: one per hazard type its counties have a record of. → [{type, bit, lam, cost, done, …}] */
export function hardenOptions(env, l) {
  const c = env.edgeCost(l.a, l.b);
  return linkHazards(env, l).map((h) => ({ ...h, cost: r1(Math.max(0.5, c * (HARDEN_FLOOR + HARDEN_K * h.lam))), done: !!((l.h | 0) & h.bit) }));
}
/** Price of hardening a link against one hazard type, or (hz omitted) against every one it is not yet hardened for. */
export function hardenCost(env, l, hz = null) {
  const opts = hardenOptions(env, l).filter((o) => !o.done && (!hz || o.type === hz));
  return r1(opts.reduce((s, o) => s + o.cost, 0));
}
/** Price of the next terminal level in a metro, or null at the top level. */
export function hubCost(env, state, cityId) {
  const site = env.hubs.get(cityId);
  const lv = state.hubs?.[cityId] || 0;
  return site && lv < HUB_MAX ? site.base * (lv + 1) : null;
}
const hubInvested = (env, id, lv) => (env.hubs.get(id)?.base || 0) * (lv * (lv + 1)) / 2;
export const maintenance = (state, env = null) => {
  let s = 0;
  for (const l of Object.values(state.links)) s += Math.max(0.05, MAINT_RATE * l.cost) * (l.dt ? DOUBLE_MAINT : 1);
  if (env) for (const [id, lv] of Object.entries(state.hubs || {})) s += HUB_MAINT * hubInvested(env, id, lv);
  if (env) s += expressUpkeep(env, state.express);
  return r1(s);
};
/** Metros with a station: a hex of the city is on your network. */
export function connectedCities(env, state) {
  const net = networkCells(state);
  return env.cities.filter((c) => c.cells.some((x) => net.has(x)));
}

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
export function plan(env, state, from, to, { maxCost = Infinity } = {}) {
  const hm = env.hexmap;
  if (!env.inRegion(from) || !env.inRegion(to)) return { path: null, cost: Infinity, error: "Outside this scenario's region" };
  const built = state.links;
  const stepCost = (a, b) => {
    const l = built[hm.edgeKey(a, b)];
    return l ? 0.01 : env.edgeCost(a, b);
  };
  const r = hm.path(from, to, stepCost, { maxCost });
  if (!r) return { path: null, cost: Infinity, error: maxCost < Infinity ? "Too dear" : "No route: open water, foreign land or the region's edge is in the way" };
  return { ...describePath(env, state, r.path), path: r.path };
}

export function describePath(env, state, path) {
  const hm = env.hexmap;
  let cost = 0, fresh = 0, rail = 0, rivers = 0, km = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const key = hm.edgeKey(a, b);
    km += env.km(a, b);
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
    case "repair": case "harden": case "double": {
      const l = state.links[action.key];
      if (!l) return "No such link";
      let c;
      if (action.type === "repair") {
        if (!l.d) return "That link is not damaged";
        c = repairCost(env, l);
        return c > state.cash + creditLine(state) + 1e-9 ? `Not enough money, even on credit: ${c} cr needed` : null;
      } else if (action.type === "double") {
        if (l.dt) return "Already double-tracked";
        if (l.d) return "Repair it first";
        c = doubleCost(env, l);
      } else {
        const opts = hardenOptions(env, l);
        if (action.hz != null && !opts.some((o) => o.type === action.hz)) return "No record of that hazard here";
        if (!opts.some((o) => !o.done && (action.hz == null || o.type === action.hz))) return opts.length ? "Already hardened" : "No disaster record here";
        c = hardenCost(env, l, action.hz ?? null);
      }
      return c > state.cash + 1e-9 ? `Not enough money: ${c} cr needed` : null;
    }
    case "hub": {
      if (!env.hubs.has(action.city)) return "Not a metro in this region";
      const c = hubCost(env, state, action.city);
      if (c == null) return "Already at the top level";
      const city = env.cities[env.cityIdx.get(action.city)];
      const net = networkCells(state);
      if (!city.cells.some((x) => net.has(x))) return `Connect ${city.name} to your network first`;
      return c > state.cash + 1e-9 ? `Not enough money: ${c} cr needed` : null;
    }
    case "express": {
      const c = env.contractById.get(action.id);
      if (!c) return "No such contract";
      if (state.express?.[action.id]) return "Express already runs there";
      const served = serveContracts(env, networkGraph(env, state.links, { intactOnly: true }), growthOf(env, state), state.hubs);
      const st = corridorStatus(env, state.links, served, action.id);
      if (!st.ok) return st.why;
      const cost = expressCost(c);
      return cost > state.cash + 1e-9 ? `Not enough money: ${cost} cr needed` : null;
    }
    case "closeExpress":
      return state.express?.[action.id] ? null : "No express runs there";
    case "repairAll": {
      const dmg = Object.values(state.links).filter((l) => l.d);
      if (!dmg.length) return "Nothing is damaged";
      return repairCost(env, dmg.reduce((a, b) => (repairCost(env, a) <= repairCost(env, b) ? a : b))) > state.cash + creditLine(state) + 1e-9 ? "Not enough money, even on credit" : null;
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
        links[key] = { a, b, cost: c, year: state.year, h: 0, d: 0, dt: 0 };
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
    case "repair": case "harden": case "double": {
      const l = state.links[action.key];
      let cost, next;
      const t = { ...state.totals };
      if (action.type === "repair") {
        cost = repairCost(env, l);
        next = { ...l, d: 0 };
        t.repairs = r1(t.repairs + cost);
      } else if (action.type === "double") {
        cost = doubleCost(env, l);
        next = { ...l, dt: 1 };
        t.upgrades = r1((t.upgrades || 0) + cost);
      } else {
        cost = hardenCost(env, l, action.hz ?? null);
        const bits = action.hz != null ? HZ_BIT[action.hz] : hardenOptions(env, l).reduce((m, o) => m | o.bit, 0);
        next = { ...l, h: (l.h | 0) | bits };
        t.hardening = r1(t.hardening + cost);
      }
      const links = { ...state.links, [action.key]: next };
      return {
        ...state, links, nv: state.nv + 1, cash: r1(state.cash - cost), totals: t,
        undo: [...state.undo, { cash: state.cash, changes: [[action.key, l]], what: action.type, totals: state.totals }],
      };
    }
    case "hub": {
      const cost = hubCost(env, state, action.city);
      const hubs = { ...state.hubs, [action.city]: (state.hubs?.[action.city] || 0) + 1 };
      return {
        ...state, hubs, nv: state.nv + 1, cash: r1(state.cash - cost),
        totals: { ...state.totals, upgrades: r1((state.totals.upgrades || 0) + cost) },
        undo: [...state.undo, { cash: state.cash, changes: [], hubs: state.hubs, what: "hub", totals: state.totals }],
      };
    }
    case "express": case "closeExpress": {
      const express = { ...(state.express || {}) };
      let cash = state.cash;
      const t = { ...state.totals };
      if (action.type === "express") {
        const cost = expressCost(env.contractById.get(action.id));
        express[action.id] = state.year;
        cash = r1(cash - cost);
        t.express = r1((t.express || 0) + cost);
      } else delete express[action.id];
      return {
        ...state, express, nv: state.nv + 1, cash, totals: t,
        undo: [...state.undo, { cash: state.cash, changes: [], express: state.express || {}, what: action.type, totals: state.totals }],
      };
    }
    case "repairAll": {
      // cheapest first, as many as the money allows
      const dmg = Object.keys(state.links).filter((k) => state.links[k].d).sort((x, y) => repairCost(env, state.links[x]) - repairCost(env, state.links[y]) || (x < y ? -1 : 1));
      const links = { ...state.links };
      const changes = [];
      let cash = state.cash, spent = 0;
      const credit = creditLine(state);
      for (const key of dmg) {
        const c = repairCost(env, links[key]);
        if (c > cash + credit + 1e-9) break;
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
      return {
        ...state, links, hubs: u.hubs || state.hubs, express: u.express || state.express, nv: state.nv + 1, cash: u.cash, undo: state.undo.slice(0, -1), totals: u.totals || state.totals,
      };
    }
    case "endTurn":
      return endTurn(env, state);
  }
  return state;
}

/** GDP growth of a set of cities since the start (cities outside the region list follow the national trend). */
export function growthOf(env, state) {
  const t = state.year - START_YEAR;
  const trend = fix(Math.pow(1 + PRODUCTIVITY + DEFAULT_POP_GROWTH, t), 1e9);
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

/**
 * What the network does right now (derived, not stored): served contracts, revenue, upkeep, and per link the
 * contracts routed over it (loads: Map<edgeKey, {n, pay, base}>).
 */
export function evaluate(env, state) {
  const graph = networkGraph(env, state.links, { intactOnly: true });
  const served = serveContracts(env, graph, growthOf(env, state), state.hubs);
  let revenue = 0;
  const loads = new Map();
  for (const s of served.values()) {
    revenue += s.pay;
    for (const k of s.keys) {
      const ld = loads.get(k) || { n: 0, pay: 0, base: 0, km: 0 };
      ld.n++;
      ld.pay += s.pay;
      ld.base += s.base * (s.km > 0 ? env.km(state.links[k].a, state.links[k].b) / s.km : 0);
      loads.set(k, ld);
    }
  }
  const anyDamage = Object.values(state.links).some((l) => l.d);
  let potential = revenue;
  let potentialServed = served;
  if (anyDamage) {
    const full = networkGraph(env, state.links, { intactOnly: false });
    potentialServed = serveContracts(env, full, growthOf(env, state), state.hubs);
    potential = 0;
    for (const s of potentialServed.values()) potential += s.pay;
  }
  return { graph, served, loads, revenue: r1(revenue), potential: r1(potential), potentialServed, maint: maintenance(state, env) };
}

function endTurn(env, state) {
  // 1. the year's disasters strike first, so a cut link costs this year's freight (hardening pays off)
  const rng = makeRng(state.rng);
  const roll = rollDisasters(env, state.links, rng, state.year);
  const hit = roll.links === state.links ? state : { ...state, links: roll.links };
  // 2. freight revenue and upkeep on what is left standing
  const ev = evaluate(env, hit);
  const revenue = ev.revenue, maint = ev.maint;
  const interest = state.cash < 0 ? r1(-state.cash * DEBT_RATE) : 0;
  const cash = r1(state.cash + revenue - maint - interest);
  // 3. growth: baseline on trend, your metros with the access bonus of the intact network
  const access = accessShares(env, ev.graph);
  const extra = expressBonus(env, hit.links, ev.served, state.express, state.cities);
  const cities = grow(env, state.cities, access, state.hubs, extra);
  const base = grow(env, state.base, null);
  const damaged = roll.events.reduce((s, e) => s + e.damaged, 0);
  const you = regionGdp(env, cities), bl = regionGdp(env, base);
  const row = {
    year: state.year, revenue, potential: ev.potential, maint, interest, served: ev.served.size, cash,
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
