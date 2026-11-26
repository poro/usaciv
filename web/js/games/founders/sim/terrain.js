// Founders: per-hex facts from the real data, computed once (pure, no DOM).
//
//   buildTerrain(world, resources) → T
//     T.size, T.land[i] (US land), T.relief, T.cover, T.pct, T.elev
//     T.river[i]      best (lowest) rank of a river crossing the hex, 0 = none
//     T.riverName[i]  that river's name, or null
//     T.coast[i]      1 if the hex touches ocean or coastal water
//     T.lake[i]       1 if the hex touches a lake
//     T.sites[i]      resource sites in the hex that feed Materials ([{type, name, kind: "mine"|"oilgas"|"power"}])
//     T.wet[i]        1 if wetland is 40%+ of the hex (or wetland is the dominant cover): slow going
//     T.landCells     every US land cell, ascending
//     T.pct           OPEN-LAND shares (see openLand below): developed land is given back to the open land around it
//     T.realPct       world.json pct as it is (developed share included), for anything that compares with today
//     T.openCover[i]  the land cover a hex would have without its city (urban hexes only differ from T.cover)
//
// Rivers come as map-km polylines (world.json rivers); a hex counts as "on" a river when a point sampled every
// ~6 km along it falls inside the hex.

// Open land: this is an empty country, so a hex that is built up today must read (and yield) like the land around
// it, or its plainness gives the real city away. openLand(world) returns new pct arrays where a hex's developed share
// (10%+ only) is handed out over the six open classes: mostly by the hex's own open mix when it has plenty, mostly by
// the open mix of its neighbours (ring 1 counts double ring 2; built-up neighbours are skipped) when it has little.
export const OPEN_KEYS = ["forest", "crop", "pasture", "grass", "shrub", "wetland"];
const OPEN_MIN_DEV = 10; // below this, a hex keeps its shares exactly
const OPEN_OWN_K = 40; // own open land worth this many points of neighbour evidence
const OPEN_URBAN_DEV = 30; // neighbours at least this built up are not used as evidence

export const COVER = { FOREST_D: 1, FOREST_E: 2, FOREST_M: 3, SCRUB: 4, GRASS: 5, PASTURE: 6, CROP: 7, WETLAND: 8, URBAN: 9, BARREN: 10, ICE: 11 };
export const RELIEF = { FLAT: 0, HILLS: 1, MOUNTAINS: 2, PEAKS: 3 };
export const RELIEF_NAME = ["flat", "hills", "mountains", "peaks"];

const MINE_TYPES = new Set(["coal_mine", "gold", "copper", "iron", "silver", "platinum", "molybdenum", "lead_zinc", "rare_earths", "uranium"]);
const OILGAS_TYPES = new Set(["oil", "gas"]);
// Natural power sites (falling water, hot rock). Plants built by people (nuclear, coal, gas, wind, solar) are left
// out: this is an empty country.
const POWER_TYPES = new Set(["hydro", "geothermal"]);

/** Point → cell on the odd-r pointy-top grid (same maths as web/js/hex.js cellAt). */
function cellAt(grid, x, y) {
  const R = grid.radius, cols = grid.cols, rows = grid.rows;
  const SQRT3 = Math.sqrt(3);
  const q = ((SQRT3 / 3) * x - y / 3) / R;
  const r = ((2 / 3) * y) / R;
  let rx = Math.round(q), rz = Math.round(r);
  const ry = Math.round(-q - r);
  const dx = Math.abs(rx - q), dy = Math.abs(ry - (-q - r)), dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy <= dz) rz = -rx - ry;
  const row = rz, col = rx + ((row - (row & 1)) >> 1);
  return col < 0 || row < 0 || col >= cols || row >= rows ? -1 : row * cols + col;
}

/** Neighbours on the odd-r grid. */
const NB = [
  [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]],
  [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]],
];
export function neighbourCells(grid, i) {
  const cols = grid.cols, rows = grid.rows;
  const c = i % cols, r = (i / cols) | 0;
  const out = [];
  for (const [dc, dr] of NB[r & 1]) {
    const nc = c + dc, nr = r + dr;
    if (nc >= 0 && nr >= 0 && nc < cols && nr < rows) out.push(nr * cols + nc);
  }
  return out;
}

/**
 * openLand(world) → {pct: {forest, crop, pasture, grass, shrub, wetland: Uint8Array}, cover: Uint8Array}
 * pct: the shares with developed land redistributed (rounded, never above 100 in total); cover: the cover with every
 * urban hex (9) replaced by the open class it would have (its forest type from forested neighbours, else mixed).
 * Pure and deterministic.
 */
export function openLand(world) {
  const grid = world.grid;
  const size = grid.cols * grid.rows;
  const src = world.pct, dev = src.developed || new Uint8Array(size);
  const pct = {};
  for (const k of OPEN_KEYS) pct[k] = Uint8Array.from(src[k] || new Uint8Array(size));
  const cover = Uint8Array.from(world.cover);
  const isLand = (i) => world.owner[i] >= 0 && !world.water[i];
  for (let i = 0; i < size; i++) {
    if (!isLand(i)) continue;
    const d = dev[i] || 0;
    if (d < OPEN_MIN_DEV && world.cover[i] !== COVER.URBAN) continue;
    // Own open mix.
    const own = OPEN_KEYS.map((k) => src[k]?.[i] || 0);
    const ownTot = own.reduce((a, b) => a + b, 0);
    // Neighbours' open mix (each neighbour normalised, so a half-water hex counts as much as a dry one).
    const nb = OPEN_KEYS.map(() => 0);
    let nbW = 0;
    const ring1 = neighbourCells(grid, i);
    const seen = new Set([i, ...ring1]);
    const ring2 = [];
    for (const j of ring1) for (const k of neighbourCells(grid, j)) if (!seen.has(k)) { seen.add(k); ring2.push(k); }
    const add = (j, wgt) => {
      if (!isLand(j) || (dev[j] || 0) >= OPEN_URBAN_DEV) return;
      let t = 0;
      for (const k of OPEN_KEYS) t += src[k]?.[j] || 0;
      if (t <= 0) return;
      OPEN_KEYS.forEach((k, n) => { nb[n] += (wgt * (src[k]?.[j] || 0)) / t; });
      nbW += wgt;
    };
    for (const j of ring1) add(j, 2);
    for (const j of ring2) add(j, 1);
    const wb = nbW > 0 ? OPEN_OWN_K : 0;
    const mix = OPEN_KEYS.map((_, n) => {
      if (ownTot + wb <= 0) return OPEN_KEYS[n] === "grass" ? 1 : 0; // nothing known at all: grassland
      const o = ownTot > 0 ? own[n] / ownTot : 0, b = nbW > 0 ? nb[n] / nbW : 0;
      return (o * ownTot + b * wb) / (ownTot + wb);
    });
    if (d >= OPEN_MIN_DEV) {
      let tot = 0;
      OPEN_KEYS.forEach((k, n) => {
        const v = Math.round(own[n] + d * mix[n]);
        pct[k][i] = Math.min(100 - tot, v);
        tot += pct[k][i];
      });
    }
    if (world.cover[i] === COVER.URBAN) {
      // Dominant open class (ties: the order of OPEN_KEYS).
      let best = 0;
      for (let n = 1; n < OPEN_KEYS.length; n++) if (pct[OPEN_KEYS[n]][i] > pct[OPEN_KEYS[best]][i]) best = n;
      const key = OPEN_KEYS[best];
      if (key === "forest") {
        const votes = [0, 0, 0, 0];
        for (const j of ring1) if (world.cover[j] >= 1 && world.cover[j] <= 3) votes[world.cover[j]]++;
        let f = COVER.FOREST_M;
        for (const c of [1, 2, 3]) if (votes[c] > votes[f]) f = c;
        cover[i] = f;
      } else cover[i] = { crop: COVER.CROP, pasture: COVER.PASTURE, grass: COVER.GRASS, shrub: COVER.SCRUB, wetland: COVER.WETLAND }[key];
    }
  }
  return { pct, cover };
}

export function buildTerrain(world, resources = null) {
  const grid = world.grid;
  const size = grid.cols * grid.rows;
  const land = new Uint8Array(size);
  const landCells = [];
  for (let i = 0; i < size; i++) if (world.owner[i] >= 0) { land[i] = 1; landCells.push(i); }

  // Rivers
  const river = new Uint8Array(size);
  const riverName = new Array(size).fill(null);
  for (const rv of world.rivers || []) {
    const rank = Math.max(1, Math.min(9, rv.rank || 9));
    const p = rv.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const x0 = p[k], y0 = p[k + 1], x1 = p[k + 2], y1 = p[k + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
      for (let s = 0; s <= n; s++) {
        const c = cellAt(grid, x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n);
        if (c < 0 || !land[c]) continue;
        if (!river[c] || rank < river[c]) { river[c] = rank; riverName[c] = rv.name; }
      }
    }
  }

  // Coast and lakes
  const coast = new Uint8Array(size), lake = new Uint8Array(size);
  for (const i of landCells) {
    for (const j of neighbourCells(grid, i)) {
      const wt = world.water[j];
      if (wt === 1 || wt === 2) coast[i] = 1;
      else if (wt === 3) lake[i] = 1;
    }
  }

  // Resource sites
  const sites = new Array(size).fill(null);
  for (const it of resources?.items || []) {
    const c = it.cell;
    if (!(c >= 0 && c < size) || !land[c]) continue;
    const kind = MINE_TYPES.has(it.type) ? "mine" : OILGAS_TYPES.has(it.type) ? "oilgas" : POWER_TYPES.has(it.type) ? "power" : null;
    if (!kind) continue;
    (sites[c] ||= []).push({ type: it.type, name: it.name || it.type, kind });
  }

  const open = openLand(world);
  const pct = open.pct;
  const wet = new Uint8Array(size);
  for (const i of landCells) if ((pct.wetland[i] || 0) >= 40 || world.cover[i] === COVER.WETLAND) wet[i] = 1;

  const typeName = new Map((resources?.types || []).map((t) => [t.id, t.name]));
  return {
    grid, size, land, landCells, river, riverName, coast, lake, sites, wet, typeName,
    relief: world.relief, cover: world.cover, openCover: open.cover, pct, realPct: world.pct, elev: world.elev, water: world.water, owner: world.owner,
    county: world.county, states: world.states, counties: world.counties, coverTable: world.tables?.cover || [],
  };
}
