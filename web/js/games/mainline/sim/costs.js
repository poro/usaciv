// Build costs for freight rail links between neighbouring hexes. Pure (no DOM).
//
// Money: the company keeps its books in credits (cr). One credit stands for about $25 million of construction
// spending (USD_PER_CREDIT), so a link across one 43 km hex of flat open country costs 5 cr (about $125M, roughly
// $3M per km). Contract revenue is a log-scaled share of the real freight value (see contracts.js), so the biggest
// flows do not dwarf the rest. Tooltips always show the dollar figure next to the credits.

export const USD_PER_CREDIT = 20e6;
export const BASE_LINK = 8; // cr for a flat, open-country link

// Relief: 0 flat, 1 hills, 2 mountains, 3 peaks (world.json relief)
export const RELIEF_MULT = [1, 1.7, 3, 5];
export const RELIEF_NAME = ["flat", "hills", "mountains", "peaks"];
// Cover ids (world.json): 1-3 forest, 8 wetland, 9 urban, 10 barren, 11 ice
export function coverMult(cover) {
  if (cover === 8) return 1.5; // wetland: fill, drainage, permits
  if (cover === 9) return 1.8; // urban: right of way
  if (cover >= 1 && cover <= 3) return 1.15; // forest: clearing
  if (cover === 10 || cover === 11) return 1.3;
  return 1;
}
export const BRIDGE_MULT = 4; // a coastal or lake hex: causeway / long bridge
export const RIVER_COST = [0, 6, 6, 3.5, 3.5, 2, 1.5]; // by world.json river rank (1 = largest)
export const RAIL_DISCOUNT = [0.45, 0.55]; // real rail (infrastructure.json tier 0 main, 1 secondary): upgrade, not build

/** Per-hex factor: Infinity where you cannot build (ocean, foreign land, outside the map). */
export function cellFactor(world, i) {
  const own = world.owner[i];
  if (own >= 0) return RELIEF_MULT[world.relief[i]] * coverMult(world.cover[i]);
  if (own === -1 && (world.water[i] === 2 || world.water[i] === 3)) return BRIDGE_MULT;
  return Infinity;
}

/** Segment intersection test (proper or touching). */
function segHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Edges (neighbouring cell pairs) a world.json river crosses: the river line cuts the segment between the two hex
 * centres. → Map<edgeKey, {rank, name}> (the largest river wins).
 */
export function riverCrossings(world, hexmap) {
  const g = hexmap.grid;
  const out = new Map();
  for (const rv of world.rivers || []) {
    const p = rv.pts;
    for (let k = 2; k + 1 < p.length; k += 2) {
      const x0 = p[k - 2], y0 = p[k - 1], x1 = p[k], y1 = p[k + 1];
      const len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)); // sqrt, not hypot: sqrt is exactly rounded in every engine
      const steps = Math.max(1, Math.ceil(len / 10));
      const cand = new Set();
      for (let s = 0; s <= steps; s++) {
        const c = g.cellAt(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
        if (c < 0) continue;
        cand.add(c);
        for (const n of hexmap.neighbours(c)) cand.add(n);
      }
      for (const c of cand) {
        for (const n of hexmap.neighbours(c)) {
          if (n < c) continue;
          if (!segHit(g.cx(c), g.cy(c), g.cx(n), g.cy(n), x0, y0, x1, y1)) continue;
          const key = hexmap.edgeKey(c, n);
          const prev = out.get(key);
          if (!prev || rv.rank < prev.rank) out.set(key, { rank: rv.rank, name: rv.name });
        }
      }
    }
  }
  return out;
}

/** Real rail links from infrastructure.json → Map<edgeKey, tier>. */
export function realRail(infrastructure, hexmap) {
  const out = new Map();
  for (const [a, b, tier] of infrastructure?.rail || []) {
    const key = hexmap.edgeKey(a, b);
    if (!out.has(key) || tier < out.get(key)) out.set(key, tier);
  }
  return out;
}

/**
 * Cost of the link a–b in credits (rounded to 0.1), or Infinity. `inRegion(cell)` limits building to the scenario's
 * region. Returns {cost, parts} when detail is true (for tooltips).
 */
export function linkCost(env, a, b, detail = false) {
  const { world, hexmap } = env;
  if (!env.inRegion(a) || !env.inRegion(b)) return detail ? { cost: Infinity, why: "outside the region" } : Infinity;
  const fa = cellFactor(world, a), fb = cellFactor(world, b);
  if (!(fa < Infinity) || !(fb < Infinity)) return detail ? { cost: Infinity, why: "open ocean or foreign land" } : Infinity;
  if (world.owner[a] < 0 && world.owner[b] < 0 && world.water[a] !== 3 && world.water[b] !== 3) {
    // two coastal-water hexes in a row: open sea, not a causeway
    return detail ? { cost: Infinity, why: "open water" } : Infinity;
  }
  const key = hexmap.edgeKey(a, b);
  const river = env.rivers.get(key) || null;
  const rail = env.rail.has(key) ? env.rail.get(key) : null;
  let cost = (BASE_LINK * (fa + fb)) / 2 + (river ? RIVER_COST[river.rank] || 1.5 : 0);
  if (rail != null) cost *= RAIL_DISCOUNT[rail] ?? 0.35;
  cost = Math.max(0.5, Math.round(cost * 10) / 10);
  if (!detail) return cost;
  return { cost, terrain: [a, b].map((c) => describeCell(world, c)), river, rail };
}

export function describeCell(world, c) {
  if (world.owner[c] < 0) return world.water[c] === 3 ? "lake" : "coastal water";
  const cover = world.tables?.cover?.find((t) => t.id === world.cover[c]);
  return `${RELIEF_NAME[world.relief[c]]}${cover && cover.id ? `, ${cover.name.toLowerCase()}` : ""}`;
}

/** Precompute every link cost into a Float32Array indexed cell * 6 + direction (Infinity = forbidden). */
export function costTable(env) {
  const { hexmap } = env;
  const g = hexmap.grid;
  const t = new Float32Array(g.size * 6).fill(Infinity);
  for (let i = 0; i < g.size; i++) {
    if (!env.inRegion(i)) continue;
    for (let d = 0; d < 6; d++) {
      const j = g.neighbour(i, d);
      if (j >= 0) t[i * 6 + d] = linkCost(env, i, j);
    }
  }
  return t;
}
