// Rail Link daily: the server rebuilds the day's puzzle and par (web/js/games/link/sim/link.js, over world.json and
// infrastructure.json with Mainline's costs) and scores the submitted network. First finished game per player per day
// (worker/daily.js).
import { makeDaily } from "./daily.js";
import { makeHexMap } from "../web/js/games/shared/hexmap.js";
import { linkEnv, linkPool, linkPuzzle, parNetwork, scoreNetwork, dailySeed } from "../web/js/games/link/sim/link.js";

const parCache = new Map(); // seed → {puzzle, par}, per isolate (a puzzle's par takes a few dozen path searches)
/** The puzzle and its par for a seed, cached. */
export function linkPuzzleFor({ L, pool }, seed) {
  let hit = parCache.get(seed);
  if (!hit) {
    const puzzle = linkPuzzle(pool, L, seed);
    hit = { L, puzzle, par: parNetwork(L, puzzle.cells) };
    if (parCache.size > 64) parCache.delete(parCache.keys().next().value);
    parCache.set(seed, hit);
  }
  return hit;
}

const daily = makeDaily({
  table: "link_daily", detail: "edges_json", data: ["world", "infrastructure", "cities"],
  build: (d) => { const L = linkEnv({ world: d.world, infrastructure: d.infrastructure }, makeHexMap(d.world)); return { L, pool: linkPool(d.cities, L) }; },
  puzzle: (base, key) => linkPuzzleFor(base, dailySeed(key)),
  score: ({ L, puzzle, par }, body) => scoreNetwork(L, puzzle, body?.edges, par),
  detailOf: (body) => body.edges,
});

/** POST /api/link/daily {key, edges: [[cell, cell]…]} → {score, rank, total} (stored: true on a resubmission). */
export const submitLinkDaily = daily.submit;
/** GET /api/link/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export const linkDailyBoard = daily.board;
export const linkBaseFor = daily.pool;
