// State Shapes: a state's outline on the 25 km hex grid (world.json `owner`), alone in the panel; which state is it?
// Pure: the browser and the Worker build the same rounds from a seed.
//
// Eight rounds a day from the states with at least MIN_HEXES hexes (the smallest New England states are a handful of
// hexes, too few to read). The first UPRIGHT rounds show the shape as on the map, the next ones upside down and the
// last two turned by any multiple of 60° (exact on a hex grid: a cube-coordinate rotation). Four choices: the answer and three decoys among the
// states closest to it in size, so the silhouette's scale gives nothing away.
import { makeRng } from "../../shared/rng.js";

export const ROUNDS = 8;
export const CHOICES = 4;
export const MIN_HEXES = 38;
export const UPRIGHT = 3;
export const FREE_TURNS = 6; // rounds UPRIGHT..FREE_TURNS-1 are upside down; later ones turn by any multiple of 60°

/** world.json → [{abbr, name, cells: [cell]}] for every state with at least MIN_HEXES hexes, by abbreviation. */
export function shapePool(world) {
  const cells = new Map();
  world.owner.forEach((o, i) => { if (o >= 0) (cells.get(o) || cells.set(o, []).get(o)).push(i); });
  return [...cells].filter(([, c]) => c.length >= MIN_HEXES)
    .map(([o, c]) => ({ abbr: world.states[o].abbr, name: world.states[o].name, cells: c }))
    .sort((a, b) => (a.abbr < b.abbr ? -1 : 1));
}

/** ROUNDS rounds from a seed: [{answer: abbr, options: [abbr × CHOICES], turn: 0–5 (× 60°)}]; eight different states. */
export function shapeRounds(pool, seed) {
  const rng = makeRng(seed);
  const left = pool.slice();
  const out = [];
  for (let k = 0; k < ROUNDS && left.length; k++) {
    const a = left.splice(Math.floor(rng.next() * left.length), 1)[0];
    const near = pool.filter((s) => s !== a).sort((x, y) => Math.abs(Math.log(x.cells.length / a.cells.length)) - Math.abs(Math.log(y.cells.length / a.cells.length)) || (x.abbr < y.abbr ? -1 : 1)).slice(0, 6);
    const opts = [a];
    while (opts.length < CHOICES) opts.push(near.splice(Math.floor(rng.next() * near.length), 1)[0]);
    for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
    const turn = k < UPRIGHT ? 0 : k < FREE_TURNS ? 3 : 1 + Math.floor(rng.next() * 5);
    out.push({ answer: a.abbr, options: opts.map((s) => s.abbr), turn });
  }
  return out;
}
export const dailySeed = (key) => `shapes:${key}`;
export const practiceSeed = (seed) => `shapes-practice:${seed}`;

/**
 * The shape's hex centres, turned by `turn` × 60° and scaled to unit hex size: [[x, y]…] with the bounding box at the
 * origin, plus {w, h}. Pointy-top hexes ("odd-r" rows, like the map): a hex's corners are at ±√3/2 in x and ±1 in y
 * around its centre.
 */
export function silhouette(cells, cols, turn = 0) {
  const S3 = Math.sqrt(3);
  const pts = cells.map((i) => {
    const r = (i / cols) | 0, c = i % cols;
    let x = c - ((r - (r & 1)) >> 1), z = r, y = -x - z; // cube (x, y, z) with z = row
    for (let t = 0; t < ((turn % 6) + 6) % 6; t++) [x, y, z] = [-z, -x, -y];
    return [S3 * (x + z / 2), 1.5 * z];
  });
  const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
  const x1 = Math.max(...pts.map((p) => p[0])), y1 = Math.max(...pts.map((p) => p[1]));
  return { pts: pts.map(([x, y]) => [x - x0 + S3 / 2, y - y0 + 1]), w: x1 - x0 + S3, h: y1 - y0 + 2 };
}

/** Score picks (abbreviations, in round order; `partial` allows 1–ROUNDS for races). → {score, results: [bool]} or {error}. */
export function scoreShapes(rounds, picks, { partial = false } = {}) {
  if (!Array.isArray(picks) || (partial ? picks.length < 1 || picks.length > rounds.length : picks.length !== rounds.length)) {
    return { error: partial ? `picks must be 1–${rounds.length} states` : `need ${rounds.length} picks` };
  }
  const results = [];
  for (let i = 0; i < picks.length; i++) {
    if (typeof picks[i] !== "string" || !rounds[i].options.includes(picks[i])) return { error: `pick ${i + 1} is not one of the choices` };
    results.push(picks[i] === rounds[i].answer);
  }
  return { score: results.filter(Boolean).length, results };
}
