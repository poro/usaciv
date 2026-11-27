// Settle: one region of the real map with its cities hidden (as in Founders); place five settlements where you think
// the most Americans actually live. Pure (no DOM): the browser and the Worker build the same puzzle and score the same
// sites.
//
// People per hex come from the Census: each county's population (counties.json) shared among its hexes by their
// developed land (NLCD, world.json pct.developed, in percent) plus a small floor, so a big western county's people sit
// in its city, not spread over its desert. A settlement counts the people on its own hex and the six
// around it (RADIUS 1, about 75 km across), inside the region only. Settlements stand at least MIN_APART hexes apart,
// so their circles never overlap. Par: the game's own placement (the best circle first, then the best one that keeps
// its distance, and so on). Score = 1000 × your people ÷ par's.
import { makeRng } from "../../shared/rng.js";

export const SITES = 5;
export const RADIUS = 1;
export const MIN_APART = 3;
export const MAX_SCORE = 2000; // a bound for race progress

export const REGIONS = [
  { id: "pnw", name: "the Pacific Northwest", states: ["WA", "OR", "ID"] },
  { id: "cal", name: "California and Nevada", states: ["CA", "NV"] },
  { id: "sw", name: "the Southwest", states: ["AZ", "NM", "UT", "CO"] },
  { id: "plains", name: "the Northern Plains and Rockies", states: ["MT", "WY", "ND", "SD", "NE", "KS"] },
  { id: "tx", name: "Texas and Oklahoma", states: ["TX", "OK"] },
  { id: "gulf", name: "the Gulf South", states: ["LA", "MS", "AL", "AR"] },
  { id: "se", name: "the Southeast", states: ["GA", "FL", "SC"] },
  { id: "apl", name: "the Upper South", states: ["NC", "VA", "WV", "TN", "KY"] },
  { id: "lakes", name: "the Great Lakes", states: ["MI", "OH", "IN", "IL", "WI"] },
  { id: "mw", name: "the Upper Midwest", states: ["MN", "IA", "MO"] },
  { id: "mid", name: "the Mid-Atlantic", states: ["PA", "NY", "NJ", "DE", "MD", "DC"] },
  { id: "ne", name: "New England", states: ["ME", "NH", "VT", "MA", "RI", "CT"] },
];
export const regionById = (id) => REGIONS.find((r) => r.id === id) || null;

export const DEV_FLOOR = 0.5; // weight of a hex with no developed land (percentage points)

/** Float64Array of people per hex: each county's population by its hexes' developed share (+ DEV_FLOOR); counties
 * with no hex of their own add to their centre hex. */
export function peoplePerHex(world, counties) {
  const size = world.owner.length;
  const out = new Float64Array(size);
  const dev = world.pct?.developed || [];
  const byCounty = new Map();
  for (let i = 0; i < size; i++) {
    const k = world.county[i];
    if (k >= 0 && world.owner[i] >= 0) (byCounty.get(k) || byCounty.set(k, []).get(k)).push(i);
  }
  const iPop = counties.columns.indexOf("population"), iCell = counties.columns.indexOf("cell");
  counties.rows.forEach((r, k) => {
    const cells = byCounty.get(k);
    const pop = r[iPop] || 0;
    if (!pop) return;
    // a county smaller than a hex (Manhattan, Philadelphia, Virginia's cities) owns none: its people go to its centre hex
    if (!cells?.length) { const c = iCell >= 0 ? r[iCell] : -1; if (c >= 0 && c < size && world.owner[c] >= 0) out[c] += pop; return; }
    let tot = 0;
    for (const c of cells) tot += (dev[c] || 0) + DEV_FLOOR;
    for (const c of cells) out[c] += (pop * ((dev[c] || 0) + DEV_FLOOR)) / tot;
  });
  return out;
}

/** {world, hexmap, cellPop, regionCells: Map<regionId, Int32Array of land cells>} */
export function settleEnv({ world, counties }, hexmap) {
  const cellPop = peoplePerHex(world, counties);
  const abbrOf = world.states.map((s) => s.abbr);
  const regionCells = new Map();
  for (const r of REGIONS) {
    const set = new Set(r.states);
    const cells = [];
    for (let i = 0; i < world.owner.length; i++) if (world.owner[i] >= 0 && set.has(abbrOf[world.owner[i]])) cells.push(i);
    regionCells.set(r.id, Int32Array.from(cells));
  }
  return { world, hexmap, cellPop, regionCells };
}

/** The region for a seed: {region: regionId}. */
export function settlePuzzle(seed) {
  const rng = makeRng(seed);
  return { region: REGIONS[Math.floor(rng.next() * REGIONS.length)].id };
}
export const dailySeed = (key) => `settle:${key}`;
export const practiceSeed = (seed) => `settle-practice:${seed}`;

const inRegionSet = (E, puzzle) => {
  E._sets ||= new Map();
  if (!E._sets.has(puzzle.region)) E._sets.set(puzzle.region, new Set(E.regionCells.get(puzzle.region)));
  return E._sets.get(puzzle.region);
};

/** People within RADIUS of a cell, counting the region's hexes only. */
export function catchment(E, puzzle, cell) {
  const inR = inRegionSet(E, puzzle);
  let n = 0;
  for (const c of E.hexmap.within(cell, RADIUS)) if (inR.has(c)) n += E.cellPop[c];
  return n;
}

/** Par: {sites: [cell × SITES], people} (see the header). */
export function parSites(E, puzzle) {
  const cells = [...E.regionCells.get(puzzle.region)];
  const scored = cells.map((c) => [c, catchment(E, puzzle, c)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const sites = [];
  let people = 0;
  for (const [c, n] of scored) {
    if (sites.every((s) => E.hexmap.dist(s, c) >= MIN_APART)) { sites.push(c); people += Math.round(n); }
    if (sites.length === SITES) break;
  }
  return { sites, people };
}

/** Why a site can't go at `cell` given the others, or null. */
export function siteProblem(E, puzzle, sites, cell) {
  if (!Number.isInteger(cell) || !inRegionSet(E, puzzle).has(cell)) return `settlements go on land in ${regionById(puzzle.region).name}`;
  if (sites.some((s) => s !== cell && E.hexmap.dist(s, cell) < MIN_APART)) return `settlements must be at least ${MIN_APART} hexes apart`;
  return null;
}

/** Score SITES settlements: {score, people, par, each: [people]} or {error}. */
export function scoreSites(E, puzzle, sites, par = parSites(E, puzzle)) {
  if (!Array.isArray(sites) || sites.length !== SITES) return { error: `need ${SITES} settlements` };
  for (let i = 0; i < sites.length; i++) {
    const why = siteProblem(E, puzzle, sites.slice(0, i), sites[i]);
    if (why) return { error: why };
  }
  const each = sites.map((c) => Math.round(catchment(E, puzzle, c)));
  const people = each.reduce((a, b) => a + b, 0);
  return { score: par.people ? Math.round((1000 * people) / par.people) : 0, people, par: par.people, each };
}

/** "1.25 million" / "340,000" */
export const peopleText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} million` : n >= 1000 ? (Math.round(n / 1000) * 1000).toLocaleString("en-US") : String(Math.round(n)));
