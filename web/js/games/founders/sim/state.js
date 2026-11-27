// Founders: game state, the environment (terrain + hex helpers), ownership and town output. Pure, JSON state.
//
// state = {
//   v, seed, turn (1..maxTurns), maxTurns, phase: "setup" | "play" | "over",
//   materials, wealth (all trade ever earned), rng (mulberry32 state),
//   towns: [{id, name, cell, pop, food, culture, radius, focus, pins: [cell], founded,
//            projects: [projectId], grown (turn of the last homesteaders), fest (turn of the last festival)}],
//   parties: [{id, cell, moves, target}],
//   improvements: {cell: type},
//   links: [{id, a, b, kind: "road" | "rail", path: [cell]}],
//   starts: [{cell, label}], log: [{turn, kind, text}], nextId, stats: {built, events}
//   multiplayer only (match.js; absent solo): seat, nations, rivals: [{seat, towns: [{id, cell, radius, founded, name}]}]
// }
import { makeHexMap } from "../../shared/hexmap.js";
import { makeRng } from "../../shared/rng.js";
import { buildTerrain } from "./terrain.js";
import { baseYields, hexYield, moveCost, IMPROVEMENTS } from "./yields.js";

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
  cultureR4: 150,
  maxRadius: 4,
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
  // Materials sinks (v0.2): costs that rise with how many you own, upkeep, town projects, materials → people/culture.
  improveStep: 0.12, // each improvement of a kind you already own makes the next one 12% dearer
  projectStep: 0.25, // each copy of a project you already own makes the next one 25% dearer
  upkeepPerPop: 2, // every town costs 1 material a turn per 2 people
  railUpkeep: 1, // and every rail line 1 a turn
  growBase: 15, // homesteaders: +1 person for 15 + 6 × people, once a turn per town
  growPerPop: 6,
  festivalCost: 25, // festival: +8 culture, once a turn per town
  festivalCulture: 8,
};

/**
 * Town projects: one of each per town, bought with materials. Effects are applied in townOutput (food, trade,
 * materials), endTurn (culture) and townGrowthNeed (granary).
 */
export const PROJECTS = {
  granary: { id: "granary", name: "Granary", icon: "🧺", cost: 40, minPop: 2, food: 2,
    text: "+2 food, and growing needs 25% less food" },
  school: { id: "school", name: "School", icon: "🏫", cost: 50, minPop: 3, culture: 3,
    text: "+3 culture a turn: wider borders, and culture scores" },
  market: { id: "market", name: "Market", icon: "🏪", cost: 60, minPop: 4, tradePct: 50,
    text: "+50% trade in this town" },
  harbor: { id: "harbor", name: "Harbor works", icon: "🚢", cost: 80, minPop: 3, food: 2, trade: 3, water: true,
    text: "+2 food, +3 trade (a town on the coast, a lake or a large river)" },
  depot: { id: "depot", name: "Rail depot", icon: "🚉", cost: 90, minPop: 4, fromTurn: 25, perRail: { trade: 2, materials: 1 },
    text: "Each rail line from this town gives +2 trade and +1 materials more" },
  college: { id: "college", name: "College", icon: "🎓", cost: 140, minPop: 8, culture: 6, trade: 2, needs: "school", fromTurn: 20,
    text: "+6 culture and +2 trade a turn (needs a school)" },
};

const round5 = (x) => Math.round(x / 5) * 5;
const countImprovements = (state, kind) => {
  let n = 0;
  for (const k in state.improvements) if (state.improvements[k] === kind) n++;
  return n;
};
/** What the next improvement of `kind` costs: the base cost, +12% for each one of that kind you already own. */
export function improvementCost(state, kind) {
  const imp = IMPROVEMENTS[kind];
  return imp ? Math.round(imp.cost * (1 + RULES.improveStep * countImprovements(state, kind))) : Infinity;
}
/** What the next copy of project `id` costs: the base cost, +25% for each town that already has it. */
export function projectCost(state, id) {
  const p = PROJECTS[id];
  if (!p) return Infinity;
  const n = state.towns.filter((t) => t.projects?.includes(id)).length;
  return round5(p.cost * (1 + RULES.projectStep * n));
}
export const hasProject = (town, id) => !!town.projects?.includes(id);
/** Food a town needs in store to grow (a granary cuts it by a quarter). */
export const townGrowthNeed = (town) => {
  const n = growthNeed(town.pop);
  return hasProject(town, "granary") ? Math.ceil(n * 0.75) : n;
};
/** Homesteaders: materials for +1 person in this town now. */
export const growCost = (town) => RULES.growBase + RULES.growPerPop * town.pop;
/** Upkeep a town costs a turn: 1 per 2 people, plus half of each rail line it ends (a line costs 1 in all). */
export function townUpkeep(state, town) {
  let rails = 0;
  for (const l of state.links) if (l.kind === "rail" && (l.a === town.id || l.b === town.id)) rails++;
  return Math.floor(town.pop / RULES.upkeepPerPop) + (rails * RULES.railUpkeep) / 2;
}

export const FOCI = ["balanced", "food", "materials", "trade"];

/** Settlers get dearer as the country grows: 25, then +8 for every town or party beyond the first. */
export const partyCost = (state) => RULES.partyCost + 8 * Math.max(0, state.towns.length + state.parties.length - 1);

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
const foreignCache = new WeakMap();
/**
 * owners(env, state) → Int32Array: town id owning each cell, 0 = none (or a rival's). Towns claim in founding order:
 * every US land cell within its radius that no earlier town holds.
 *
 * Multiplayer (match.js) adds state.seat, state.nations and state.rivals = [{seat, towns: [{id, cell, radius,
 * founded, name}]}]: every nation's towns claim together, ordered by founding turn and, within a turn, by that turn's
 * seat priority (claimRank). Land a rival holds is 0 here (not yours) and its seat + 1 in foreignOwners().
 */
// Claims depend only on the towns (id, cell, radius, founding turn), the rivals' towns and the seat, not on the
// rest of the state. Every action makes a new state object, so besides the per-object cache the maps are shared
// between states with the same towns (a small cache per env, by a signature of exactly those fields). The arrays are
// read-only for every caller.
const sigCache = new WeakMap(); // env → Map<signature, {o, f}>
const SIG_MAX = 64;
function claimSig(state) {
  let k = `${state.seat ?? ""}/${state.nations ?? ""}|`;
  for (const t of state.towns) k += `${t.id},${t.cell},${t.radius},${t.founded};`;
  for (const r of state.rivals || []) {
    k += `|${r.seat}:`;
    for (const t of r.towns) k += `${t.cell},${t.radius},${t.founded};`;
  }
  return k;
}
export function owners(env, state) {
  let o = claimCache.get(state);
  if (o) return o;
  let byEnv = sigCache.get(env);
  if (!byEnv) sigCache.set(env, (byEnv = new Map()));
  const sig = claimSig(state);
  const hit = byEnv.get(sig);
  if (hit) {
    claimCache.set(state, hit.o);
    if (hit.f) foreignCache.set(state, hit.f);
    return hit.o;
  }
  o = computeOwners(env, state);
  if (byEnv.size >= SIG_MAX) byEnv.delete(byEnv.keys().next().value);
  byEnv.set(sig, { o, f: foreignCache.get(state) || null });
  return o;
}
function computeOwners(env, state) {
  let o;
  const { T, map } = env;
  o = new Int32Array(T.size);
  if (!state.rivals?.length) {
    for (const t of state.towns) o[t.cell] = t.id; // centres first, so a town always owns its own hex
    for (const t of state.towns) {
      for (const c of map.within(t.cell, t.radius)) if (T.land[c] && !o[c]) o[c] = t.id;
    }
    claimCache.set(state, o);
    return o;
  }
  // multiplayer: rival claims are written as −(seat + 1), then split off into foreignOwners
  const all = [];
  state.towns.forEach((t, k) => all.push({ t, mark: t.id, rank: claimRank(state, t.founded, state.seat), k }));
  for (const r of state.rivals) r.towns.forEach((t, k) => all.push({ t, mark: -(r.seat + 1), rank: claimRank(state, t.founded, r.seat), k }));
  all.sort((a, b) => a.rank - b.rank || a.k - b.k);
  for (const x of all) if (!o[x.t.cell]) o[x.t.cell] = x.mark;
  for (const x of all) for (const c of map.within(x.t.cell, x.t.radius)) if (T.land[c] && !o[c]) o[c] = x.mark;
  const f = new Int8Array(T.size);
  for (let i = 0; i < o.length; i++) if (o[i] < 0) { f[i] = -o[i]; o[i] = 0; }
  claimCache.set(state, o);
  foreignCache.set(state, f);
  return o;
}
/** Multiplayer: seat + 1 of the rival holding each cell (0 = nobody, or you). All zeros in a solo game. */
export function foreignOwners(env, state) {
  owners(env, state);
  return foreignCache.get(state) || new Int8Array(env.T.size);
}
/** Claim order of a town founded on `turn` by `seat`: earlier turns first; within a turn the seats take turns going first. */
export const claimRank = (state, turn, seat) => {
  const n = state.nations || 1;
  return turn * 8 + ((((seat - turn) % n) + n) % n);
};

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
  let links = 0, rails = 0;
  for (const l of state.links) {
    if (l.a !== town.id && l.b !== town.id) continue;
    links++;
    if (l.kind === "rail") { rails++; trade += RULES.railTrade; materials += RULES.railMaterials; } else trade += RULES.roadTrade;
  }
  // Projects.
  let culture = 0;
  for (const id of town.projects || []) {
    const p = PROJECTS[id];
    if (!p) continue;
    food += p.food || 0;
    trade += p.trade || 0;
    culture += p.culture || 0;
    if (p.perRail) { trade += p.perRail.trade * rails; materials += p.perRail.materials * rails; }
  }
  if (hasProject(town, "market")) trade += Math.floor((trade * PROJECTS.market.tradePct) / 100);
  return { food, materials, trade, culture, eat, surplus: food - eat, worked, tiles, links };
}

/**
 * Totals over all towns. income = the net materials a turn: town materials + a quarter of trade − upkeep
 * (gross = before upkeep).
 */
export function nationOutput(env, state) {
  let food = 0, materials = 0, trade = 0, pop = 0, culture = 0, upkeep = 0;
  for (const t of state.towns) {
    const o = townOutput(env, state, t);
    food += o.food; materials += o.materials; trade += o.trade; pop += t.pop; culture += t.culture;
    upkeep += townUpkeep(state, t);
  }
  upkeep = Math.floor(upkeep);
  const gross = materials + Math.floor(trade / RULES.tradeToMaterials);
  return { food, materials, trade, pop, culture, gross, upkeep, income: gross - upkeep };
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
  if (state.rivals?.length) {
    for (const r of state.rivals) for (const t of r.towns) {
      if (map.dist(t.cell, cell) < RULES.minTownDist) return `Too close to ${t.name}, a rival town (towns must be ${RULES.minTownDist}+ hexes apart)`;
    }
    if (foreignOwners(env, state)[cell]) return "A rival nation holds this land";
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
  for (const r of state.rivals || []) for (const t of r.towns) used.add(t.name); // multiplayer: no name twice on the map
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
