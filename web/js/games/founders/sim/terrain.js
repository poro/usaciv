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
//
// Rivers come as map-km polylines (world.json rivers); a hex counts as "on" a river when a point sampled every
// ~6 km along it falls inside the hex.

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

  const pct = world.pct;
  const wet = new Uint8Array(size);
  for (const i of landCells) if ((pct.wetland[i] || 0) >= 40 || world.cover[i] === COVER.WETLAND) wet[i] = 1;

  const typeName = new Map((resources?.types || []).map((t) => [t.id, t.name]));
  return {
    grid, size, land, landCells, river, riverName, coast, lake, sites, wet, typeName,
    relief: world.relief, cover: world.cover, pct, elev: world.elev, water: world.water, owner: world.owner,
    county: world.county, states: world.states, counties: world.counties, coverTable: world.tables?.cover || [],
  };
}
