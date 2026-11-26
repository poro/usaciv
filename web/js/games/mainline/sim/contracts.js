// Demand: freight contracts between places. Pure (no DOM).
//
// * "faf" contracts are the real FAF5 flows in trade.json (the 40 largest interstate flows) whose two zones both
//   reach into the scenario's region. A zone's end is any hex of its cities' footprints (or its anchor hex).
// * "model" contracts come from a gravity model between the region's metros: value = K × GDP_a × GDP_b ÷ km^α, with
//   K and α fitted (least squares on logs) to the FAF metro-to-metro flows, so model values sit on the FAF scale.
//   They are a model, and the UI labels them so.
//
// A contract is served when your intact links join its two ends. It pays every turn:
//   pay = PAY_RATE × ln(1 + value ÷ $1B) × haul × detour factor × growth of its end cities × upgrades
// where haul = √(straight km ÷ 250), clamped to 0.75..2.5 (rail earns by the ton-km, so long hauls pay more; a
// whole-country Sandbox needs that to make its long links worth building),
// where the detour factor is 1 up to a network path 1.3× the straight line and falls off after that, and
//   upgrades = (1 + DOUBLE_BONUS × share of the route's km on double track) × (1 + terminal bonus at either end)
// Determinism: Math.log / exp / pow results are rounded (fix) before anything compares, sorts or adds them up.

export const PAY_RATE = 1.5;
export const DETOUR_FREE = 1.3;
export const DOUBLE_BONUS = 0.5; // a route fully on double track pays 50% more

const fix = (x, k = 1e6) => Math.round(x * k) / k;
export const HAUL_REF_KM = 250;
export const haulFactor = (km) => Math.min(2.5, Math.max(0.75, Math.sqrt(Math.max(0, km) / HAUL_REF_KM)));
/** Base pay (cr a year) of a flow worth valueUsd a year over a straight distance of km, on a route `detour`× longer. */
export const payFor = (valueUsd, detour, km = HAUL_REF_KM) => fix(PAY_RATE * fix(Math.log(1 + valueUsd / 1e9)) * haulFactor(km) * detourFactor(detour));
export const detourFactor = (d) => (!(d > DETOUR_FREE) ? 1 : Math.max(0.35, DETOUR_FREE / d));

/** Fit ln(value / (ga·gb)) = lnK − α ln(km) over the FAF metro-to-metro routes. */
export function fitGravity(trade, cityById) {
  const zone = new Map((trade?.zones || []).map((z) => [z.id, z]));
  const gdpOf = (z) => z.cities.reduce((s, id) => s + (cityById.get(id)?.gdp || 0), 0);
  const pts = [];
  for (const r of trade?.routes || []) {
    const A = zone.get(r.a), B = zone.get(r.b);
    if (!A || !B || A.kind !== "metro" || B.kind !== "metro") continue;
    const ga = gdpOf(A), gb = gdpOf(B);
    if (!(ga > 0 && gb > 0 && r.dist_km > 0)) continue;
    pts.push([fix(Math.log(r.dist_km)), fix(Math.log((r.value_musd * 1e6) / (ga * gb)))]);
  }
  if (pts.length < 3) return { K: 1.5e-12, alpha: 0.6, n: pts.length };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : -0.6;
  const alpha = Math.min(2, Math.max(0.3, -slope));
  return { K: Math.exp(fix(my + alpha * mx)), alpha: fix(alpha), n };
}

/**
 * Build the scenario's contracts. env needs: hexmap, inRegion, cities (region metros), cityById (all), trade.
 * → [{id, kind, rank?, a: end, b: end, value (usd/yr, base year), km, mode?, commodity?}]
 *   end = {name, cells: [cell], cell (representative), cities: [city id]}
 */
export function buildContracts(env, { models = 20 } = {}) {
  const { trade, cityById } = env;
  const out = [];
  const regionCity = new Set(env.cities.map((c) => c.id));
  const cityEnd = (c) => {
    const cells = (c.footprint || [c.cell]).filter((x) => env.inRegion(x));
    if (!cells.includes(c.cell) && env.inRegion(c.cell)) cells.push(c.cell);
    return { name: c.name, cells, cell: env.inRegion(c.cell) ? c.cell : cells[0], cities: [c.id] };
  };
  // --- FAF ---
  const zone = new Map((trade?.zones || []).map((z) => [z.id, z]));
  const zoneEnd = (z) => {
    const cells = new Set();
    const cities = [];
    for (const id of z.cities || []) {
      const c = cityById.get(id);
      if (!c) continue;
      let any = false;
      for (const x of c.footprint || [c.cell]) if (env.inRegion(x)) { cells.add(x); any = true; }
      if (any) cities.push(id);
    }
    const anchor = z.anchor?.cell;
    if (anchor != null && env.inRegion(anchor)) cells.add(anchor);
    if (!cells.size) return null;
    const lead = cities.find((id) => regionCity.has(id)) || cities[0] || null;
    const leadCity = lead ? cityById.get(lead) : null;
    const cell = leadCity && env.inRegion(leadCity.cell) ? leadCity.cell : anchor != null && env.inRegion(anchor) ? anchor : [...cells][0];
    return { name: z.short || z.name, cells: [...cells].sort((p, q) => p - q), cell, cities, zone: z.id };
  };
  const fafPairs = new Set();
  for (const r of trade?.routes || []) {
    const A = zone.get(r.a), B = zone.get(r.b);
    if (!A || !B) continue;
    const a = zoneEnd(A), b = zoneEnd(B);
    if (!a || !b) continue;
    // a hex in both ends would serve the contract with no track at all: give it to neither
    const shared = new Set(a.cells.filter((x) => b.cells.includes(x)));
    if (shared.size) {
      a.cells = a.cells.filter((x) => !shared.has(x));
      b.cells = b.cells.filter((x) => !shared.has(x));
      if (!a.cells.length || !b.cells.length) continue;
      if (shared.has(a.cell)) a.cell = a.cells[0];
      if (shared.has(b.cell)) b.cell = b.cells[0];
    }
    out.push({
      id: `faf${r.rank}`, kind: "faf", rank: r.rank, a, b, value: r.value_musd * 1e6, km: Math.round(env.km(a.cell, b.cell)),
      tons: r.tons_k * 1e3, mode: r.top_mode, commodity: trade.commodities?.[r.top_commodity] || null,
    });
    for (const x of a.cities) for (const y of b.cities) fafPairs.add(pairKey(x, y));
  }
  // --- gravity model ---
  const fit = fitGravity(trade, cityById);
  env.gravity = fit;
  const pool = env.cities.filter((c) => c.metro && c.gdp > 0).slice(0, env.scenario.states ? 40 : 90);
  const cand = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const p = pool[i], q = pool[j];
      if (fafPairs.has(pairKey(p.id, q.id))) continue;
      const km = env.km(p.cell, q.cell);
      if (km < 120 || km > 1500) continue;
      // rounded to $1M before sorting: Math.pow may differ in the last digit between engines
      const value = Math.round((fit.K * p.gdp * q.gdp) / Math.pow(km, fit.alpha) / 1e6) * 1e6;
      cand.push({ p, q, km, value });
    }
  }
  cand.sort((x, y) => y.value - x.value || (x.p.id + x.q.id < y.p.id + y.q.id ? -1 : 1));
  let k = 0;
  const taken = new Set();
  const take = (c) => {
    const a = cityEnd(c.p), b = cityEnd(c.q);
    if (!a.cells.length || !b.cells.length) return false;
    const id = `m${c.p.id}-${c.q.id}`;
    if (taken.has(pairKey(c.p.id, c.q.id))) return false;
    taken.add(pairKey(c.p.id, c.q.id));
    out.push({ id, kind: "model", a, b, value: c.value, km: Math.round(c.km) });
    return true;
  };
  for (const c of cand) {
    if (k >= models) break;
    if (take(c)) k++;
  }
  // Sandbox: whatever the home metro, it gets its own best partners (so a small or remote home has work nearby)
  const home = env.home;
  if (env.scenario.homeModels && home?.gdp > 0) {
    const mine = [];
    for (const q of env.cities) {
      if (q.id === home.id || !(q.gdp > 0) || fafPairs.has(pairKey(home.id, q.id))) continue;
      const km = env.km(home.cell, q.cell);
      if (km < 120 || km > 1500) continue;
      const value = Math.round((fit.K * home.gdp * q.gdp) / Math.pow(km, fit.alpha) / 1e6) * 1e6;
      mine.push({ p: home, q, km, value });
    }
    mine.sort((x, y) => y.value - x.value || (x.q.id < y.q.id ? -1 : 1));
    let n = 0;
    for (const c of mine) {
      if (n >= env.scenario.homeModels) break;
      if (taken.has(pairKey(c.p.id, c.q.id))) { n++; continue; }
      if (take(c)) n++;
    }
  }
  out.sort((x, y) => y.value - x.value || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}
const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Network graph over links (optionally only intact ones).
 * → {adj: Map<cell, [[n, km, double 0|1]]>, comp: Map<cell, compId>}
 */
export function networkGraph(env, links, { intactOnly = true } = {}) {
  const adj = new Map();
  const add = (a, b, km, dt) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, km, dt]);
  };
  for (const key of Object.keys(links).sort()) {
    const l = links[key];
    if (intactOnly && l.d) continue;
    const km = env.km(l.a, l.b);
    add(l.a, l.b, km, l.dt ? 1 : 0);
    add(l.b, l.a, km, l.dt ? 1 : 0);
  }
  const comp = new Map();
  let id = 0;
  for (const start of [...adj.keys()].sort((p, q) => p - q)) {
    if (comp.has(start)) continue;
    const stack = [start];
    comp.set(start, id);
    while (stack.length) {
      const c = stack.pop();
      for (const [n] of adj.get(c)) if (!comp.has(n)) { comp.set(n, id); stack.push(n); }
    }
    id++;
  }
  return { adj, comp };
}

/**
 * Shortest network path from any cell of `from` to any cell of `to` that share a component, or null.
 * → {km, dkm (of it on double track), from, to, path: [cell, …]}
 */
export function networkRoute(graph, from, to) {
  const { adj, comp } = graph;
  const fromComps = new Set();
  for (const c of from) if (comp.has(c)) fromComps.add(comp.get(c));
  const targets = new Set();
  for (const c of to) if (comp.has(c) && fromComps.has(comp.get(c))) targets.add(c);
  if (!targets.size) return null;
  // Dijkstra (small graphs: a linear-scan frontier is fine and fully deterministic)
  const dist = new Map();
  const src = new Map();
  const prev = new Map();
  const dkm = new Map();
  const open = [];
  for (const c of from) if (comp.has(c) && !dist.has(c)) { dist.set(c, 0); dkm.set(c, 0); src.set(c, c); open.push(c); }
  const done = new Set();
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) {
      const dk = dist.get(open[k]), db = dist.get(open[bi]);
      if (dk < db || (dk === db && open[k] < open[bi])) bi = k;
    }
    const c = open[bi];
    open.splice(bi, 1);
    if (done.has(c)) continue;
    done.add(c);
    if (targets.has(c)) {
      const path = [c];
      while (prev.has(path[path.length - 1])) path.push(prev.get(path[path.length - 1]));
      return { km: dist.get(c), dkm: dkm.get(c), from: src.get(c), to: c, path: path.reverse() };
    }
    for (const [n, km, dt] of adj.get(c) || []) {
      const nd = dist.get(c) + km;
      if (!done.has(n) && nd < (dist.get(n) ?? Infinity)) {
        if (!dist.has(n)) open.push(n);
        dist.set(n, nd);
        dkm.set(n, dkm.get(c) + (dt ? km : 0));
        src.set(n, src.get(c));
        prev.set(n, c);
      }
    }
  }
  return null;
}

/** Terminal pay bonus at one end of a contract (the best terminal among its cities). */
export function hubBonus(env, hubs, end) {
  let b = 0;
  for (const id of end.cities) {
    const lv = hubs?.[id] || 0;
    if (lv) b = Math.max(b, lv * (env.hubs.get(id)?.rate || 0));
  }
  return b;
}

/**
 * Which contracts the network serves and what each pays this turn.
 * growthOf(cityIds) → value multiplier from the end cities' GDP growth since the start. hubs = state.hubs.
 * skip = {contractId: 1} for contracts this network may not serve (versus: held by a rival).
 * → Map<contract id, {pay, base (before upgrades), detour, km, dkm, value, from, to, keys: [edgeKey]}>
 */
export function serveContracts(env, graph, growthOf, hubs = null, { only = null, skip = null } = {}) {
  const out = new Map();
  const ek = env.hexmap.edgeKey;
  for (const c of only != null ? [env.contractById.get(only)].filter(Boolean) : env.contracts) {
    if (skip?.[c.id]) continue; // versus: a rival company holds it (versus.js)
    const r = networkRoute(graph, c.a.cells, c.b.cells);
    if (!r) continue;
    const straight = Math.max(env.km(r.from, r.to), 40);
    const detour = r.km / straight;
    const value = c.value * Math.sqrt(growthOf(c.a.cities) * growthOf(c.b.cities));
    const base = payFor(value, detour, c.km);
    const dshare = r.km > 0 ? r.dkm / r.km : 0;
    const hub = hubBonus(env, hubs, c.a) + hubBonus(env, hubs, c.b);
    const pay = fix(base * (1 + DOUBLE_BONUS * dshare) * (1 + hub), 1e4);
    const keys = [];
    for (let k = 1; k < r.path.length; k++) keys.push(ek(r.path[k - 1], r.path[k]));
    out.set(c.id, { pay, base, detour, km: r.km, dkm: r.dkm, hub, value, from: r.from, to: r.to, keys });
  }
  return out;
}
