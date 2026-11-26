// Train animation for Mainline: pure geometry (no DOM, no sim state, no randomness). view.js draws the markers on a
// world overlay while the game is open; nothing here is ever drawn into the cached map or the share image.
//
//   buildRoutes({served, links, express, cx, cy, minGap}) → [route]   once per network change (world km, not pixels)
//   trainsAt(route, tSec) → [{x, y, a}]                               every frame: where route's trains are at time t
//
// A route is one served contract's network path, as a polyline through hex centres: {id, pts: [x0, y0, x1, y1, …],
// cum: [0, d1, …] (km along it), len, n (trains), speed (km a second), express, phase}. Busier contracts (more pay)
// run more trains, express services one more and faster. A route with a missing or damaged link is skipped: evaluate()
// already routes only over intact track, so a cut contract is not served and shows no trains.

export const TRAIN_SPEED = 70; // km a second on the map (a 350 km Texas route takes 5 s)
export const EXPRESS_SPEED = 130;
export const MAX_TRAINS = 4; // per route, before the express one
export const PAY_PER_TRAIN = 4; // cr a year of contract pay per extra train

/** A stable 0..1 phase from a contract id, so routes do not all start their trains at the same moment. */
export function phaseOf(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/** How many trains a route runs: 1 + one per PAY_PER_TRAIN cr of pay (at most MAX_TRAINS), +1 for an express. */
export function trainCount(pay, express = false) {
  const base = Math.min(MAX_TRAINS, 1 + Math.floor(Math.max(0, pay) / PAY_PER_TRAIN));
  return base + (express ? 1 : 0);
}

/**
 * Cell sequence of a served route: start at sv.from and follow sv.keys (edge keys in path order). Null if a link is
 * missing, damaged, or does not join the previous cell (a stale route).
 */
export function routeCells(sv, links) {
  if (!sv || !sv.keys?.length || sv.from == null) return null;
  const cells = [sv.from];
  let cur = sv.from;
  for (const k of sv.keys) {
    const l = links[k];
    if (!l || l.d) return null;
    const next = l.a === cur ? l.b : l.b === cur ? l.a : null;
    if (next == null) return null;
    cells.push(next);
    cur = next;
  }
  return cells;
}

/**
 * Polylines (world km) for every served contract. served: Map<id, {pay, from, keys}> from evaluate; links:
 * state.links; express: state.express ({id: year}); cx, cy: hex centre of a cell; minGap: the closest two trains on
 * one route may run (km), so a short route is not crowded.
 */
export function buildRoutes({ served, links, express = {}, cx, cy, minGap = 0 }) {
  const out = [];
  for (const [id, sv] of served || []) {
    const cells = routeCells(sv, links);
    if (!cells || cells.length < 2) continue;
    const pts = new Array(cells.length * 2);
    const cum = new Array(cells.length);
    let len = 0;
    for (let i = 0; i < cells.length; i++) {
      const x = cx(cells[i]), y = cy(cells[i]);
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      if (i) len += Math.hypot(x - pts[i * 2 - 2], y - pts[i * 2 - 1]);
      cum[i] = len;
    }
    if (!(len > 0)) continue;
    const xp = !!express[id];
    let n = trainCount(sv.pay, xp);
    if (minGap > 0) n = Math.max(1, Math.min(n, Math.floor(len / minGap)));
    out.push({ id, pts, cum, len, n, express: xp, speed: xp ? EXPRESS_SPEED : TRAIN_SPEED, phase: phaseOf(id) });
  }
  return out;
}

/** Point and heading (radians) at distance d (km) along a route, clamped to its ends. */
export function pointAt(route, d) {
  const { pts, cum, len } = route;
  const last = cum.length - 1;
  if (d <= 0) return { x: pts[0], y: pts[1], a: Math.atan2(pts[3] - pts[1], pts[2] - pts[0]) };
  if (d >= len) return { x: pts[last * 2], y: pts[last * 2 + 1], a: Math.atan2(pts[last * 2 + 1] - pts[last * 2 - 1], pts[last * 2] - pts[last * 2 - 2]) };
  // binary search for the segment [cum[i], cum[i + 1]] holding d
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (d - cum[lo]) / seg : 0;
  const x0 = pts[lo * 2], y0 = pts[lo * 2 + 1], x1 = pts[hi * 2], y1 = pts[hi * 2 + 1];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, a: Math.atan2(y1 - y0, x1 - x0) };
}

/**
 * Where a route's trains are at time t (seconds): n trains spread evenly round the out-and-back loop, each running
 * end to end at route.speed and turning back, so about half of them head each way at any moment. a = heading.
 */
export function trainsAt(route, t) {
  const out = [];
  const trip = route.len / route.speed; // seconds one way
  if (!(trip > 0)) return out;
  for (let k = 0; k < route.n; k++) {
    let u = (t / (2 * trip) + route.phase + k / route.n) % 1; // 0..1 round the out-and-back loop
    if (u < 0) u += 1;
    const out1 = u < 0.5;
    const f = out1 ? u * 2 : 2 - u * 2; // 0..1 along the route
    const p = pointAt(route, f * route.len);
    out.push({ x: p.x, y: p.y, a: out1 ? p.a : p.a + Math.PI });
  }
  return out;
}
