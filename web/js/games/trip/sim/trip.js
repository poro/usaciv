// Road Trip: visit six real metros and come home by the shortest loop. Pure (no DOM): the browser and the Worker
// build the same trip from a seed and score an order the same way.
//
// A trip = a start metro and STOPS other metros from the largest POOL_SIZE, all within RADIUS_KM of the start (a
// regional loop, not a cross-country one) and at least MIN_APART_KM from each other. Distances are straight lines
// between metro centres in km (exact sqrt, so engines agree). The best loop is found by trying every order
// (6! = 720). Score = round(1000 × (best ÷ yours)⁴): 1000 is a perfect loop, 10% longer scores 683, 25% longer 410.
import { makeRng } from "../../shared/rng.js";

export const STOPS = 6;
export const POOL_SIZE = 150;
export const RADIUS_KM = 900;
export const MIN_APART_KM = 90;
export const MAX_POINTS = 1000;

export function tripPool(cities) {
  return cities.filter((c) => c.metro && Number.isFinite(c.x) && Number.isFinite(c.y))
    .sort((a, b) => b.population - a.population || (a.id < b.id ? -1 : 1)).slice(0, POOL_SIZE)
    .map((c) => ({ id: c.id, name: c.name, states: c.states, x: c.x, y: c.y, cell: c.cell, footprint: c.footprint || [c.cell] }));
}

export const km = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };

/** The loop length of start → order… → start. */
export function loopKm(start, stops) {
  let s = 0, prev = start;
  for (const p of stops) { s += km(prev, p); prev = p; }
  return s + km(prev, start);
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => { for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

/** The shortest loop: {order: [stop ids], km}. Ties go to the lexically first order. */
export function bestLoop(start, stops) {
  let best = null;
  for (const p of permutations(stops)) {
    const d = loopKm(start, p);
    if (!best || d < best.km - 1e-9) best = { order: p.map((s) => s.id), km: d };
  }
  return best;
}

/** A trip from a seed: {start, stops (in a shuffled display order), best: {order, km}}. */
export function tripFor(pool, seed) {
  const rng = makeRng(seed);
  for (let attempt = 0; attempt < 200; attempt++) {
    const start = pool[Math.floor(rng.next() * pool.length)];
    const near = pool.filter((c) => c.id !== start.id && km(c, start) <= RADIUS_KM && km(c, start) >= MIN_APART_KM);
    if (near.length < STOPS + 2) continue;
    const stops = [];
    const cands = near.slice();
    while (stops.length < STOPS && cands.length) {
      const c = cands.splice(Math.floor(rng.next() * cands.length), 1)[0];
      if (stops.every((s) => km(s, c) >= MIN_APART_KM)) stops.push(c);
    }
    if (stops.length < STOPS) continue;
    return { start, stops, best: bestLoop(start, stops) };
  }
  throw new Error("no trip found");
}
export const dailySeed = (key) => `trip:${key}`;

/** Score an order (stop ids). → {km, best, points} or {error}. */
export function scoreTrip(trip, order) {
  if (!Array.isArray(order) || order.length !== trip.stops.length) return { error: `visit all ${trip.stops.length} stops` };
  const byId = new Map(trip.stops.map((s) => [s.id, s]));
  if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) return { error: "each stop exactly once" };
  const d = loopKm(trip.start, order.map((id) => byId.get(id)));
  const r = trip.best.km / d; // ≤ 1; its 4th power (plain multiplication: every engine agrees) spreads the scores
  return { km: Math.round(d), best: Math.round(trip.best.km), points: Math.min(MAX_POINTS, Math.round(MAX_POINTS * r * r * r * r)) };
}
