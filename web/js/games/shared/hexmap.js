// Hex-map helpers for game logic. Pure: works in the browser (makeHexMap(app.data.world)) and in Node tests
// (makeHexMap(worldJson) or a small fixture {grid: {radius, cols, rows}, owner: [...] , ...}).
// Cells are indices into world.json arrays (row-major, "odd-r" pointy-top layout; see web/js/hex.js).
import { makeGrid } from "../../hex.js";

export const WATER = -1;
export const FOREIGN = -2;

export function makeHexMap(world) {
  const grid = makeGrid(world.grid);
  const { cols, size } = grid;
  const owner = world.owner;

  const isLand = (i) => i >= 0 && i < size && owner[i] >= 0; // US land
  const neighbours = (i) => {
    const out = [];
    for (let d = 0; d < 6; d++) {
      const j = grid.neighbour(i, d);
      if (j >= 0) out.push(j);
    }
    return out;
  };
  // offset (odd-r) → cube coordinates, for distances
  const cube = (i) => {
    const c = i % cols, r = (i / cols) | 0;
    const x = c - ((r - (r & 1)) >> 1);
    return [x, r, -x - r];
  };
  /** Distance in hex steps. */
  const dist = (a, b) => {
    const [ax, ay, az] = cube(a), [bx, by, bz] = cube(b);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
  };
  /** Distance between cell centres in km (each step is about grid.W = 43 km). */
  const km = (a, b) => Math.hypot(grid.cx(a) - grid.cx(b), grid.cy(a) - grid.cy(b));
  /** Every cell within r steps of i (including i), optionally filtered. */
  const within = (i, r, keep = null) => {
    const seen = new Set([i]);
    let ring = [i];
    for (let k = 0; k < r; k++) {
      const next = [];
      for (const c of ring) for (const n of neighbours(c)) if (!seen.has(n)) { seen.add(n); next.push(n); }
      ring = next;
    }
    const out = [...seen];
    return keep ? out.filter(keep) : out;
  };

  /**
   * Cheapest path from a to b. cost(from, to) → step cost (> 0) or Infinity to forbid. minStep is a lower bound on
   * any step's cost (keeps the A* heuristic admissible; 0 = plain Dijkstra). Returns {path: [a, …, b], cost} or null.
   */
  function path(a, b, cost, { minStep = 0, maxCost = Infinity } = {}) {
    if (a === b) return { path: [a], cost: 0 };
    const g = new Map([[a, 0]]);
    const from = new Map();
    const heap = new MinHeap();
    heap.push(a, minStep * dist(a, b));
    const closed = new Set();
    while (heap.size) {
      const cur = heap.pop();
      if (cur === b) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      const gc = g.get(cur);
      for (const n of neighbours(cur)) {
        if (closed.has(n)) continue;
        const step = cost(cur, n);
        if (!(step < Infinity)) continue;
        const gn = gc + step;
        if (gn > maxCost) continue;
        if (gn < (g.get(n) ?? Infinity)) {
          g.set(n, gn);
          from.set(n, cur);
          heap.push(n, gn + minStep * dist(n, b));
        }
      }
    }
    if (!g.has(b)) return null;
    const out = [b];
    while (out[out.length - 1] !== a) out.push(from.get(out[out.length - 1]));
    return { path: out.reverse(), cost: g.get(b) };
  }

  /** Cells reachable from `start` through cells where pass(cell) is true (flood fill). */
  function component(start, pass) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const c = stack.pop();
      for (const n of neighbours(c)) if (!seen.has(n) && pass(n)) { seen.add(n); stack.push(n); }
    }
    return seen;
  }

  /** Canonical key for the edge between two neighbouring cells (order-independent). */
  const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  return { grid, world, size, isLand, neighbours, dist, km, within, path, component, edgeKey, cube };
}

/** Small binary min-heap of (item, priority). */
export class MinHeap {
  constructor() { this.items = []; this.pri = []; }
  get size() { return this.items.length; }
  push(item, p) {
    const it = this.items, pr = this.pri;
    it.push(item); pr.push(p);
    let k = it.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (pr[up] <= pr[k]) break;
      [it[up], it[k]] = [it[k], it[up]];
      [pr[up], pr[k]] = [pr[k], pr[up]];
      k = up;
    }
  }
  pop() {
    const it = this.items, pr = this.pri;
    const top = it[0];
    const lastI = it.pop(), lastP = pr.pop();
    if (it.length) {
      it[0] = lastI; pr[0] = lastP;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < it.length && pr[l] < pr[m]) m = l;
        if (r < it.length && pr[r] < pr[m]) m = r;
        if (m === k) break;
        [it[m], it[k]] = [it[k], it[m]];
        [pr[m], pr[k]] = [pr[k], pr[m]];
        k = m;
      }
    }
    return top;
  }
}
