// Express service: passenger and express-parcel trains between two metros, the late-game project that turns money
// into growth. A game model, not a forecast: the growth figure stands for the effect faster travel between two big
// labour markets is thought to have (agglomeration), at a rate picked for balance. The UI labels it so.
//
// A corridor is a served contract whose two ends each hold a region metro (the biggest one, for a FAF zone). You can
// launch a service once the contract's whole route runs on double track. It then costs a launch price (rolling stock
// and stations, by distance) and a yearly operating cost (part of upkeep). The trains stop at both end metros and at
// every metro the route passes through. Every year the service runs (the contract still served, every link of its
// route intact and double-tracked) each of those stations grows EXPRESS_GROWTH faster × the other stations' share of
// the corridor's GDP, so corridors joining big metros gain the most; one metro gains at most EXPRESS_CAP a year from
// all its services. A suspended service still costs its upkeep. Closing one ends it (no refund).
//
// Determinism: only + − × ÷ on doubles and r1 rounding; no exp / log / pow.

export const EXPRESS_BASE = 10; // cr: stations and a depot
export const EXPRESS_KM = 0.06; // cr per straight km between the metros: rolling stock
export const EXPRESS_OPS = 0.1; // of the launch price, every turn (crews, energy, track access)
export const EXPRESS_GROWTH = 0.001; // extra GDP growth a year at each end, × the other end's share of the pair's GDP
export const EXPRESS_CAP = 0.003; // the most extra growth a year one metro gets from all its services

const r1 = (x) => Math.round(x * 10) / 10;

/** The biggest region metro at one end of a contract, or null. */
export function endMetro(env, end) {
  let best = null;
  for (const id of end.cities) {
    const k = env.cityIdx.get(id);
    if (k == null) continue;
    const c = env.cities[k];
    if (!best || c.gdp0 > best.gdp0 || (c.gdp0 === best.gdp0 && c.id < best.id)) best = c;
  }
  return best;
}

/** The two metros an express on contract c would join, or null if either end has none (or they are the same). */
export function corridor(env, c) {
  const a = endMetro(env, c.a), b = endMetro(env, c.b);
  return a && b && a.id !== b.id ? { a, b } : null;
}

export const expressCost = (c) => r1(EXPRESS_BASE + EXPRESS_KM * c.km);
export const expressOps = (c) => r1(EXPRESS_OPS * expressCost(c));

/** Yearly operating cost of every service you run (or have suspended). */
export function expressUpkeep(env, express) {
  let s = 0;
  for (const id of Object.keys(express || {}).sort()) {
    const c = env.contractById.get(id);
    if (c) s += expressOps(c);
  }
  return r1(s);
}

/**
 * Where an express on contract id stands, given the served map from evaluate: {ok (could run), why, keys (route links
 * not yet double-tracked), served}. links = state.links.
 */
export function corridorStatus(env, links, served, id) {
  const c = env.contractById.get(id);
  if (!c || !corridor(env, c)) return { ok: false, why: "Express needs a metro at both ends", keys: [] };
  const sv = served.get(id);
  if (!sv) return { ok: false, why: "The contract is not served", keys: [] };
  const keys = sv.keys.filter((k) => !links[k]?.dt);
  if (keys.length) return { ok: false, why: `${keys.length} link${keys.length === 1 ? "" : "s"} of the route still single track`, keys };
  return { ok: true, why: null, keys };
}

/** Region metros with a station on a served route (its ends and every metro its links pass through), by index. */
export function stations(env, links, sv, c) {
  const set = new Set();
  const m = corridor(env, c);
  if (m) { set.add(env.cityIdx.get(m.a.id)); set.add(env.cityIdx.get(m.b.id)); }
  for (const k of sv.keys) {
    const l = links[k];
    for (const x of [l.a, l.b]) {
      const i = env.cellMetro.get(x);
      if (i != null) set.add(i);
    }
  }
  return [...set].sort((p, q) => p - q);
}

/** Extra growth a year at each station of one service: [[city index, rate]]. world = state.cities. */
function stationGrowth(env, idx, world) {
  let total = 0;
  for (const i of idx) total += world[env.cities[i].id].gdp;
  return idx.map((i) => [i, total > 0 ? (EXPRESS_GROWTH * (total - world[env.cities[i].id].gdp)) / total : 0]);
}

/**
 * Extra growth a year per region metro (index-aligned with env.cities) from the services that run this year.
 * world = state.cities (the current GDPs).
 */
export function expressBonus(env, links, served, express, world) {
  const out = new Array(env.cities.length).fill(0);
  for (const id of Object.keys(express || {}).sort()) {
    if (!corridorStatus(env, links, served, id).ok) continue;
    const idx = stations(env, links, served.get(id), env.contractById.get(id));
    for (const [i, g] of stationGrowth(env, idx, world)) out[i] += g;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(EXPRESS_CAP, out[i]);
  return out;
}

/**
 * Every corridor on the network, for the panel and the bot: served contracts with a metro at both ends.
 * → [{id, c, a, b, cost, ops, on (launched), ok, why, keys, stops (station metros), gain (extra GDP a year in $, at
 *    today's sizes, before the per-metro cap)}]
 */
export function corridors(env, state, served) {
  const out = [];
  for (const [id] of served) {
    const c = env.contractById.get(id);
    const m = corridor(env, c);
    if (!m) continue;
    const st = corridorStatus(env, state.links, served, id);
    const idx = stations(env, state.links, served.get(id), c);
    let gain = 0;
    for (const [i, g] of stationGrowth(env, idx, state.cities)) gain += g * state.cities[env.cities[i].id].gdp;
    out.push({ id, c, a: m.a, b: m.b, cost: expressCost(c), ops: expressOps(c), on: !!state.express?.[id], ...st, stops: idx.length, gain });
  }
  return out.sort((x, y) => y.gain - x.gain || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
