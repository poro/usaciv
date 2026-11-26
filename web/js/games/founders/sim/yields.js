// Founders: hex output from real land data. Pure.
//
// THE FORMULA (per US land hex; shares are world.json pct.*, 0..100):
//   Food      = round((crop/25 + pasture/40 + grass/60) × relief factor)
//               + river (big river, rank 1–2: +2; rank 3–6: +1) + coast +1 + lake +1
//               relief factor: flat 1, hills 0.75, mountains 0.4, peaks 0; barren or ice land × 0.3
//   Materials = round(forest/30 + shrub/100) + relief (hills +1, mountains +2, peaks +1)
//               + resource site (mine +3, oil or gas play +2, hydro or geothermal +1)
//   Trade     = coast +2, river (rank 1–2: +2, rank 3–4: +2, rank 5–6: +1), lake +1; peaks give no trade
//               + links between your towns (road +2, rail +5 for each town at either end; see turn.js)
//   Developed land (today's cities) is given back to the open land around it (terrain.js openLand): the country is
//   empty, and a built-up hex must not give its city away by yielding less than its neighbours.
//   Wetland (40%+ of the hex) does not change output but costs 2 moves to cross.
//
// Improvements add: farmstead +2 Food, mine +3 Materials, quarry +2 Materials, dock +2 Trade +1 Food.
// A town's own hex adds +1 Food, +2 Materials, +1 Trade, and always gives at least 2 Food.
import { COVER, RELIEF, RELIEF_NAME } from "./terrain.js";

export const IMPROVEMENTS = {
  farmstead: { id: "farmstead", name: "Farmstead", cost: 15, food: 2, materials: 0, trade: 0, icon: "🌾",
    rule: "Flat or hilly land with some crop, pasture or grass (not barren)" },
  mine: { id: "mine", name: "Mine", cost: 20, food: 0, materials: 3, trade: 0, icon: "⛏️",
    rule: "A real mine, ore deposit, coal field or oil and gas play in the hex" },
  quarry: { id: "quarry", name: "Quarry", cost: 15, food: 0, materials: 2, trade: 0, icon: "🪨",
    rule: "Hills, mountains or peaks without a mine site" },
  dock: { id: "dock", name: "Dock", cost: 25, food: 1, materials: 0, trade: 2, icon: "⚓",
    rule: "On the coast, a lake shore or a large river (rank 1–4)" },
};

export const CENTER_BONUS = { food: 1, materials: 2, trade: 1, minFood: 2 };

const RELIEF_FOOD = [1, 0.75, 0.4, 0];
const RELIEF_MAT = [0, 1, 2, 1];
const SITE_MAT = { mine: 3, oilgas: 2, power: 1 };

function riverBonus(rank) {
  if (!rank) return { food: 0, trade: 0 };
  if (rank <= 2) return { food: 2, trade: 2 };
  if (rank <= 4) return { food: 1, trade: 2 };
  return { food: 1, trade: 1 };
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * explainHex(T, i) → {food, materials, trade, parts: [{label, food?, materials?, trade?, note?}]}
 * parts are the human-readable steps of the formula, for the tooltip.
 */
export function explainHex(T, i) {
  const out = { food: 0, materials: 0, trade: 0, parts: [] };
  if (!T.land[i]) return out;
  const p = T.pct;
  const crop = p.crop[i] || 0, pasture = p.pasture[i] || 0, grass = p.grass[i] || 0;
  const forest = p.forest[i] || 0, shrub = p.shrub[i] || 0;
  const rel = T.relief[i] || 0;
  const cover = T.cover[i];
  const parts = out.parts;

  let food = crop / 25 + pasture / 40 + grass / 60;
  if (crop >= 5) parts.push({ label: `${crop}% cropland`, food: round1(crop / 25) });
  if (pasture >= 5) parts.push({ label: `${pasture}% pasture`, food: round1(pasture / 40) });
  if (grass >= 5) parts.push({ label: `${grass}% grassland`, food: round1(grass / 60) });
  if (rel > 0) {
    food *= RELIEF_FOOD[rel];
    parts.push({ label: cap(RELIEF_NAME[rel]), note: rel === RELIEF.PEAKS ? "no food" : `food ×${RELIEF_FOOD[rel]}`, materials: RELIEF_MAT[rel] });
  }
  if (cover === COVER.BARREN || cover === COVER.ICE) {
    food *= 0.3;
    parts.push({ label: cover === COVER.ICE ? "Ice" : "Barren land", note: "food ×0.3" });
  }
  food = Math.round(food);

  let mat = forest / 30 + shrub / 100;
  if (forest >= 5) parts.push({ label: `${forest}% forest`, materials: round1(forest / 30) });
  if (shrub >= 20) parts.push({ label: `${shrub}% scrub`, materials: round1(shrub / 100) });
  mat = Math.round(mat) + RELIEF_MAT[rel];

  let trade = 0;
  const peaks = rel === RELIEF.PEAKS;
  if (T.river[i]) {
    const b = riverBonus(T.river[i]);
    food += peaks ? 0 : b.food;
    if (!peaks) trade += b.trade;
    parts.push({ label: `${T.riverName[i] || "River"} River`, food: peaks ? 0 : b.food, trade: peaks ? 0 : b.trade });
  }
  if (T.coast[i]) {
    food += peaks ? 0 : 1;
    if (!peaks) trade += 2;
    parts.push({ label: "Coast", food: peaks ? 0 : 1, trade: peaks ? 0 : 2 });
  }
  if (T.lake[i]) {
    food += peaks ? 0 : 1;
    if (!peaks) trade += 1;
    parts.push({ label: "Lake shore", food: peaks ? 0 : 1, trade: peaks ? 0 : 1 });
  }
  const sites = T.sites[i];
  if (sites) {
    // The best site counts (a hex with two coal mines is still one mine).
    let best = null;
    for (const s of sites) if (!best || SITE_MAT[s.kind] > SITE_MAT[best.kind]) best = s;
    mat += SITE_MAT[best.kind];
    const tname = T.typeName?.get(best.type) || best.type;
    parts.push({ label: `${tname}${best.name && best.name !== tname ? ` (${best.name})` : ""}`, materials: SITE_MAT[best.kind] });
  }
  if (T.wet[i]) parts.push({ label: `${T.pct.wetland[i] || 0}% wetland`, note: "slow: 2 moves" });

  out.food = Math.max(0, food);
  out.materials = Math.max(0, mat);
  out.trade = Math.max(0, trade);
  return out;
}

/** Plain base yield {food, materials, trade} of a hex (memoised per terrain object). */
const baseCache = new WeakMap();
export function baseYields(T) {
  let arr = baseCache.get(T);
  if (arr) return arr;
  arr = { food: new Int8Array(T.size), materials: new Int8Array(T.size), trade: new Int8Array(T.size) };
  for (const i of T.landCells) {
    const e = explainHex(T, i);
    arr.food[i] = e.food;
    arr.materials[i] = e.materials;
    arr.trade[i] = e.trade;
  }
  baseCache.set(T, arr);
  return arr;
}

/** Can improvement `type` go on hex i (terrain rule only; ownership and cost are checked in actions.js)? */
export function improvementFits(T, i, type) {
  if (!T.land[i]) return false;
  const rel = T.relief[i] || 0;
  const sites = T.sites[i] || [];
  const hasMine = sites.some((s) => s.kind === "mine" || s.kind === "oilgas");
  switch (type) {
    case "farmstead": {
      const cv = T.cover[i];
      const p = T.pct;
      return rel <= RELIEF.HILLS && cv !== COVER.BARREN && cv !== COVER.ICE && (p.crop[i] + p.pasture[i] + p.grass[i]) >= 20;
    }
    case "mine": return hasMine;
    case "quarry": return rel >= RELIEF.HILLS && !hasMine;
    case "dock": return !!(T.coast[i] || T.lake[i] || (T.river[i] && T.river[i] <= 4));
    default: return false;
  }
}

/** Yield of hex i given an improvement id (or null) and whether it is a town centre. */
export function hexYield(T, i, improvement = null, center = false) {
  const b = baseYields(T);
  let food = b.food[i], materials = b.materials[i], trade = b.trade[i];
  const imp = improvement ? IMPROVEMENTS[improvement] : null;
  if (imp) { food += imp.food; materials += imp.materials; trade += imp.trade; }
  if (center) {
    food = Math.max(CENTER_BONUS.minFood, food + CENTER_BONUS.food);
    materials += CENTER_BONUS.materials;
    trade += CENTER_BONUS.trade;
  }
  return { food, materials, trade };
}

/** Movement cost to enter hex i: Infinity off US land. */
export function moveCost(T, i) {
  if (!T.land[i]) return Infinity;
  const rel = T.relief[i] || 0;
  let c = rel === RELIEF.PEAKS ? 3 : rel === RELIEF.MOUNTAINS ? 2 : 1;
  if (T.wet[i]) c = Math.max(c, 2);
  return c;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
