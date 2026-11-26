// Founders: game state, the environment (terrain + hex helpers), ownership and town output. Pure, JSON state.
//
// state = {
//   v, seed, turn (1..maxTurns), maxTurns, phase: "setup" | "play" | "over",
//   materials, wealth (all trade ever earned), rng (mulberry32 state),
//   towns: [{id, name, cell, pop, food, culture, radius, focus, pins: [cell], founded}],
//   parties: [{id, cell, moves, target}],
//   improvements: {cell: type},
//   links: [{id, a, b, kind: "road" | "rail", path: [cell]}],
//   starts: [{cell, label}], log: [{turn, kind, text}], nextId, stats: {built, events}
// }
import { makeHexMap } from "../../shared/hexmap.js";
import { makeRng } from "../../shared/rng.js";
import { buildTerrain } from "./terrain.js";
import { baseYields, hexYield, moveCost } from "./yields.js";

export const RULES = {
  maxTurns: 60,
  startYear: 1790,
  yearsPerTurn: 4,
  startMaterials: 20,
  minTownDist: 3,
  partyCost: 25,
  partyMoves: 3,
  foodPerPop: 2,
  growthBase: 8,
  growthPerPop: 4,
  cultureR2: 12,
  cultureR3: 60,
  maxRadius: 3,
  roadPerHex: 3,
  railPerHex: 5,
  railTurn: 25, // rail opens in 1890
  maxLinkLen: 12,
  roadTrade: 2,
  railTrade: 5,
  railMaterials: 1,
  tradeToMaterials: 4, // every 4 trade also yields 1 material (markets)
  eventChance: 0.3,
  eventFromTurn: 4,
};

export const FOCI = ["balanced", "food", "materials", "trade"];

/** Settlers get dearer as the country grows: 25, then +6 for every town or party beyond the first. */
export const partyCost = (state) => RULES.partyCost + 6 * Math.max(0, state.towns.length + state.parties.length - 1);

export const yearOf = (turn) => RULES.startYear + (turn - 1) * RULES.yearsPerTurn;

/** env = everything the sim needs that is not state: built once from the data files. */
export function makeEnv({ world, resources = null, hazards = null }) {
  const T = buildTerrain(world, resources);
  const map = makeHexMap(world);
  baseYields(T);
  return { T, map, hazards };
}

export const clone = (s) => JSON.parse(JSON.stringify(s));

/** A new game: setup phase with start options (no party yet unless a start is given). */
export function newGame(env, seed, { start = null } = {}) {
  const rng = makeRng(`founders:${seed}`);
  const starts = startOptions(env, seed);
  const s = {
    v: 1, seed: String(seed), turn: 1, maxTurns: RULES.maxTurns, phase: "setup",
    materials: RULES.startMaterials, wealth: 0, rng: rng.state,
    towns: [], parties: [], improvements: {}, links: [], starts,
    log: [], nextId: 1, stats: { built: 0, events: 0, founded: 0 },
  };
  return start == null ? s : chooseStart(env, s, start);
}

/** Leave setup: put the first founding party on `cell` (one of the starts, or any valid land hex). */
export function chooseStart(env, state, cell) {
  if (state.phase !== "setup") return state;
  if (!env.T.land[cell] || env.T.relief[cell] >= 3) return state;
  const s = clone(state);
  s.phase = "play";
  s.parties.push({ id: s.nextId++, cell, moves: RULES.partyMoves, target: null });
  s.log.push({ turn: s.turn, kind: "info", text: "Your founding party has arrived. Found your first town." });
  return s;
}

// --- start options -------------------------------------------------------------------------------------------------

/** Quality of a site: what a town there could work (centre + two rings), food weighted. */
export function siteScore(env, cell) {
  const { T, map } = env;
  if (!T.land[cell]) return -1;
  const b = baseYields(T);
  let sc = 0;
  for (const c of map.within(cell, 2)) {
    if (!T.land[c]) continue;
    const ring = c === cell ? 2 : map.dist(c, cell) === 1 ? 1 : 0.6;
    sc += ring * (b.food[c] * 1.4 + b.materials[c] + b.trade[c] * 0.8);
  }
  return sc;
}

const REGION_LABEL = ["Western", "Mountain and Plains", "Heartland", "Eastern"];

/**
 * Four fair starts, one per west→east quarter of the country: coastal or river hexes, not on peaks, from the
 * 65th–92nd percentile of all such sites (good, never the very best), picked with the seed.
 */
export function startOptions(env, seed) {
  const { T, map } = env;
  const rng = makeRng(`founders-starts:${seed}`);
  const xs = T.landCells.map((c) => map.grid.cx(c)).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => xs[Math.floor(xs.length * f)]);
  const cands = [];
  for (const c of T.landCells) {
    if (T.relief[c] >= 2) continue;
    if (!(T.coast[c] || T.lake[c] || (T.river[c] && T.river[c] <= 6))) continue;
    cands.push({ cell: c, score: siteScore(env, c) });
  }
  const sorted = cands.map((c) => c.score).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.65)], hi = sorted[Math.floor(sorted.length * 0.92)];
  const out = [];
  for (let r = 0; r < 4; r++) {
    const inRegion = cands.filter((c) => {
      const x = map.grid.cx(c.cell);
      return (r === 0 || x >= q[r - 1]) && (r === 3 || x < q[r]);
    });
    let pool = inRegion.filter((c) => c.score >= lo && c.score <= hi);
    if (!pool.length) pool = inRegion.slice().sort((a, b) => Math.abs(a.score - hi) - Math.abs(b.score - hi)).slice(0, 10);
    if (!pool.length) continue;
    const pick = pool[Math.floor(rng.next() * pool.length)];
    out.push({ cell: pick.cell, label: `${REGION_LABEL[r]} ${describeSite(T, pick.cell)}`, score: Math.round(pick.score) });
  }
  return out;
}

export function describeSite(T, c) {
  if (T.coast[c]) return "coast";
  if (T.lake[c]) return "lake shore";
  if (T.river[c]) return `${T.riverName[c] || "river"} valley`;
  return "plain";
}

// --- ownership and output ------------------------------------------------------------------------------------------

const claimCache = new WeakMap();
/**
 * owners(env, state) → Int32Array: town id owning each cell, 0 = none. Towns claim in founding order: every US land
 * cell within its radius that no earlier town holds.
 */
export function owners(env, state) {
  let o = claimCache.get(state);
  if (o) return o;
  const { T, map } = env;
  o = new Int32Array(T.size);
  for (const t of state.towns) o[t.cell] = t.id; // centres first, so a town always owns its own hex
  for (const t of state.towns) {
    for (const c of map.within(t.cell, t.radius)) if (T.land[c] && !o[c]) o[c] = t.id;
  }
  claimCache.set(state, o);
  return o;
}

export const townById = (state, id) => state.towns.find((t) => t.id === id) || null;
export const townAt = (state, cell) => state.towns.find((t) => t.cell === cell) || null;
export const partyById = (state, id) => state.parties.find((p) => p.id === id) || null;

/** Tile value for choosing which hexes a town works: food counts double while the town is short of a modest surplus. */
function tileValue(y, focus, hungry) {
  const wf = hungry ? 2.2 : 0.7;
  const k = { food: 1, materials: 1, trade: 1 };
  if (focus !== "balanced" && k[focus]) k[focus] = 3;
  return y.food * wf * k.food + y.materials * 1.3 * k.materials + y.trade * 1.0 * k.trade;
}

/**
 * townOutput(env, state, town) → {food, materials, trade, eat, surplus, worked: [cell], tiles: [cell], links}
 * The centre is always worked, then `pop` hexes: pinned ones first, then the best by the town's focus.
 */
export function townOutput(env, state, town) {
  const { T, map } = env;
  const own = owners(env, state);
  const tiles = [];
  for (const c of map.within(town.cell, town.radius)) if (own[c] === town.id && c !== town.cell) tiles.push(c);
  const y = (c) => hexYield(T, c, state.improvements[c] || null, false);
  const center = hexYield(T, town.cell, state.improvements[town.cell] || null, true);
  const eat = town.pop * RULES.foodPerPop;
  const pins = (town.pins || []).filter((c) => tiles.includes(c)).slice(0, town.pop);
  const rest = tiles.filter((c) => !pins.includes(c));
  const pinnedFoodOf = (list, yf, ctr) => list.reduce((a, c) => a + yf(c).food, ctr.food);
  // Greedy: each free person takes the best hex left, valuing food highly until the town has a surplus of 3+.
  const worked = pins.slice();
  let fsum = pinnedFoodOf(pins, y, center);
  const left = rest.slice();
  while (worked.length < town.pop && left.length) {
    const hungry = fsum < eat + 3;
    let bi = 0, bv = -Infinity;
    for (let k = 0; k < left.length; k++) {
      const v = tileValue(y(left[k]), town.focus, hungry);
      if (v > bv || (v === bv && left[k] < left[bi])) { bv = v; bi = k; }
    }
    const c = left.splice(bi, 1)[0];
    worked.push(c);
    fsum += y(c).food;
  }
  let food = center.food, materials = center.materials, trade = center.trade;
  for (const c of worked) { const v = y(c); food += v.food; materials += v.materials; trade += v.trade; }
  let links = 0;
  for (const l of state.links) {
    if (l.a !== town.id && l.b !== town.id) continue;
    links++;
    if (l.kind === "rail") { trade += RULES.railTrade; materials += RULES.railMaterials; } else trade += RULES.roadTrade;
  }
  return { food, materials, trade, eat, surplus: food - eat, worked, tiles, links };
}

/** Totals over all towns, plus the materials income (with the market share of trade). */
export function nationOutput(env, state) {
  let food = 0, materials = 0, trade = 0, pop = 0;
  for (const t of state.towns) {
    const o = townOutput(env, state, t);
    food += o.food; materials += o.materials; trade += o.trade; pop += t.pop;
  }
  const income = materials + Math.floor(trade / RULES.tradeToMaterials);
  return { food, materials, trade, pop, income };
}

export const growthNeed = (pop) => RULES.growthBase + RULES.growthPerPop * pop;

/** Cheapest land path for a founding party (or a road), with the move costs. */
export function landPath(env, a, b, maxCost = Infinity) {
  const { T, map } = env;
  if (a === b) return { path: [a], cost: 0 };
  if (!T.land[b]) return null;
  return map.path(a, b, (_, to) => moveCost(T, to), { minStep: 1, maxCost });
}

/** Can a town be founded on `cell`? → null if yes, else the reason. */
export function foundBlocker(env, state, cell) {
  const { T, map } = env;
  if (!T.land[cell]) return "Towns go on US land";
  if (T.relief[cell] >= 3) return "Too high: no town on the peaks";
  for (const t of state.towns) {
    if (map.dist(t.cell, cell) < RULES.minTownDist) return `Too close to ${t.name} (towns must be ${RULES.minTownDist}+ hexes apart)`;
  }
  return null;
}

// --- names ---------------------------------------------------------------------------------------------------------
const PRE = ["Cedar", "Stone", "Willow", "Red", "Clear", "Elk", "Fox", "Pine", "Oak", "Iron", "Salt", "Long", "High",
  "Bright", "Maple", "Ash", "Bear", "Hawk", "Silver", "Green", "Mill", "Fair", "Spring", "Copper", "Prairie", "Granite",
  "Sandy", "Birch", "Heron", "Otter", "Juniper", "Flint", "Amber", "Crow", "Laurel", "Thistle", "Bluff", "Quail", "Larch", "Sage"];
const SUF = ["ford", "field", "haven", "ridge", "brook", "wood", "dale", "stead", "mont", "ton", "bury", "wick"];
const SUF2 = ["Landing", "Crossing", "Hollow", "Bend", "Falls", "Springs", "Point", "Grove", "Hill", "Flats", "Gap", "Meadow"];

export function townName(env, state, cell, rng) {
  const { T } = env;
  const used = new Set(state.towns.map((t) => t.name));
  for (let k = 0; k < 40; k++) {
    let n;
    const r = rng.next();
    if (T.river[cell] && T.riverName[cell] && r < 0.3) n = `${T.riverName[cell]} ${rng.pick(["Landing", "Falls", "Bend", "Crossing"])}`;
    else if (T.coast[cell] && r < 0.45) n = `${rng.pick(PRE)} Harbor`;
    else if (r < 0.75) n = rng.pick(PRE) + rng.pick(SUF);
    else n = `${rng.pick(PRE)} ${rng.pick(SUF2)}`;
    if (!used.has(n)) return n;
  }
  return `Town ${state.towns.length + 1}`;
}

/** The rng for an action or turn, restored from state; call save(s) to put its state back. */
export function rngOf(state) {
  const r = makeRng(1);
  r.state = state.rng;
  return r;
}
