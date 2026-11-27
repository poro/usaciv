// Rail Link: connect five real metros with the cheapest rail network you can find. Pure (no DOM): the browser and the
// Worker build the same puzzle and the same costs, and score the same network.
//
// Costs are Mainline's (mainline/sim/costs.js): each link between neighbouring hexes costs credits by relief, land
// cover and river crossings, and real rail (infrastructure.json) is an upgrade at about half price. A network is a set
// of links; it counts once each link however many routes share it, so junctions in the right places save money (a
// Steiner tree problem). Par is a good network found by the game itself: from each metro in turn, keep joining the
// nearest unjoined metro by its cheapest path to the network so far, and keep the cheapest result. Score =
// 1000 × (par ÷ your cost)³, so matching par scores 1000, 10% over par 751, and a better network more than 1000.
import { makeRng } from "../../shared/rng.js";
import { riverCrossings, realRail, costTable, USD_PER_CREDIT } from "../../mainline/sim/costs.js";

export const TERMINALS = 5;
export const MIN_POP = 250000;
export const NEAR_KM = [200, 700]; // the other metros' distance from the first one
export const MIN_APART_KM = 170; // between any two metros
export const MAX_EDGES = 3000;
export const MAX_SCORE = 2000; // a bound for race progress; real scores stay well under it
export { USD_PER_CREDIT };

/** The cost model over the whole map: {hexmap, table (Float32Array, cell × 6 + direction → credits or Infinity)}. */
export function linkEnv({ world, infrastructure }, hexmap) {
  const env = { world, hexmap, rivers: riverCrossings(world, hexmap), rail: realRail(infrastructure, hexmap), inRegion: (i) => i >= 0 && i < hexmap.grid.size };
  return { hexmap, table: costTable(env) };
}

/** Metros a puzzle can use: at least MIN_POP people, on a land hex you can build from. Sorted by id. */
export function linkPool(cities, L) {
  const g = L.hexmap.grid;
  const buildable = (cell) => { for (let d = 0; d < 6; d++) if (L.table[cell * 6 + d] < Infinity) return true; return false; };
  return cities.filter((c) => c.metro && c.population >= MIN_POP && c.cell >= 0 && c.cell < g.size && buildable(c.cell))
    .map((c) => ({ id: c.id, name: c.name, cell: c.cell }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The puzzle for a seed: {ids: [cityId × TERMINALS], cells: [cell × TERMINALS]}. */
export function linkPuzzle(pool, L, seed) {
  const rng = makeRng(seed);
  const km = (a, b) => L.hexmap.km(a.cell, b.cell);
  for (let tries = 0; tries < 200; tries++) {
    const first = pool[Math.floor(rng.next() * pool.length)];
    const near = pool.filter((c) => c !== first && km(c, first) >= NEAR_KM[0] && km(c, first) <= NEAR_KM[1]);
    const chosen = [first];
    while (near.length && chosen.length < TERMINALS) {
      const c = near.splice(Math.floor(rng.next() * near.length), 1)[0];
      if (chosen.every((o) => km(o, c) >= MIN_APART_KM)) chosen.push(c);
    }
    if (chosen.length < TERMINALS) continue;
    // every metro must be reachable from the first (islands, peninsulas behind open water)
    const reach = dijkstra(L, [first.cell]);
    if (!chosen.every((c) => reach.dist[c.cell] < Infinity)) continue;
    return { ids: chosen.map((c) => c.id), cells: chosen.map((c) => c.cell) };
  }
  throw new Error("linkPuzzle: no puzzle found");
}
export const dailySeed = (key) => `link:${key}`;
export const practiceSeed = (seed) => `link-practice:${seed}`;

const edgeKey = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
const round1 = (x) => Math.round(x * 10) / 10;

/** The cost of the link a–b (neighbours), or Infinity. */
export function edgeCost(L, a, b) {
  const g = L.hexmap.grid;
  for (let d = 0; d < 6; d++) if (g.neighbour(a, d) === b) return L.table[a * 6 + d];
  return Infinity;
}

/**
 * Cheapest paths from `sources` (cost 0 each). Links in `free` (a Set of edge keys) cost nothing. Stops early once
 * `target` is settled. → {dist: Float64Array, prev: Int32Array}
 */
export function dijkstra(L, sources, { free = null, target = -1 } = {}) {
  const g = L.hexmap.grid, n = g.size;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = [];
  const push = (c, d) => {
    heap.push([d, c]);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  for (const s of sources) { dist[s] = 0; push(s, 0); }
  while (heap.length) {
    const [d, c] = pop();
    if (d > dist[c]) continue;
    if (c === target) break;
    for (let k = 0; k < 6; k++) {
      const j = g.neighbour(c, k);
      if (j < 0) continue;
      const w = free?.has(edgeKey(c, j)) ? 0 : L.table[c * 6 + k];
      if (!(w < Infinity)) continue;
      const nd = d + w;
      if (nd < dist[j]) { dist[j] = nd; prev[j] = c; push(j, nd); }
    }
  }
  return { dist, prev };
}

/** The cell path ending at `to` (from its source), from dijkstra's prev array. */
export function pathTo(prev, to) {
  const out = [to];
  while (prev[out[out.length - 1]] >= 0) out.push(prev[out[out.length - 1]]);
  return out.reverse();
}

/** Par: {cost, edges: [[a, b]…]} (see the header). */
export function parNetwork(L, cells) {
  let best = null;
  for (const root of cells) {
    const tree = new Set([root]);
    const edges = [];
    let cost = 0;
    const left = new Set(cells.filter((c) => c !== root));
    while (left.size) {
      const { dist, prev } = dijkstra(L, [...tree]);
      let pick = -1;
      for (const c of left) if (pick < 0 || dist[c] < dist[pick] || (dist[c] === dist[pick] && c < pick)) pick = c;
      const p = pathTo(prev, pick);
      for (let i = 1; i < p.length; i++) { edges.push([p[i - 1], p[i]]); cost += edgeCost(L, p[i - 1], p[i]); tree.add(p[i]); }
      left.delete(pick);
    }
    cost = round1(cost);
    if (!best || cost < best.cost) best = { cost, edges };
  }
  return best;
}

/** Normalised, de-duplicated links → {edges: [[a, b]…], cost} or {error}. */
export function networkCost(L, edges) {
  if (!Array.isArray(edges) || edges.length > MAX_EDGES) return { error: `edges must be a list of at most ${MAX_EDGES} links` };
  const seen = new Set(), out = [];
  let cost = 0;
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isInteger(e[0]) || !Number.isInteger(e[1])) return { error: "each link is [cell, cell]" };
    const k = edgeKey(e[0], e[1]);
    if (seen.has(k)) continue;
    const c = e[0] >= 0 && e[1] >= 0 && e[0] < L.hexmap.grid.size && e[1] < L.hexmap.grid.size ? edgeCost(L, e[0], e[1]) : Infinity;
    if (!(c < Infinity)) return { error: "a link joins cells that are not buildable neighbours" };
    seen.add(k);
    out.push(e[0] < e[1] ? [e[0], e[1]] : [e[1], e[0]]);
    cost += c;
  }
  return { edges: out, cost: round1(cost) };
}

/** How many of the puzzle's metros sit in the same network piece as the best-connected one (1–TERMINALS). */
export function connectedCount(cells, edges) {
  const parent = new Map();
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x; };
  for (const [a, b] of edges) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const c of cells) { const r = find(c); groups.set(r, (groups.get(r) || 0) + 1); }
  return Math.max(...groups.values());
}

/** 1000 × (par ÷ cost)³: plain multiplication, so every engine rounds it the same. */
export function scoreFor(par, cost) { const r = par / cost; return Math.round(1000 * r * r * r); }

/** Score a finished network: {score, cost, par} or {error} (it must join all the metros). */
export function scoreNetwork(L, puzzle, edges, par = parNetwork(L, puzzle.cells)) {
  const n = networkCost(L, edges);
  if (n.error) return n;
  if (connectedCount(puzzle.cells, n.edges) < puzzle.cells.length) return { error: "the network must join all five metros" };
  return { score: scoreFor(par.cost, n.cost), cost: n.cost, par: par.cost };
}

/** "$6.4B" for credits. */
export const dollars = (cr) => { const usd = cr * USD_PER_CREDIT; return usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : `$${Math.round(usd / 1e6)}M`; };
