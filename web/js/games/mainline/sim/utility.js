// Mainline utility networks (GAME_PLAN.md M6): high-voltage power lines and fibre, beside the rail network. Pure.
//
// * Power contracts: each real generation site in the region (resources.json: nuclear, hydro, wind, solar,
//   geothermal, gas and coal plants; EIA-860M capacity) is wired to one metro, the one with the most population ÷
//   distance² within POWER_RANGE_KM. The line must reach the metro's centre hex (its grid substation), so a plant
//   inside a metro's footprint still needs a line into town.
//     pay = POWER_RATE × ln(1 + MW ÷ 100) × clamp(√(metro pop ÷ 1M), 0.6, 1.6) × (1 − transition)
//   Only the best POWER_MAX sites by that pay get a contract (more on the whole-country Sandbox).
//   Coal and gas plants carry a transition cost that rises each decade (COAL / GAS below): the data's fleet is what
//   it is, and the game only prices the trend. A game model, labelled in the UI.
// * Talent contracts (fibre): the region's research metros (the top TALENT_HUBS by the Science yield in
//   cities.json, which comes from R&D jobs and degrees) linked in pairs:
//     pay = TALENT_RATE × ln(1 + √(sci_a × sci_b) ÷ 1e5) ÷ max(1, km ÷ 600)^0.5
//   and a served pair adds TALENT_GROWTH a year to both metros' GDP growth (capped per metro). Also a model.
// A contract is served when lines of its network join its two ends (any hex of the metro's footprint; the site's
// own hex for power). Lines cost a share of the rail cost of the same hexes and are not damaged by disasters in this
// version (buried and hardened by design; rail carries the risk). Upkeep: LINE_MAINT of the build cost a year.
//
// State: state.lines = {"p:<edgeKey>" | "f:<edgeKey>": {a, b, cost, year}} — created by the first line, so games that
// never build one keep exactly the state (and hash) they had before this module existed.
// Determinism: every log/sqrt result is rounded (fix) before it is added up or compared.

export const NETS = ["power", "fibre"];
export const NET_PREFIX = { power: "p", fibre: "f" };
export const LINE_FACTOR = { power: 0.6, fibre: 0.25 };
export const LINE_MAINT = 0.02;
export const POWER_RATE = 0.3;
export const POWER_MAX = 24; // contracts per scenario (Sandbox: POWER_MAX_SANDBOX), the best by base pay
export const POWER_MAX_SANDBOX = 60;
export const POWER_RANGE_KM = 450;
export const TALENT_RATE = 0.9;
export const TALENT_HUBS = 8;
export const TALENT_PAIRS = 12;
export const TALENT_GROWTH = 0.0015;
export const TALENT_CAP = 0.003;
export const POWER_TYPES = ["nuclear", "hydro", "wind", "solar", "geothermal", "gas_plant", "coal_plant"];
// Share of a contract's pay lost to the transition, by decade: 2020s, 2030s, 2040s, 2050.
export const TRANSITION = { coal_plant: [0, 0.2, 0.4, 0.6], gas_plant: [0, 0.1, 0.2, 0.3] };
export const transitionShare = (type, year) => (TRANSITION[type] ? TRANSITION[type][Math.max(0, Math.min(3, Math.floor((year - 2020) / 10)))] : 0);

const fix = (x, k = 1e6) => Math.round(x * k) / k;
const r1 = (x) => Math.round(x * 10) / 10;
export const lineKey = (net, edgeKey) => `${NET_PREFIX[net]}:${edgeKey}`;

/** Build the region's power and talent contracts. env: cities (region metros with cells), cityById, inRegion, km. */
export function buildUtility(env, resources) {
  const power = [];
  const region = env.cities;
  const centres = new Set(region.map((c) => c.cell));
  for (const s of resources?.items || []) {
    if (!POWER_TYPES.includes(s.type) || !(s.value > 0) || !Number.isInteger(s.cell) || !env.inRegion(s.cell) || env.region[s.cell] !== 1) continue;
    if (centres.has(s.cell)) continue; // already at a metro's substation: nothing to wire
    let best = null, bestW = 0;
    for (const c of region) {
      const d = env.km(s.cell, c.cell);
      if (d > POWER_RANGE_KM) continue;
      const w = c.population / Math.max(50, d) ** 2;
      if (w > bestW || (w === bestW && best && c.id < best.id)) { best = c; bestW = w; }
    }
    if (!best) continue;
    const popF = Math.min(1.6, Math.max(0.6, fix(Math.sqrt(best.population / 1e6))));
    power.push({
      id: `pw:${s.type}:${s.cell}`, kind: "power", type: s.type, name: s.name, mw: s.value, cell: s.cell, city: best.id,
      km: Math.round(env.km(s.cell, best.cell)),
      base: fix(POWER_RATE * fix(Math.log(1 + s.value / 100)) * popF),
    });
  }
  power.sort((a, b) => b.base - a.base || (a.id < b.id ? -1 : 1));
  power.length = Math.min(power.length, env.scenario?.id === "sandbox" ? POWER_MAX_SANDBOX : POWER_MAX);

  const sci = (c) => env.cityById.get(c.id)?.yields?.science || 0;
  const hubs = region.filter((c) => sci(c) > 0).sort((a, b) => sci(b) - sci(a) || (a.id < b.id ? -1 : 1)).slice(0, TALENT_HUBS);
  const pairs = [];
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const A = hubs[i], B = hubs[j];
      const d = env.km(A.cell, B.cell);
      const base = fix(TALENT_RATE * fix(Math.log(1 + fix(Math.sqrt(sci(A) * sci(B))) / 1e5)) / fix(Math.sqrt(Math.max(1, d / 600))));
      const [a, b] = A.id < B.id ? [A, B] : [B, A];
      pairs.push({ id: `tl:${a.id}-${b.id}`, kind: "talent", a: a.id, b: b.id, km: Math.round(d), base });
    }
  }
  pairs.sort((x, y) => y.base - x.base || (x.id < y.id ? -1 : 1));
  const talent = pairs.slice(0, TALENT_PAIRS);
  return {
    power, talent, talentHubs: hubs.map((c) => c.id),
    byId: new Map([...power, ...talent].map((c) => [c.id, c])),
  };
}

/** Cost of one line segment, or Infinity where rail could not go either. */
export function lineCost(env, net, a, b) {
  const c = env.edgeCost(a, b);
  return c < Infinity ? r1(Math.max(0.1, c * LINE_FACTOR[net])) : Infinity;
}

/** Cells each network's lines touch: {power: Set, fibre: Set}. */
export function lineCells(state) {
  const out = { power: new Set(), fibre: new Set() };
  for (const [k, l] of Object.entries(state.lines || {})) {
    const s = k[0] === "p" ? out.power : out.fibre;
    s.add(l.a); s.add(l.b);
  }
  return out;
}

/** Union-find over one network's lines → find(cell) (a cell with no line is its own root). */
function components(state, net) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let y = x;
    while (parent.has(y) && parent.get(y) !== r) { const n = parent.get(y); parent.set(y, r); y = n; }
    return r;
  };
  const p = NET_PREFIX[net];
  for (const [k, l] of Object.entries(state.lines || {})) {
    if (k[0] !== p) continue;
    if (!parent.has(l.a)) parent.set(l.a, l.a);
    if (!parent.has(l.b)) parent.set(l.b, l.b);
    const ra = find(l.a), rb = find(l.b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  return { find, has: (x) => parent.has(x) };
}

const cityCells = (env, id) => env.cities[env.cityIdx.get(id)]?.cells || [];
function joins(comp, cellsA, cellsB) {
  const roots = new Set();
  for (const x of cellsA) if (comp.has(x)) roots.add(comp.find(x));
  if (!roots.size) return false;
  for (const x of cellsB) if (comp.has(x) && roots.has(comp.find(x))) return true;
  return false;
}

/**
 * What the lines earn this year. growthOf(ids) → the cities' GDP growth since the start (as freight uses).
 * → {power: Map<id, pay>, talent: Map<id, pay>, revenue, extra: per-city growth (index-aligned with env.cities) | null}
 */
export function serveUtility(env, state, growthOf = null) {
  const out = { power: new Map(), talent: new Map(), revenue: 0, extra: null };
  if (!state.lines || !env.utility) return out;
  const pw = components(state, "power"), fb = components(state, "fibre");
  let rev = 0;
  for (const c of env.utility.power) {
    const centre = env.cities[env.cityIdx.get(c.city)]?.cell;
    if (!pw.has(c.cell) || !joins(pw, [c.cell], [centre])) continue;
    const g = growthOf ? growthOf([c.city]) : 1;
    const pay = fix(c.base * (1 - transitionShare(c.type, state.year)) * g);
    out.power.set(c.id, pay);
    rev += pay;
  }
  let extra = null;
  for (const c of env.utility.talent) {
    if (!joins(fb, cityCells(env, c.a), cityCells(env, c.b))) continue;
    const g = growthOf ? growthOf([c.a, c.b]) : 1;
    const pay = fix(c.base * g);
    out.talent.set(c.id, pay);
    rev += pay;
    extra ||= new Array(env.cities.length).fill(0);
    for (const id of [c.a, c.b]) {
      const i = env.cityIdx.get(id);
      if (i != null) extra[i] = Math.min(TALENT_CAP, extra[i] + TALENT_GROWTH);
    }
  }
  out.revenue = r1(rev);
  out.extra = extra;
  return out;
}

/** Yearly upkeep of every line. */
export const lineMaintenance = (state) => {
  let s = 0;
  for (const l of Object.values(state.lines || {})) s += Math.max(0.02, LINE_MAINT * l.cost);
  return s;
};

/** Cells a new line of `net` may start from: its own lines, its contract ends, and the home metro. */
export function lineAnchors(env, state, net) {
  const s = new Set(lineCells(state)[net]);
  for (const x of env.homeCells) s.add(x);
  if (net === "power") for (const c of env.utility?.power || []) { s.add(c.cell); s.add(env.cities[env.cityIdx.get(c.city)]?.cell); }
  else for (const id of env.utility?.talentHubs || []) for (const x of cityCells(env, id)) s.add(x);
  return s;
}

/** Cheapest route for a new line from `from` to `to`, reusing the same network's lines. → like state.plan(). */
export function planLine(env, state, net, from, to) {
  if (!env.inRegion(from) || !env.inRegion(to)) return { path: null, cost: Infinity, error: "Outside this scenario's region" };
  const hm = env.hexmap;
  const lines = state.lines || {};
  const step = (a, b) => (lines[lineKey(net, hm.edgeKey(a, b))] ? 0.01 : lineCost(env, net, a, b));
  const r = hm.path(from, to, step);
  if (!r) return { path: null, cost: Infinity, error: "No route: open water, foreign land or the region's edge is in the way" };
  let cost = 0, fresh = 0, km = 0;
  for (let k = 1; k < r.path.length; k++) {
    const a = r.path[k - 1], b = r.path[k];
    km += env.km(a, b);
    if (lines[lineKey(net, hm.edgeKey(a, b))]) continue;
    cost += lineCost(env, net, a, b);
    fresh++;
  }
  return { path: r.path, cost: r1(cost), fresh, km: Math.round(km) };
}
