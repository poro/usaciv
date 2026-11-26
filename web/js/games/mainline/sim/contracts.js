// Demand: freight contracts between places. Pure (no DOM).
//
// * "faf" contracts are the real FAF5 flows in trade.json (the 40 largest interstate flows) whose two zones both
//   reach into the scenario's region. A zone's end is any hex of its cities' footprints (or its anchor hex).
// * "model" contracts come from a gravity model between the region's metros: value = K × GDP_a × GDP_b ÷ km^α, with
//   K and α fitted (least squares on logs) to the FAF metro-to-metro flows, so model values sit on the FAF scale.
//   They are a model, and the UI labels them so.
//
// A contract is served when your intact links join its two ends. It pays every turn:
//   pay = PAY_RATE × ln(1 + value ÷ $1B) × detour factor × growth of its end cities
// where the detour factor is 1 up to a network path 1.3× the straight line and falls off after that.

export const PAY_RATE = 1.5;
export const DETOUR_FREE = 1.3;

export const payFor = (valueUsd, detour) => PAY_RATE * Math.log(1 + valueUsd / 1e9) * detourFactor(detour);
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
    pts.push([Math.log(r.dist_km), Math.log((r.value_musd * 1e6) / (ga * gb))]);
  }
  if (pts.length < 3) return { K: 1.5e-12, alpha: 0.6, n: pts.length };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : -0.6;
  const alpha = Math.min(2, Math.max(0.3, -slope));
  return { K: Math.exp(my + alpha * mx), alpha, n };
}

/**
 * Build the scenario's contracts. env needs: hexmap, inRegion, cities (region metros), cityById (all), trade.
 * → [{id, kind, rank?, a: end, b: end, value (usd/yr, base year), km, mode?, commodity?}]
 *   end = {name, cells: [cell], cell (representative), cities: [city id]}
 */
export function buildContracts(env, { models = 20 } = {}) {
  const { hexmap, trade, cityById } = env;
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
      id: `faf${r.rank}`, kind: "faf", rank: r.rank, a, b, value: r.value_musd * 1e6, km: Math.round(hexmap.km(a.cell, b.cell)),
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
      const km = hexmap.km(p.cell, q.cell);
      if (km < 120 || km > 1500) continue;
      const value = (fit.K * p.gdp * q.gdp) / Math.pow(km, fit.alpha);
      cand.push({ p, q, km, value });
    }
  }
  cand.sort((x, y) => y.value - x.value || (x.p.id + x.q.id < y.p.id + y.q.id ? -1 : 1));
  let k = 0;
  for (const c of cand) {
    if (k >= models) break;
    const a = cityEnd(c.p), b = cityEnd(c.q);
    if (!a.cells.length || !b.cells.length) continue;
    k++;
    out.push({ id: `m${c.p.id}-${c.q.id}`, kind: "model", a, b, value: Math.round(c.value / 1e6) * 1e6, km: Math.round(c.km) });
  }
  out.sort((x, y) => y.value - x.value);
  return out;
}
const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Network graph over links (optionally only intact ones). → {adj: Map<cell, [[n, km]]>, comp: Map<cell, compId>}
 */
export function networkGraph(env, links, { intactOnly = true } = {}) {
  const adj = new Map();
  const add = (a, b, km) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, km]);
  };
  for (const key of Object.keys(links).sort()) {
    const l = links[key];
    if (intactOnly && l.d) continue;
    const km = env.hexmap.km(l.a, l.b);
    add(l.a, l.b, km);
    add(l.b, l.a, km);
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

/** Shortest network path (km) from any cell of `from` to any cell of `to` that share a component, or null. */
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
  const open = [];
  for (const c of from) if (comp.has(c) && !dist.has(c)) { dist.set(c, 0); src.set(c, c); open.push(c); }
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
    if (targets.has(c)) return { km: dist.get(c), from: src.get(c), to: c };
    for (const [n, km] of adj.get(c) || []) {
      const nd = dist.get(c) + km;
      if (!done.has(n) && nd < (dist.get(n) ?? Infinity)) {
        if (!dist.has(n)) open.push(n);
        dist.set(n, nd);
        src.set(n, src.get(c));
      }
    }
  }
  return null;
}

/**
 * Which contracts the network serves and what each pays this turn.
 * growthOf(cityIds) → value multiplier from the end cities' GDP growth since the start.
 * → Map<contract id, {pay, detour, km, from, to}>
 */
export function serveContracts(env, graph, growthOf) {
  const out = new Map();
  for (const c of env.contracts) {
    const r = networkRoute(graph, c.a.cells, c.b.cells);
    if (!r) continue;
    const straight = Math.max(env.hexmap.km(r.from, r.to), 40);
    const detour = r.km / straight;
    const value = c.value * Math.sqrt(growthOf(c.a.cities) * growthOf(c.b.cities));
    out.set(c.id, { pay: payFor(value, detour), detour, km: r.km, value, from: r.from, to: r.to });
  }
  return out;
}
